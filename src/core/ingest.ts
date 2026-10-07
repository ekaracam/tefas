import type { Logger } from '../logger.js';
import type { FundRepository } from '../db/repository.js';
import type { TefasClient } from '../tefas/client.js';
import { TefasError } from '../tefas/errors.js';
import { mapRows } from '../tefas/mapper.js';
import type { DateRange, FetchStatus, FundType } from '../types.js';
import { compareIso, maxIso, monthlyChunks, subtractYears, todayIso } from '../util/dates.js';

export interface IngestDeps {
  readonly client: TefasClient;
  readonly repository: FundRepository;
  readonly logger: Logger;
}

export interface IngestSummary {
  readonly fundType: FundType;
  readonly chunksTotal: number;
  readonly chunksSucceeded: number;
  readonly chunksEmpty: number;
  readonly chunksSkipped: number;
  readonly chunksFailed: number;
  readonly rowsFetched: number;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsUnchanged: number;
  readonly failedRanges: readonly DateRange[];
}

const emptySummary = (fundType: FundType): IngestSummary => ({
  fundType,
  chunksTotal: 0,
  chunksSucceeded: 0,
  chunksEmpty: 0,
  chunksSkipped: 0,
  chunksFailed: 0,
  rowsFetched: 0,
  rowsInserted: 0,
  rowsUpdated: 0,
  rowsUnchanged: 0,
  failedRanges: [],
});

/**
 * TEFAS refuses a start date older than five years to the day. The floor moves
 * every night, so it is computed per run rather than stored.
 */
export const earliestAllowedStart = (historyYears: number): string =>
  subtractYears(todayIso(), Math.min(historyYears, 5));

const describe = (range: DateRange): string => `${range.start}..${range.end}`;

interface ChunkOutcome {
  readonly status: FetchStatus;
  readonly rowsFetched: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly attempts: number;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

const ingestChunk = async (
  deps: IngestDeps,
  fundType: FundType,
  range: DateRange,
): Promise<ChunkOutcome> => {
  const { client, repository, logger } = deps;
  const startedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);

  let effectiveRange = range;
  let attempts = 0;

  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const result = await client.fetchRange(fundType, effectiveRange);
      attempts += result.attempts;

      if (result.empty || result.rows.length === 0) {
        logger.info('Bu dönemde veri yok', { fonTuru: fundType, donem: describe(effectiveRange) });
        const outcome: ChunkOutcome = {
          status: 'empty',
          rowsFetched: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          attempts,
          errorKind: null,
          errorMessage: null,
        };
        repository.recordFetch(
          { fundType, range, status: 'empty', rowCount: 0, attempts, errorKind: null, errorMessage: null },
          startedAt,
        );
        return outcome;
      }

      const { records, skipped } = mapRows(fundType, result.rows);
      if (skipped > 0) {
        logger.warn('Kullanılamayan satırlar atlandı', { fonTuru: fundType, donem: describe(effectiveRange), atlanan: skipped });
      }

      const written = repository.upsertRecords(records);
      logger.info('Dönem kaydedildi', {
        fonTuru: fundType,
        donem: describe(effectiveRange),
        cekilen: records.length,
        yeni: written.inserted,
        guncellenen: written.updated,
        degismeyen: written.unchanged,
      });

      repository.recordFetch(
        {
          fundType,
          range,
          status: 'success',
          rowCount: records.length,
          attempts,
          errorKind: null,
          errorMessage: null,
        },
        startedAt,
      );

      return {
        status: 'success',
        rowsFetched: records.length,
        inserted: written.inserted,
        updated: written.updated,
        unchanged: written.unchanged,
        attempts,
        errorKind: null,
        errorMessage: null,
      };
    } catch (cause) {
      const error = cause instanceof TefasError ? cause : new TefasError('unknown', String(cause), false);
      attempts += 1;

      // The five-year floor slides forward daily; a chunk planned minutes ago can
      // fall off it mid-run. Clamp once and retry instead of failing the chunk.
      const floor = earliestAllowedStart(5);
      if (error.kind === 'range-too-old' && pass === 0 && compareIso(effectiveRange.start, floor) < 0) {
        const clamped = { start: floor, end: effectiveRange.end };
        if (compareIso(clamped.start, clamped.end) <= 0) {
          logger.warn('Dönem 5 yıl sınırına kırpıldı', {
            fonTuru: fundType,
            eski: describe(effectiveRange),
            yeni: describe(clamped),
          });
          effectiveRange = clamped;
          continue;
        }
      }

      logger.error('Dönem başarısız', {
        fonTuru: fundType,
        donem: describe(effectiveRange),
        tur: error.kind,
        sebep: error.message,
      });
      repository.recordFetch(
        {
          fundType,
          range,
          status: 'failed',
          rowCount: 0,
          attempts,
          errorKind: error.kind,
          errorMessage: error.message,
        },
        startedAt,
      );
      return {
        status: 'failed',
        rowsFetched: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        attempts,
        errorKind: error.kind,
        errorMessage: error.message,
      };
    }
  }

  throw new Error('unreachable');
};

export interface RunOptions {
  /** Re-fetch ranges the fetch_log already marks as done. */
  readonly force?: boolean;
}

export const ingestRanges = async (
  deps: IngestDeps,
  fundType: FundType,
  ranges: readonly DateRange[],
  options: RunOptions = {},
): Promise<IngestSummary> => {
  const completed = options.force === true ? new Set<string>() : deps.repository.getCompletedRanges(fundType);
  const failedRanges: DateRange[] = [];

  let summary = { ...emptySummary(fundType), chunksTotal: ranges.length };

  for (const [index, range] of ranges.entries()) {
    if (completed.has(describe(range))) {
      summary = { ...summary, chunksSkipped: summary.chunksSkipped + 1 };
      continue;
    }

    deps.logger.info('Dönem çekiliyor', {
      fonTuru: fundType,
      donem: describe(range),
      ilerleme: `${index + 1}/${ranges.length}`,
    });

    const outcome = await ingestChunk(deps, fundType, range);
    summary = {
      ...summary,
      chunksSucceeded: summary.chunksSucceeded + (outcome.status === 'success' ? 1 : 0),
      chunksEmpty: summary.chunksEmpty + (outcome.status === 'empty' ? 1 : 0),
      chunksFailed: summary.chunksFailed + (outcome.status === 'failed' ? 1 : 0),
      rowsFetched: summary.rowsFetched + outcome.rowsFetched,
      rowsInserted: summary.rowsInserted + outcome.inserted,
      rowsUpdated: summary.rowsUpdated + outcome.updated,
      rowsUnchanged: summary.rowsUnchanged + outcome.unchanged,
    };
    if (outcome.status === 'failed') failedRanges.push(range);
  }

  return { ...summary, failedRanges };
};

export const backfill = async (
  deps: IngestDeps,
  fundTypes: readonly FundType[],
  historyYears: number,
  options: RunOptions = {},
): Promise<IngestSummary[]> => {
  const start = earliestAllowedStart(historyYears);
  const end = todayIso();
  const ranges = monthlyChunks(start, end);

  deps.logger.info('Geçmiş yükleme planlandı', {
    fonTurleri: fundTypes.join(','),
    aralik: `${start}..${end}`,
    donemSayisi: ranges.length,
  });

  const summaries: IngestSummary[] = [];
  for (const fundType of fundTypes) {
    summaries.push(await ingestRanges(deps, fundType, ranges, options));
  }
  return summaries;
};

/**
 * Picks up from the newest stored day (re-fetching it, so TEFAS corrections land)
 * and walks forward to today. A machine that was off for weeks catches up on its own.
 */
export const updateDaily = async (
  deps: IngestDeps,
  fundTypes: readonly FundType[],
  historyYears: number,
): Promise<IngestSummary[]> => {
  const floor = earliestAllowedStart(historyYears);
  const end = todayIso();
  const summaries: IngestSummary[] = [];

  for (const fundType of fundTypes) {
    const latest = deps.repository.getLatestDate(fundType);
    const start = latest === null ? floor : maxIso(latest, floor);

    if (compareIso(start, end) > 0) {
      deps.logger.info('Zaten güncel', { fonTuru: fundType, sonKayit: latest });
      summaries.push(emptySummary(fundType));
      continue;
    }

    const ranges = monthlyChunks(start, end);
    deps.logger.info('Günlük güncelleme planlandı', {
      fonTuru: fundType,
      sonKayit: latest ?? 'yok',
      aralik: `${start}..${end}`,
      donemSayisi: ranges.length,
    });
    // force: the tail range must be re-read even though fetch_log may know it.
    summaries.push(await ingestRanges(deps, fundType, ranges, { force: true }));
  }

  return summaries;
};

export const retryFailed = async (deps: IngestDeps): Promise<IngestSummary[]> => {
  const failed = deps.repository.getFailedFetches();
  if (failed.length === 0) {
    deps.logger.info('Yeniden denenecek başarısız dönem yok');
    return [];
  }

  const byType = new Map<FundType, DateRange[]>();
  for (const entry of failed) {
    const list = byType.get(entry.fundType) ?? [];
    list.push(entry.range);
    byType.set(entry.fundType, list);
  }

  deps.logger.info('Başarısız dönemler yeniden deneniyor', { adet: failed.length });

  const summaries: IngestSummary[] = [];
  for (const [fundType, ranges] of byType) {
    summaries.push(await ingestRanges(deps, fundType, ranges, { force: true }));
  }
  return summaries;
};

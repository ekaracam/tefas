import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase } from './db/connection.js';
import {
  COLUMN_LABELS,
  EXPORT_COLUMNS,
  FundRepository,
  type ExportFilter,
} from './db/repository.js';
import { TefasClient } from './tefas/client.js';
import {
  backfill,
  ingestRanges,
  retryFailed,
  updateDaily,
  type IngestDeps,
  type IngestSummary,
} from './core/ingest.js';
import { exportCsv } from './export/csv.js';
import { exportXlsx } from './export/xlsx.js';
import { isFundType, type FundType } from './types.js';
import { monthlyChunks, parseIsoDate, todayIso } from './util/dates.js';

const USAGE = `
tefas-crawler - TEFAS fon verisi arşivi

Kullanım: npm run cli -- <komut> [seçenekler]

Komutlar:
  backfill            Tüm geçmişi çeker (varsayılan: son 5 yıl).
    --fund-type=YAT     Tek bir fon türü (varsayılan: TEFAS_FUND_TYPES).
    --years=5           Geçmiş derinliği; TEFAS bunu 5 yılla sınırlıyor.
    --force             Daha önce tamamlanmış dönemleri yeniden çeker.

  daily               En son kayıtlı günden bugüne kadarki eksikleri tamamlar.
    --fund-type=YAT

  fetch               Belirtilen tarih aralığını çeker (aylık parçalara böler).
    --from=2026-08-01   Zorunlu.
    --to=2026-08-13     Zorunlu.
    --fund-type=YAT

  retry-failed        Başarısız olarak kaydedilmiş tüm dönemleri yeniden dener.

  status              Fon türü bazında kapsama ve bekleyen hataları gösterir.

  export              Kayıtları CSV veya Excel dosyasına aktarır.
    --format=csv|xlsx   Varsayılan: csv.
    --out=YOL           Varsayılan: exports/tefas-<bugün>.<uzantı>
    --fund-type=YAT
    --fund-code=ABC
    --from=2026-01-01
    --to=2026-08-13
    --delimiter=,       Yalnızca CSV. Türkçe Excel için ";" kullanın.
    --decimal-comma     Yalnızca CSV. 1.23 yerine 1,23 yazar.

Çıkış kodları: 0 başarılı, 2 en az bir dönem başarısız, 1 komut/ayar hatası.
`;

const parseDate = (value: string | undefined, flag: string): string | undefined => {
  if (value === undefined) return undefined;
  try {
    parseIsoDate(value);
  } catch {
    throw new Error(`Geçersiz ${flag}="${value}". Beklenen biçim yyyy-aa-gg, örn. ${flag}=2026-08-13`);
  }
  return value;
};

const resolveFundTypes = (
  requested: string | undefined,
  configured: readonly FundType[],
): readonly FundType[] => {
  if (requested === undefined) return configured;
  const normalised = requested.trim().toUpperCase();
  if (!isFundType(normalised)) {
    throw new Error(`Bilinmeyen --fund-type "${requested}". İzin verilenler: YAT, EMK, BYF`);
  }
  return [normalised];
};

const reportSummaries = (label: string, summaries: readonly IngestSummary[]): number => {
  let failedChunks = 0;
  console.log(`\n=== ${label} ===`);
  for (const summary of summaries) {
    failedChunks += summary.chunksFailed;
    console.log(
      [
        `${summary.fundType}:`,
        `${summary.chunksSucceeded} başarılı`,
        `${summary.chunksEmpty} veri yok`,
        `${summary.chunksSkipped} atlandı`,
        `${summary.chunksFailed} başarısız`,
        `| ${summary.rowsInserted} yeni, ${summary.rowsUpdated} güncellendi, ${summary.rowsUnchanged} değişmedi`,
      ].join(' '),
    );
    for (const range of summary.failedRanges) {
      console.log(`  başarısız dönem: ${range.start}..${range.end}`);
    }
  }
  return failedChunks;
};

const runExport = async (
  repository: FundRepository,
  values: Record<string, string | boolean | undefined>,
  fundTypes: readonly FundType[],
): Promise<void> => {
  const format = (values['format'] as string | undefined) ?? 'csv';
  if (format !== 'csv' && format !== 'xlsx') {
    throw new Error(`Bilinmeyen --format "${format}". csv veya xlsx kullanın.`);
  }

  const fundCode = values['fund-code'] as string | undefined;
  const filter: ExportFilter = {
    ...(values['fund-type'] !== undefined ? { fundType: fundTypes[0]! } : {}),
    ...(fundCode !== undefined ? { fundCode } : {}),
    ...(parseDate(values['from'] as string | undefined, '--from') !== undefined
      ? { from: values['from'] as string }
      : {}),
    ...(parseDate(values['to'] as string | undefined, '--to') !== undefined
      ? { to: values['to'] as string }
      : {}),
  };

  const total = repository.countForExport(filter);
  if (total === 0) {
    console.log('Filtreye uyan kayıt yok; dosya oluşturulmadı.');
    return;
  }

  // TEFAS leaves some fields empty for whole fund types; an all-blank column
  // in a client-facing file reads as missing data, so drop it.
  const columns = repository.getPopulatedColumns(filter);
  const skipped = EXPORT_COLUMNS.filter((column) => !columns.includes(column));
  if (skipped.length > 0) {
    console.log(
      `Boş sütunlar atlandı: ${skipped.map((column) => COLUMN_LABELS[column]).join(', ')}`,
    );
  }

  const defaultOut = resolve(PROJECT_ROOT, 'exports', `tefas-${todayIso()}.${format}`);
  const outPath = values['out'] !== undefined ? resolve(String(values['out'])) : defaultOut;

  const rows = repository.iterateForExport(filter);
  const written =
    format === 'csv'
      ? await exportCsv(rows, outPath, {
          delimiter: (values['delimiter'] as string | undefined) ?? ',',
          decimalComma: values['decimal-comma'] === true,
          columns,
        })
      : exportXlsx(rows, outPath, columns);

  console.log(`${written.toLocaleString('tr-TR')} satır yazıldı: ${outPath}`);
};

const runStatus = (repository: FundRepository, dbPath: string): void => {
  const stats = repository.getStats();
  console.log(`Veri tabanı: ${dbPath}\n`);
  if (stats.length === 0) {
    console.log('Henüz veri yok. Çalıştırın: npm run backfill');
  } else {
    for (const entry of stats) {
      console.log(
        `${entry.fundType}: ${entry.rowCount.toLocaleString('tr-TR')} satır, ` +
          `${entry.fundCount} fon, ${entry.firstDate ?? '-'} -> ${entry.lastDate ?? '-'}`,
      );
    }
  }
  const failed = repository.countFailed();
  console.log(
    failed === 0
      ? '\nBaşarısız dönem yok.'
      : `\n${failed} başarısız dönem bekliyor. Çalıştırın: npm run retry-failed`,
  );
};

const main = async (): Promise<number> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    // Strict so a mistyped flag fails loudly instead of being silently ignored.
    strict: true,
    options: {
      'fund-type': { type: 'string' },
      'fund-code': { type: 'string' },
      years: { type: 'string' },
      force: { type: 'boolean' },
      format: { type: 'string' },
      out: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      delimiter: { type: 'string' },
      'decimal-comma': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  const command = positionals[0];
  if (command === undefined || values['help'] === true) {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  const config = loadConfig();
  const logger = createLogger(config.logDir);
  const db = openDatabase(config.dbPath);

  try {
    const repository = new FundRepository(db);
    const fundTypes = resolveFundTypes(values['fund-type'] as string | undefined, config.fundTypes);

    if (command === 'status') {
      runStatus(repository, config.dbPath);
      return 0;
    }

    if (command === 'export') {
      await runExport(repository, values, fundTypes);
      return 0;
    }

    const client = new TefasClient({
      apiUrl: config.apiUrl,
      apiToken: config.apiToken,
      pageSize: config.pageSize,
      timeoutMs: config.timeoutMs,
      requestDelayMs: config.requestDelayMs,
      maxRetries: config.maxRetries,
      retryBaseMs: config.retryBaseMs,
      throttleCooldownMs: config.throttleCooldownMs,
      logger,
    });
    const deps: IngestDeps = { client, repository, logger };

    switch (command) {
      case 'backfill': {
        const years = values['years'] !== undefined ? Number(values['years']) : config.historyYears;
        if (!Number.isFinite(years) || years <= 0) {
          throw new Error(`Geçersiz --years "${String(values['years'])}"`);
        }
        const summaries = await backfill(deps, fundTypes, years, {
          force: values['force'] === true,
        });
        return reportSummaries('Geçmiş yükleme', summaries) > 0 ? 2 : 0;
      }
      case 'daily': {
        const summaries = await updateDaily(deps, fundTypes, config.historyYears);
        return reportSummaries('Günlük güncelleme', summaries) > 0 ? 2 : 0;
      }
      case 'fetch': {
        const from = parseDate(values['from'] as string | undefined, '--from');
        const to = parseDate(values['to'] as string | undefined, '--to');
        if (from === undefined || to === undefined) {
          throw new Error('fetch komutu --from=YYYY-AA-GG ve --to=YYYY-AA-GG gerektirir');
        }
        const ranges = monthlyChunks(from, to);
        if (ranges.length === 0) {
          throw new Error(`Boş tarih aralığı: ${from}..${to}`);
        }
        const summaries: IngestSummary[] = [];
        for (const fundType of fundTypes) {
          summaries.push(await ingestRanges(deps, fundType, ranges, { force: true }));
        }
        return reportSummaries('Tarih aralığı çekme', summaries) > 0 ? 2 : 0;
      }
      case 'retry-failed': {
        const summaries = await retryFailed(deps);
        return reportSummaries('Başarısız dönemleri yeniden deneme', summaries) > 0 ? 2 : 0;
      }
      default:
        console.error(`Bilinmeyen komut "${command}".`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    // Fold the WAL back in so the .db file is self-contained; otherwise copying
    // it without its -wal sidecar silently loses the most recent writes.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

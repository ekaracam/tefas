import type { Database, Statement } from 'better-sqlite3';
import type { DateRange, FetchLogEntry, FundDailyRecord, FundType } from '../types.js';

export interface UpsertResult {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface FundTypeStats {
  readonly fundType: string;
  readonly rowCount: number;
  readonly fundCount: number;
  readonly firstDate: string | null;
  readonly lastDate: string | null;
}

export interface FailedFetch {
  readonly id: number;
  readonly fundType: FundType;
  readonly range: DateRange;
  readonly attempts: number;
  readonly errorKind: string | null;
  readonly errorMessage: string | null;
}

export interface ExportFilter {
  readonly fundType?: FundType;
  readonly fundCode?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface ExportRow {
  readonly fund_type: string;
  readonly fund_code: string;
  readonly fund_name: string;
  readonly date: string;
  readonly price: number | null;
  readonly share_count: number | null;
  readonly investor_count: number | null;
  readonly total_value: number | null;
  readonly exchange_bulletin_price: number | null;
}

export const EXPORT_COLUMNS = [
  'fund_type',
  'fund_code',
  'fund_name',
  'date',
  'price',
  'share_count',
  'investor_count',
  'total_value',
  'exchange_bulletin_price',
] as const satisfies readonly (keyof ExportRow)[];

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** Header text written to CSV/XLSX, matching the wording TEFAS uses on its own site. */
export const COLUMN_LABELS: Record<ExportColumn, string> = {
  fund_type: 'Fon Türü',
  fund_code: 'Fon Kodu',
  fund_name: 'Fon Adı',
  date: 'Tarih',
  price: 'Fiyat',
  share_count: 'Tedavüldeki Pay Sayısı',
  investor_count: 'Kişi Sayısı',
  total_value: 'Fon Toplam Değer',
  exchange_bulletin_price: 'Borsa Bülten Fiyatı',
};

/**
 * `updated_at` only moves when a value actually changed, so a re-run over
 * already-stored days stays a no-op and TEFAS corrections remain visible.
 */
const UPSERT_SQL = `
INSERT INTO fund_daily (
  fund_code, date, fund_type, fund_name, price, share_count,
  investor_count, total_value, exchange_bulletin_price
) VALUES (
  @fundCode, @date, @fundType, @fundName, @price, @shareCount,
  @investorCount, @totalValue, @exchangeBulletinPrice
)
ON CONFLICT (fund_code, date) DO UPDATE SET
  fund_type               = excluded.fund_type,
  fund_name               = excluded.fund_name,
  price                   = excluded.price,
  share_count             = excluded.share_count,
  investor_count          = excluded.investor_count,
  total_value             = excluded.total_value,
  exchange_bulletin_price = excluded.exchange_bulletin_price,
  updated_at              = datetime('now')
WHERE
  fund_daily.fund_type               IS NOT excluded.fund_type OR
  fund_daily.fund_name               IS NOT excluded.fund_name OR
  fund_daily.price                   IS NOT excluded.price OR
  fund_daily.share_count             IS NOT excluded.share_count OR
  fund_daily.investor_count          IS NOT excluded.investor_count OR
  fund_daily.total_value             IS NOT excluded.total_value OR
  fund_daily.exchange_bulletin_price IS NOT excluded.exchange_bulletin_price
`;

export class FundRepository {
  readonly #db: Database;
  readonly #upsert: Statement;
  readonly #logFetch: Statement;
  readonly #lastRowid: Statement;

  constructor(db: Database) {
    this.#db = db;
    this.#upsert = db.prepare(UPSERT_SQL);
    this.#lastRowid = db.prepare('SELECT last_insert_rowid() AS id').pluck();
    this.#logFetch = db.prepare(`
      INSERT INTO fetch_log (
        fund_type, start_date, end_date, status, row_count,
        attempts, error_kind, error_message, started_at, finished_at
      ) VALUES (
        @fundType, @startDate, @endDate, @status, @rowCount,
        @attempts, @errorKind, @errorMessage, @startedAt, datetime('now')
      )
      ON CONFLICT (fund_type, start_date, end_date) DO UPDATE SET
        status        = excluded.status,
        row_count     = excluded.row_count,
        attempts      = excluded.attempts,
        error_kind    = excluded.error_kind,
        error_message = excluded.error_message,
        started_at    = excluded.started_at,
        finished_at   = excluded.finished_at
    `);
  }

  upsertRecords(records: readonly FundDailyRecord[]): UpsertResult {
    const run = this.#db.transaction((batch: readonly FundDailyRecord[]): UpsertResult => {
      // changes===0 means the row was already byte-identical (the upsert's WHERE
      // guard suppressed it). To tell an INSERT from an UPDATE we watch the
      // connection's last_insert_rowid(), which only advances on a real insert -
      // safe here because rows are never deleted.
      let lastRowid = Number(this.#lastRowid.get());
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;

      for (const record of batch) {
        const info = this.#upsert.run(record);
        if (info.changes === 0) {
          unchanged += 1;
          continue;
        }
        const rowid = Number(info.lastInsertRowid);
        if (rowid > lastRowid) {
          inserted += 1;
          lastRowid = rowid;
        } else {
          updated += 1;
        }
      }

      return { inserted, updated, unchanged };
    });
    return run(records);
  }

  recordFetch(entry: FetchLogEntry, startedAt: string): void {
    this.#logFetch.run({
      fundType: entry.fundType,
      startDate: entry.range.start,
      endDate: entry.range.end,
      status: entry.status,
      rowCount: entry.rowCount,
      attempts: entry.attempts,
      errorKind: entry.errorKind,
      errorMessage: entry.errorMessage,
      startedAt,
    });
  }

  /** Ranges already fetched without error, used to make backfill resumable. */
  getCompletedRanges(fundType: FundType): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT start_date AS startDate, end_date AS endDate
         FROM fetch_log
         WHERE fund_type = ? AND status IN ('success', 'empty')`,
      )
      .all(fundType) as { startDate: string; endDate: string }[];
    return new Set(rows.map((row) => `${row.startDate}..${row.endDate}`));
  }

  getFailedFetches(): FailedFetch[] {
    const rows = this.#db
      .prepare(
        `SELECT id, fund_type AS fundType, start_date AS startDate, end_date AS endDate,
                attempts, error_kind AS errorKind, error_message AS errorMessage
         FROM fetch_log
         WHERE status = 'failed'
         ORDER BY start_date`,
      )
      .all() as {
      id: number;
      fundType: FundType;
      startDate: string;
      endDate: string;
      attempts: number;
      errorKind: string | null;
      errorMessage: string | null;
    }[];

    return rows.map((row) => ({
      id: row.id,
      fundType: row.fundType,
      range: { start: row.startDate, end: row.endDate },
      attempts: row.attempts,
      errorKind: row.errorKind,
      errorMessage: row.errorMessage,
    }));
  }

  getLatestDate(fundType: FundType): string | null {
    const row = this.#db
      .prepare('SELECT MAX(date) AS lastDate FROM fund_daily WHERE fund_type = ?')
      .get(fundType) as { lastDate: string | null } | undefined;
    return row?.lastDate ?? null;
  }

  getStats(): FundTypeStats[] {
    return this.#db
      .prepare(
        `SELECT fund_type AS fundType,
                COUNT(*) AS rowCount,
                COUNT(DISTINCT fund_code) AS fundCount,
                MIN(date) AS firstDate,
                MAX(date) AS lastDate
         FROM fund_daily
         GROUP BY fund_type
         ORDER BY fund_type`,
      )
      .all() as FundTypeStats[];
  }

  countFailed(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM fetch_log WHERE status = 'failed'`)
      .get() as { total: number };
    return row.total;
  }

  /** Streams rows so a multi-million-row export never has to fit in memory. */
  iterateForExport(filter: ExportFilter): IterableIterator<ExportRow> {
    const { where, params } = buildExportWhere(filter);
    const statement = this.#db.prepare(
      `SELECT ${EXPORT_COLUMNS.join(', ')} FROM fund_daily ${where} ORDER BY date, fund_code`,
    );
    return statement.iterate(params) as IterableIterator<ExportRow>;
  }

  /**
   * Columns holding at least one value for this filter. TEFAS leaves
   * borsaBultenFiyat empty for every non-exchange-traded fund and hides the
   * column on its own site, so writing it out reads as missing data.
   */
  getPopulatedColumns(filter: ExportFilter): ExportColumn[] {
    const { where, params } = buildExportWhere(filter);
    const projection = EXPORT_COLUMNS.map((column) => `COUNT(${column}) AS ${column}`).join(', ');
    const counts = this.#db
      .prepare(`SELECT ${projection} FROM fund_daily ${where}`)
      .get(params) as Record<ExportColumn, number>;
    return EXPORT_COLUMNS.filter((column) => (counts[column] ?? 0) > 0);
  }

  countForExport(filter: ExportFilter): number {
    const { where, params } = buildExportWhere(filter);
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS total FROM fund_daily ${where}`)
      .get(params) as { total: number };
    return row.total;
  }
}

const buildExportWhere = (
  filter: ExportFilter,
): { where: string; params: Record<string, string> } => {
  const conditions: string[] = [];
  const params: Record<string, string> = {};
  if (filter.fundType !== undefined) {
    conditions.push('fund_type = @fundType');
    params['fundType'] = filter.fundType;
  }
  if (filter.fundCode !== undefined) {
    conditions.push('fund_code = @fundCode');
    params['fundCode'] = filter.fundCode.toUpperCase();
  }
  if (filter.from !== undefined) {
    conditions.push('date >= @from');
    params['from'] = filter.from;
  }
  if (filter.to !== undefined) {
    conditions.push('date <= @to');
    params['to'] = filter.to;
  }
  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
};

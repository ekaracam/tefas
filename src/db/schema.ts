import type { Database } from 'better-sqlite3';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE fund_daily (
    fund_code               TEXT    NOT NULL,
    date                    TEXT    NOT NULL,
    fund_type               TEXT    NOT NULL,
    fund_name               TEXT    NOT NULL,
    price                   REAL,
    share_count             REAL,
    investor_count          INTEGER,
    total_value             REAL,
    exchange_bulletin_price REAL,
    created_at              TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (fund_code, date)
  );

  CREATE INDEX idx_fund_daily_date ON fund_daily (date);
  CREATE INDEX idx_fund_daily_type_date ON fund_daily (fund_type, date);

  CREATE TABLE fetch_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fund_type     TEXT    NOT NULL,
    start_date    TEXT    NOT NULL,
    end_date      TEXT    NOT NULL,
    status        TEXT    NOT NULL CHECK (status IN ('success', 'empty', 'failed')),
    row_count     INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    error_kind    TEXT,
    error_message TEXT,
    started_at    TEXT    NOT NULL,
    finished_at   TEXT    NOT NULL,
    UNIQUE (fund_type, start_date, end_date)
  );

  CREATE INDEX idx_fetch_log_status ON fetch_log (status);
  `,
];

/** Simple forward-only migrations tracked through SQLite's user_version pragma. */
export const migrate = (db: Database): void => {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const statement = MIGRATIONS[version];
    if (statement === undefined) continue;
    db.exec(`BEGIN; ${statement} PRAGMA user_version = ${version + 1}; COMMIT;`);
  }
};

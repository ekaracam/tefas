import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

export const openDatabase = (dbPath: string): Database.Database => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL keeps a long backfill from blocking a concurrent export or status check.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
};

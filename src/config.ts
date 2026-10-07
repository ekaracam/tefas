import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUND_TYPES, isFundType, type FundType } from './types.js';

/** Project root, resolved from this file so the CLI works from any cwd. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = resolve(PROJECT_ROOT, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const readString = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
};

const readInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Geçersiz ${key}: negatif olmayan bir tam sayı bekleniyordu, gelen "${raw}"`);
  }
  return parsed;
};

const readFundTypes = (): FundType[] => {
  const raw = readString('TEFAS_FUND_TYPES', 'YAT');
  const parsed = raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== '');
  const invalid = parsed.filter((part) => !isFundType(part));
  if (invalid.length > 0) {
    throw new Error(
      `Geçersiz TEFAS_FUND_TYPES değerleri: ${invalid.join(', ')}. İzin verilenler: ${FUND_TYPES.join(', ')}`,
    );
  }
  return parsed as FundType[];
};

const resolveFromRoot = (path: string): string =>
  isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);

export interface AppConfig {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly dbPath: string;
  readonly logDir: string;
  readonly fundTypes: readonly FundType[];
  readonly historyYears: number;
  readonly requestDelayMs: number;
  readonly maxRetries: number;
  readonly retryBaseMs: number;
  readonly throttleCooldownMs: number;
  readonly timeoutMs: number;
  readonly pageSize: number;
}

export const loadConfig = (): AppConfig => ({
  apiUrl: readString('TEFAS_API_URL', 'https://www.tefas.gov.tr/api/funds/fonGnlBlgSiraliGetir'),
  apiToken: readString('TEFAS_API_TOKEN', ''),
  dbPath: resolveFromRoot(readString('TEFAS_DB_PATH', 'data/tefas.db')),
  logDir: resolveFromRoot(readString('TEFAS_LOG_DIR', 'logs')),
  fundTypes: readFundTypes(),
  historyYears: readInt('TEFAS_HISTORY_YEARS', 5),
  requestDelayMs: readInt('TEFAS_REQUEST_DELAY_MS', 3_000),
  maxRetries: readInt('TEFAS_MAX_RETRIES', 5),
  retryBaseMs: readInt('TEFAS_RETRY_BASE_MS', 10_000),
  throttleCooldownMs: readInt('TEFAS_THROTTLE_COOLDOWN_MS', 60_000),
  timeoutMs: readInt('TEFAS_TIMEOUT_MS', 180_000),
  pageSize: readInt('TEFAS_PAGE_SIZE', 60_000),
});

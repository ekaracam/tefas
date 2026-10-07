import type { DateRange } from '../types.js';

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** All arithmetic runs in UTC so DST shifts can never move a calendar day. */
const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day));

export const parseIsoDate = (iso: string): Date => {
  if (!ISO_PATTERN.test(iso)) {
    throw new Error(`Geçersiz tarih: ${iso} (beklenen biçim yyyy-aa-gg)`);
  }
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const date = utc(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Geçersiz tarih: ${iso}`);
  }
  return date;
};

export const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** TEFAS expects yyyymmdd in basTarih/bitTarih. */
export const toApiDate = (iso: string): string => iso.replaceAll('-', '');

/**
 * "Today" always means today in Turkey, never the host's timezone. A server left
 * on UTC would otherwise ask TEFAS for the previous day between midnight and 03:00
 * local. en-CA formats as yyyy-mm-dd.
 */
const ISTANBUL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const todayIso = (): string => ISTANBUL_DATE.format(new Date());

export const addDays = (iso: string, days: number): string => {
  const date = parseIsoDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
};

export const subtractYears = (iso: string, years: number): string => {
  const date = parseIsoDate(iso);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return toIsoDate(date);
};

export const lastDayOfMonth = (iso: string): string => {
  const date = parseIsoDate(iso);
  return toIsoDate(utc(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
};

export const compareIso = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const minIso = (a: string, b: string): string => (a <= b ? a : b);
export const maxIso = (a: string, b: string): string => (a >= b ? a : b);

/**
 * Splits an inclusive range into chunks TEFAS accepts. The API rejects any span
 * wider than one calendar month, so chunks are aligned to month boundaries: the
 * first one starts at `start`, every following one starts on the 1st.
 */
export const monthlyChunks = (start: string, end: string): DateRange[] => {
  if (compareIso(start, end) > 0) return [];
  const chunks: DateRange[] = [];
  let cursor = start;
  while (compareIso(cursor, end) <= 0) {
    const chunkEnd = minIso(lastDayOfMonth(cursor), end);
    chunks.push({ start: cursor, end: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
};

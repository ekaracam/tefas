import type { FundDailyRecord, FundType, TefasApiRow } from '../types.js';

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const toNullableNumber = (value: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const toIsoDate = (value: string): string | null => {
  if (ISO_PATTERN.test(value)) return value;
  // Defensive: earlier TEFAS endpoints served epoch milliseconds as a string.
  const epoch = Number(value);
  if (Number.isFinite(epoch) && epoch > 0) {
    return new Date(epoch).toISOString().slice(0, 10);
  }
  return null;
};

export interface MappedRows {
  readonly records: readonly FundDailyRecord[];
  readonly skipped: number;
}

export const mapRows = (fundType: FundType, rows: readonly TefasApiRow[]): MappedRows => {
  const records: FundDailyRecord[] = [];
  let skipped = 0;

  for (const row of rows) {
    const fundCode = row.fonKodu?.trim();
    const rawDate = row.tarih?.trim();
    if (fundCode === undefined || fundCode === '' || rawDate === undefined || rawDate === '') {
      skipped += 1;
      continue;
    }
    const date = toIsoDate(rawDate);
    if (date === null) {
      skipped += 1;
      continue;
    }

    records.push({
      fundType,
      fundCode,
      fundName: row.fonUnvan?.trim() ?? '',
      date,
      price: toNullableNumber(row.fiyat),
      shareCount: toNullableNumber(row.tedPaySayisi),
      investorCount: toNullableNumber(row.kisiSayisi),
      totalValue: toNullableNumber(row.portfoyBuyukluk),
      exchangeBulletinPrice: toNullableNumber(row.borsaBultenFiyat),
    });
  }

  return { records, skipped };
};

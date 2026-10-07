import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { COLUMN_LABELS, type ExportColumn, type ExportRow } from '../db/repository.js';

const UTF8_BOM = '﻿';

export interface CsvOptions {
  readonly delimiter: string;
  /** Turkish Excel expects a decimal comma; plain CSV consumers expect a point. */
  readonly decimalComma: boolean;
  readonly columns: readonly ExportColumn[];
}

const escapeField = (value: string, delimiter: string): string => {
  const needsQuotes =
    value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r');
  return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
};

const formatCell = (value: unknown, options: CsvOptions): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const text = String(value);
    return options.decimalComma ? text.replace('.', ',') : text;
  }
  return escapeField(String(value), options.delimiter);
};

export const exportCsv = async (
  rows: Iterable<ExportRow>,
  outPath: string,
  options: CsvOptions,
): Promise<number> => {
  if (options.decimalComma && options.delimiter === ',') {
    throw new Error(
      'Virgül ayracı ile virgüllü ondalık birlikte kullanılamaz. --delimiter=";" kullanın.',
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const stream = createWriteStream(outPath, { encoding: 'utf8' });

  const write = async (chunk: string): Promise<void> => {
    if (!stream.write(chunk)) await once(stream, 'drain');
  };

  // BOM so Excel reads the Turkish characters as UTF-8.
  await write(UTF8_BOM);
  const header = options.columns
    .map((column) => escapeField(COLUMN_LABELS[column], options.delimiter))
    .join(options.delimiter);
  await write(`${header}\r\n`);

  let count = 0;
  let buffer = '';
  for (const row of rows) {
    buffer += `${options.columns.map((column) => formatCell(row[column], options)).join(options.delimiter)}\r\n`;
    count += 1;
    if (buffer.length > 1_000_000) {
      await write(buffer);
      buffer = '';
    }
  }
  if (buffer !== '') await write(buffer);

  stream.end();
  await once(stream, 'finish');
  return count;
};

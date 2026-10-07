import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLUMN_LABELS, type ExportColumn, type ExportRow } from '../db/repository.js';
import { createZip, type ZipEntry } from './zip.js';

/** The spreadsheet format itself caps a sheet at 1,048,576 rows, header included. */
export const XLSX_MAX_DATA_ROWS = 1_048_575;

const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const;

/**
 * Style slots defined in styles.xml below. Without an explicit number format
 * Excel falls back to "General", which renders a 68-billion portfolio value as
 * 6,8E+10 in a default-width column.
 */
const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_PRICE = 2;
const STYLE_DECIMAL = 3;
const STYLE_INTEGER = 4;

const COLUMN_STYLE: Record<ExportColumn, number> = {
  fund_type: STYLE_DEFAULT,
  fund_code: STYLE_DEFAULT,
  fund_name: STYLE_DEFAULT,
  date: STYLE_DEFAULT,
  price: STYLE_PRICE,
  share_count: STYLE_DECIMAL,
  investor_count: STYLE_INTEGER,
  total_value: STYLE_DECIMAL,
  exchange_bulletin_price: STYLE_PRICE,
};

/** Width in characters, wide enough that no value collapses to scientific notation. */
const COLUMN_WIDTH: Record<ExportColumn, number> = {
  fund_type: 10,
  fund_code: 10,
  fund_name: 55,
  date: 12,
  price: 14,
  share_count: 24,
  investor_count: 14,
  total_value: 24,
  exchange_bulletin_price: 20,
};

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    // Control characters are illegal in XML 1.0 and Excel refuses the whole file.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '');

const cell = (reference: string, value: unknown, style: number): string => {
  if (value === null || value === undefined) return '';
  const styleAttr = style > 0 ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${styleAttr}><v>${value}</v></c>`;
  }
  return `<c r="${reference}"${styleAttr} t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fon Verileri" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

// Format codes use '.' and ',' as placeholders; Excel renders them per the
// viewer's locale, so a Turkish Excel shows 1.234.567,89.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="3"><numFmt numFmtId="164" formatCode="0.000000"/><numFmt numFmtId="165" formatCode="#,##0.00"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export const exportXlsx = (
  rows: Iterable<ExportRow>,
  outPath: string,
  columns: readonly ExportColumn[],
): number => {
  const headerCells = columns
    .map((column, index) => cell(`${COLUMN_LETTERS[index]!}1`, COLUMN_LABELS[column], STYLE_HEADER))
    .join('');
  const body: string[] = [`<row r="1">${headerCells}</row>`];

  let count = 0;
  for (const row of rows) {
    count += 1;
    if (count > XLSX_MAX_DATA_ROWS) {
      throw new Error(
        `Dışa aktarım ${XLSX_MAX_DATA_ROWS.toLocaleString('tr-TR')} satırlık Excel sınırını aşıyor. ` +
          'Filtreyi daraltın (--fund-code / --from / --to) veya --format=csv kullanın.',
      );
    }
    const rowNumber = count + 1;
    const cells = columns
      .map((column, index) =>
        cell(`${COLUMN_LETTERS[index]!}${rowNumber}`, row[column], COLUMN_STYLE[column]),
      )
      .join('');
    body.push(`<row r="${rowNumber}">${cells}</row>`);
  }

  const lastColumn = COLUMN_LETTERS[columns.length - 1]!;
  const lastRow = count + 1;
  const cols = columns
    .map((column, index) => {
      const at = index + 1;
      return `<col min="${at}" max="${at}" width="${COLUMN_WIDTH[column]}" customWidth="1"/>`;
    })
    .join('');

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastColumn}${lastRow}"/>` +
    // Freeze the header so it stays visible while scrolling five years of rows.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${body.join('')}</sheetData>` +
    `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` +
    '</worksheet>';

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ];

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, createZip(entries));
  return count;
};

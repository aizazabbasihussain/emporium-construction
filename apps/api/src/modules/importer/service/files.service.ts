import { ValidationError } from '@emporium/domain';
import {
  MAX_DATA_ROWS,
  formatCsv,
  parseCsv,
  type ImportFormat,
  type TemplateContent,
  NOTES_HEADER,
} from '@emporium/domain/importer';
import ExcelJS from 'exceljs';

const BOM = '﻿';

/** Text of one XLSX cell: dates become ISO dates, formulas use their result. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value);
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('result' in value) return cellText(value.result);
  if ('text' in value) return String(value.text);
  return '';
}

/** BR-1: the first sheet of an XLSX file as rows of text. */
export async function parseXlsx(content: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    throw new ValidationError('xlsx_unreadable', 'The file is not a readable .xlsx workbook');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  if (sheet.actualRowCount > MAX_DATA_ROWS + 1) {
    throw new ValidationError('too_many_rows', 'The file has more than 50,000 rows');
  }
  const width = sheet.columnCount;
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value)));
  });
  return rows;
}

export const parseFile = (format: ImportFormat, content: Buffer): Promise<string[][]> =>
  format === 'csv' ? Promise.resolve(parseCsv(content.toString('utf8'))) : parseXlsx(content);

/** BR-8: CSV (with a byte-order mark so Excel reads Urdu) or XLSX with a Template and a Notes sheet. */
export async function writeTemplate(
  template: TemplateContent,
  format: ImportFormat,
): Promise<{ contentType: string; body: Buffer | string }> {
  if (format === 'csv') {
    return {
      contentType: 'text/csv; charset=utf-8',
      body: BOM + formatCsv([template.header, template.example]),
    };
  }
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Template').addRows([template.header, template.example]);
  workbook.addWorksheet('Notes').addRows([NOTES_HEADER, ...template.notes]);
  const bytes = await workbook.xlsx.writeBuffer();
  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: Buffer.from(bytes),
  };
}

export const errorsCsv = (errors: readonly { rowNo: number; column: string; message: string }[]) =>
  BOM +
  formatCsv([
    ['row', 'column', 'message'],
    ...errors.map((e) => [String(e.rowNo), e.column, e.message]),
  ]);

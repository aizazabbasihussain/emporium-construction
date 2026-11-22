import { Money } from '../kernel/index.js';
import { ValidationError } from '../errors.js';
import type { ExportLayout } from './layouts.js';

export type CellValue = string | number | null;

/** One exported row. `tag` names the document line it came from, when it came from one. */
export interface ExportRow {
  values: Readonly<Record<string, CellValue>>;
  tag?: { docType: string; docId: string; lineRef: string } | undefined;
}

/** BR-4: the sum of each money column of the rows. */
export function columnTotals(
  layout: ExportLayout,
  rows: readonly ExportRow[],
): Record<string, string> {
  const totals: Record<string, string> = {};
  for (const column of layout.columns) {
    if (column.type !== 'money') continue;
    totals[column.key] = rows
      .reduce((sum, row) => sum.add(Money.of(String(row.values[column.key] ?? '0'))), Money.zero())
      .toString();
  }
  return totals;
}

export interface ControlMismatch {
  column: string;
  exported: string;
  owning: string;
}

/** BR-5: the columns whose exported sum differs from the figure the owning module reports. */
export function controlMismatches(
  layout: ExportLayout,
  totals: Readonly<Record<string, string>>,
  owning: Readonly<Record<string, string>>,
): ControlMismatch[] {
  const mismatches: ControlMismatch[] = [];
  for (const column of layout.controlColumns) {
    const reported = owning[column];
    if (reported === undefined) {
      throw new ValidationError('control_missing', `No control figure for ${column}`);
    }
    const exported = totals[column] as string;
    if (!Money.of(exported).equals(Money.of(reported))) {
      mismatches.push({ column, exported, owning: Money.of(reported).toString() });
    }
  }
  return mismatches;
}

/** BR-2: rows that come from a document line and have no account code. */
export function untaggedCount(rows: readonly ExportRow[]): number {
  return rows.filter((row) => row.tag !== undefined && !row.values.account_code).length;
}

/** One cell as text: blanks stay blank, money keeps two decimals. */
const cellText = (value: CellValue | undefined): string =>
  value === null || value === undefined ? '' : String(value);

const csvField = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

/**
 * BR-6: the data section as canonical text: the column keys, then the rows in the order given, with
 * no timestamp and no name of who ran it. The checksum is taken over this text, so the same data
 * gives the same checksum on any day.
 */
export function dataSection(layout: ExportLayout, rows: readonly ExportRow[]): string {
  const lines = [layout.columns.map((column) => column.key).join(',')];
  for (const row of rows) {
    lines.push(
      layout.columns.map((column) => csvField(cellText(row.values[column.key]))).join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

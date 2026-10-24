import { cleanCell } from './cleaning.js';
import type { ColumnDef, DateFormats, ImportRecord, ValidatedTable } from './types.js';

const norm = (text: string) => text.trim().toLowerCase();

/**
 * Validates a whole table (header row first) and reports every fault, not only the first (BR-6).
 * Blank rows are skipped. Header faults are reported on row 1.
 */
export function validateTable(
  columns: readonly ColumnDef[],
  table: readonly (readonly string[])[],
  formats: DateFormats,
): ValidatedTable {
  const errors: ValidatedTable['errors'] = [];
  const header = table[0] ?? [];
  const position = new Map<string, number>();
  header.forEach((title, index) => {
    const key = norm(title);
    if (key === '') return;
    if (position.has(key)) {
      errors.push({ rowNo: 1, column: title.trim(), message: 'Duplicate column' });
    } else position.set(key, index);
  });
  const known = new Set(columns.map((c) => norm(c.name)));
  for (const title of header) {
    if (norm(title) !== '' && !known.has(norm(title))) {
      errors.push({ rowNo: 1, column: title.trim(), message: 'Unknown column' });
    }
  }
  for (const column of columns) {
    if (column.required && !position.has(norm(column.name))) {
      errors.push({ rowNo: 1, column: column.name, message: 'Required column is missing' });
    }
  }
  if (errors.length > 0) return { records: [], errors };

  const records: ValidatedTable['records'] = [];
  table.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    const rowNo = index + 2;
    const record: ImportRecord = {};
    for (const column of columns) {
      const at = position.get(norm(column.name));
      const raw = at === undefined ? '' : (cells[at] ?? '');
      const cleaned = cleanCell(column, raw, formats);
      if (cleaned.ok) record[column.name] = cleaned.value;
      else errors.push({ rowNo, column: column.name, message: cleaned.message });
    }
    records.push({ rowNo, record });
  });
  return { records, errors };
}

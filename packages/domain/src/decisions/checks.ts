import Decimal from 'decimal.js';

/** One validation problem. `row` is the 1-based line in the file; 0 means the whole file. */
export interface DecisionIssue {
  file: string;
  row: number;
  message: string;
}

/** Returns a message when the value is invalid, otherwise undefined. */
export type Check = (value: string) => string | undefined;

export const isoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

const parseDecimal = (value: string): Decimal | undefined =>
  /^-?\d+(\.\d+)?$/.test(value) ? new Decimal(value) : undefined;

export const required: Check = (value) => (value === '' ? 'is required' : undefined);

export const oneOf =
  (allowed: readonly string[]): Check =>
  (value) =>
    allowed.includes(value) ? undefined : `must be one of ${allowed.join(', ')}`;

export const dateCheck: Check = (value) =>
  isoDate(value) ? undefined : 'must be a date in yyyy-mm-dd form';

export const rateCheck: Check = (value) => {
  const rate = parseDecimal(value);
  if (!rate) return 'must be a number';
  return rate.lt(0) || rate.gt(100) ? 'must be between 0 and 100' : undefined;
};

export const amountCheck: Check = (value) => {
  const amount = parseDecimal(value);
  if (!amount) return 'must be a number';
  return amount.lt(0) ? 'must not be negative' : undefined;
};

export const integerCheck =
  (min: number): Check =>
  (value) =>
    /^\d+$/.test(value) && Number(value) >= min
      ? undefined
      : `must be a whole number of ${min} or more`;

/** Lets a blank value through and applies `check` to anything else. */
export const optional =
  (check: Check): Check =>
  (value) =>
    value === '' ? undefined : check(value);

/** A parsed data row with its 1-based line number in the file. */
export interface Row {
  row: number;
  cells: Record<string, string>;
}

/** Reads a cell; a column that is absent reads as blank. */
export const get = (cells: Record<string, string>, column: string): string => cells[column] ?? '';

/** Applies each column's check to every row. */
export function checkFields(
  file: string,
  rows: readonly Row[],
  schema: Record<string, Check>,
): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  for (const { row, cells } of rows) {
    for (const [column, check] of Object.entries(schema)) {
      const problem = check(get(cells, column));
      if (problem) issues.push({ file, row, message: `${column} ${problem}` });
    }
  }
  return issues;
}

/** Rejects duplicate values in the given columns taken together (a unique key). */
export function checkUnique(
  file: string,
  rows: readonly Row[],
  columns: readonly string[],
): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  const seen = new Set<string>();
  for (const { row, cells } of rows) {
    const key = columns.map((column) => get(cells, column)).join('|');
    if (seen.has(key)) {
      issues.push({ file, row, message: `duplicate ${columns.join(' + ')} "${key}"` });
    }
    seen.add(key);
  }
  return issues;
}

/** Rejects references to values that do not exist in `known`. Blank values are ignored. */
export function checkReference(
  file: string,
  rows: readonly Row[],
  column: string,
  known: ReadonlySet<string>,
): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  for (const { row, cells } of rows) {
    const value = get(cells, column);
    if (value !== '' && !known.has(value)) {
      issues.push({ file, row, message: `${column} "${value}" is not defined` });
    }
  }
  return issues;
}

/** Duplicate codes, unknown parents and cycles in a code and parent_code hierarchy. */
export function checkHierarchy(file: string, rows: readonly Row[]): DecisionIssue[] {
  const issues = checkUnique(file, rows, ['code']);
  const parents = new Map(rows.map(({ cells }) => [get(cells, 'code'), get(cells, 'parent_code')]));
  issues.push(...checkReference(file, rows, 'parent_code', new Set(parents.keys())));
  for (const { row, cells } of rows) {
    const code = get(cells, 'code');
    const seen = new Set<string>();
    const parentOf = (value: string): string => parents.get(value) ?? '';
    let current = parentOf(code);
    while (current !== '' && !seen.has(current)) {
      if (current === code) {
        issues.push({ file, row, message: `code "${code}" is its own ancestor (cycle)` });
        break;
      }
      seen.add(current);
      current = parentOf(current);
    }
  }
  return issues;
}

export interface RangeEntry {
  row: number;
  key: string;
  from: string;
  to: string;
}

/**
 * Effective ranges are inclusive dates; a blank `to` is open-ended. Reports a `to` before `from`
 * and overlaps between ranges that share a key. Entries must already have valid dates.
 */
export function checkRanges(file: string, entries: readonly RangeEntry[]): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  const groups = new Map<string, RangeEntry[]>();
  for (const entry of entries) {
    if (entry.to !== '' && entry.to < entry.from) {
      issues.push({ file, row: entry.row, message: 'effective_to is before effective_from' });
    } else {
      groups.set(entry.key, [...(groups.get(entry.key) ?? []), entry]);
    }
  }
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.from.localeCompare(b.from));
    sorted.forEach((entry, index) => {
      const previous = sorted[index - 1];
      if (previous && (previous.to === '' || previous.to >= entry.from)) {
        issues.push({
          file,
          row: entry.row,
          message: `effective range overlaps row ${previous.row} for ${key}`,
        });
      }
    });
  }
  return issues;
}

export interface BandEntry {
  row: number;
  group: string;
  min: string;
  max: string;
}

/**
 * Amount bands per group: min inclusive, max exclusive, a blank max means no upper limit. Bands
 * must start at 0 and each must start where the previous one ends. Entries must have valid amounts.
 */
export function checkBands(file: string, entries: readonly BandEntry[]): DecisionIssue[] {
  const issues: DecisionIssue[] = [];
  const groups = new Map<string, BandEntry[]>();
  for (const entry of entries) {
    if (entry.max !== '' && new Decimal(entry.min).gt(entry.max)) {
      issues.push({ file, row: entry.row, message: 'min_amount is greater than max_amount' });
    } else {
      groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
    }
  }
  for (const [group, bands] of groups) {
    const sorted = [...bands].sort((a, b) => new Decimal(a.min).comparedTo(b.min));
    sorted.forEach((band, index) => {
      const previous = sorted[index - 1];
      const where = `${group} band`;
      if (previous?.max === '') {
        issues.push({
          file,
          row: band.row,
          message: `${where} overlaps the open-ended band at row ${previous.row}`,
        });
        return;
      }
      const expected = previous ? previous.max : '0';
      const start = new Decimal(band.min);
      if (start.lt(expected)) {
        issues.push({ file, row: band.row, message: `${where} overlaps the band before it` });
      } else if (start.gt(expected)) {
        issues.push({
          file,
          row: band.row,
          message: `${where} leaves a gap: expected min_amount ${expected}`,
        });
      }
    });
  }
  return issues;
}

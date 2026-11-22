/**
 * Cutover document readers (P2-10 BR-1, BR-9): the opening control sheet, the opening verification
 * and the parallel-run log. Pure functions over Markdown text; the callers read the files.
 */

export interface ControlRow {
  key: string;
  label: string;
  total: string;
}

export interface OpeningDifference {
  key: string;
  controlSheet: string;
  loaded: string;
  difference: string;
}

const MONEY = /^-?\d+(\.\d{1,2})?$/;

const cells = (line: string) =>
  line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim().replaceAll('`', ''));

/** Rows of the control sheet table: `| key | label | total |`. Money has no thousands separators. */
export function parseControlSheet(markdown: string): ControlRow[] {
  const rows: ControlRow[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const [key, label, total] = cells(line);
    if (key !== undefined && /^[a-z][a-z0-9_.]*$/.test(key) && MONEY.test(total ?? '')) {
      rows.push({ key, label: label ?? '', total: total as string });
    }
  }
  return rows;
}

const cents = (value: string): bigint => {
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return value.startsWith('-') ? -amount : amount;
};

const fromCents = (value: bigint): string => {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

/**
 * Compares the loaded totals with the control sheet (BR-1): every key on either side must appear on
 * both, and the difference must be zero to the paisa.
 */
export function compareOpening(
  control: readonly ControlRow[],
  loaded: Readonly<Record<string, string>>,
): OpeningDifference[] {
  const found: OpeningDifference[] = [];
  for (const row of control) {
    const actual = loaded[row.key] ?? '0.00';
    const diff = cents(actual) - cents(row.total);
    if (diff !== 0n || loaded[row.key] === undefined) {
      found.push({
        key: row.key,
        controlSheet: row.total,
        loaded: loaded[row.key] ?? 'not loaded',
        difference: fromCents(diff),
      });
    }
  }
  const known = new Set(control.map((row) => row.key));
  for (const [key, value] of Object.entries(loaded)) {
    if (!known.has(key)) {
      found.push({
        key,
        controlSheet: 'not on the control sheet',
        loaded: value,
        difference: value,
      });
    }
  }
  return found;
}

export interface ParallelRunDay {
  date: string;
  checks: Record<(typeof parallelRunChecks)[number], string>;
  unexplained: number;
}

export const parallelRunChecks = [
  'cash',
  'invoices',
  'receipts',
  'payments',
  'stock issues',
  'attendance',
] as const;

export interface ParallelRunReport {
  days: ParallelRunDay[];
  problems: string[];
  /** BR-9: zero unexplained differences over the last 10 working days. */
  cleanLastTen: boolean;
}

/**
 * Reads the daily table of `parallel-run-log.md`:
 * `| date | cash | invoices | receipts | payments | stock issues | attendance | unexplained | note |`.
 * Each check cell is `ok` or the difference in words; the `unexplained` cell counts differences with
 * no explanation. A malformed row is a problem, not a skipped row.
 */
export function checkParallelRunLog(markdown: string): ParallelRunReport {
  const days: ParallelRunDay[] = [];
  const problems: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const row = cells(line);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row[0] ?? '')) continue;
    const date = row[0] as string;
    if (row.length < 8) {
      problems.push(`${date}: expected 8 or more columns, found ${row.length}`);
      continue;
    }
    if (Number.isNaN(Date.parse(date))) {
      problems.push(`${date}: not a real date`);
      continue;
    }
    const unexplained = Number(row[7]);
    if (!Number.isInteger(unexplained) || unexplained < 0) {
      problems.push(`${date}: the unexplained column must be a whole number`);
      continue;
    }
    const checks = Object.fromEntries(
      parallelRunChecks.map((name, index) => [name, row[index + 1] ?? '']),
    ) as ParallelRunDay['checks'];
    const empty = parallelRunChecks.filter((name) => checks[name] === '');
    if (empty.length > 0) problems.push(`${date}: nothing recorded for ${empty.join(', ')}`);
    if (unexplained === 0 && parallelRunChecks.some((name) => /differ/i.test(checks[name]))) {
      problems.push(`${date}: a difference is recorded but the unexplained count is 0`);
    }
    days.push({ date, checks, unexplained });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < days.length; i += 1) {
    if (days[i]?.date === days[i - 1]?.date) problems.push(`${days[i]?.date}: recorded twice`);
  }
  const lastTen = days.slice(-10);
  return {
    days,
    problems,
    cleanLastTen:
      problems.length === 0 && lastTen.length === 10 && lastTen.every((d) => d.unexplained === 0),
  };
}

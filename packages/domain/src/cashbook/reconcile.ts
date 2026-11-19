import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';
import { signed, type Direction } from './ledger.js';

export const reconciliationStatuses = ['draft', 'completed'] as const;
export type ReconciliationStatus = (typeof reconciliationStatuses)[number];

/** Constitution 5.8: a draft completes; a completed one is reopened to un-reconcile (BR-8). */
export const reconciliationTransitions: Record<
  ReconciliationStatus,
  readonly ReconciliationStatus[]
> = {
  draft: ['completed'],
  completed: ['draft'],
};

export function assertReconciliationTransition(
  from: ReconciliationStatus,
  to: ReconciliationStatus,
): void {
  if (!reconciliationTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'reconciliation_transition',
      `A reconciliation cannot go from ${from} to ${to}`,
    );
  }
}

export interface StatementLine {
  lineDate: string;
  description: string;
  /** Money leaving the account (bank view), `0.00` when the line is a credit. */
  debit: string;
  /** Money entering the account. */
  credit: string;
}

const MONEY = /^\d{1,14}(\.\d{1,2})?$/;

/** Splits one CSV record, honouring double quotes and doubled quotes inside them. */
function splitRecord(record: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < record.length; i += 1) {
    const char = record[i] as string;
    if (quoted) {
      if (char === '"' && record[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function parseDate(text: string, row: number): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : [];
  const stamp = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const valid =
    y !== undefined &&
    new Date(stamp).getUTCFullYear() === Number(y) &&
    new Date(stamp).getUTCMonth() === Number(m) - 1 &&
    new Date(stamp).getUTCDate() === Number(d);
  if (!valid) {
    throw new ValidationError('statement_date_invalid', `Row ${row}: "${text}" is not a date`, {
      row,
    });
  }
  return `${y}-${m}-${d}`;
}

function parseAmount(text: string, row: number): string {
  const clean = text.replace(/,/g, '');
  if (clean === '') return '0.00';
  if (!MONEY.test(clean)) {
    throw new ValidationError(
      'statement_amount_invalid',
      `Row ${row}: "${text}" is not an amount`,
      {
        row,
      },
    );
  }
  return Money.of(clean).toString();
}

/**
 * BR-8: a bank statement as CSV with the columns date, description, debit and credit (either date
 * format `yyyy-mm-dd` or `dd/mm/yyyy`). Each line is exactly one of debit or credit.
 */
export function parseStatementCsv(text: string): StatementLine[] {
  const records = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = splitRecord(records[0] ?? '').map((h) => h.toLowerCase());
  if (header.join(',') !== 'date,description,debit,credit') {
    throw new ValidationError(
      'statement_header_invalid',
      'The first row must be: date, description, debit, credit',
    );
  }
  if (records.length < 2) {
    throw new ValidationError('statement_empty', 'The statement has no lines');
  }
  return records.slice(1).map((record, index) => {
    const row = index + 2;
    const cells = splitRecord(record);
    if (cells.length !== 4) {
      throw new ValidationError('statement_row_invalid', `Row ${row}: expected four columns`, {
        row,
      });
    }
    const [date, description, debit, credit] = cells as [string, string, string, string];
    const line = {
      lineDate: parseDate(date, row),
      description,
      debit: parseAmount(debit, row),
      credit: parseAmount(credit, row),
    };
    const hasDebit = Money.of(line.debit).value.gt(0);
    const hasCredit = Money.of(line.credit).value.gt(0);
    if (hasDebit === hasCredit) {
      throw new ValidationError(
        'statement_row_invalid',
        `Row ${row}: a line is either a debit or a credit`,
        { row },
      );
    }
    return line;
  });
}

/** Bank view: a credit adds money to the account, a debit takes it away. */
export function lineDirection(line: Pick<StatementLine, 'debit' | 'credit'>): Direction {
  return Money.of(line.credit).value.gt(0) ? 'in' : 'out';
}

export function lineAmount(line: Pick<StatementLine, 'debit' | 'credit'>): string {
  return lineDirection(line) === 'in' ? line.credit : line.debit;
}

export interface MatchLine {
  id: string;
  lineDate: string;
  debit: string;
  credit: string;
}

export interface MatchTxn {
  id: string;
  txnDate: string;
  direction: Direction;
  amount: string;
}

export interface Suggestion {
  lineId: string;
  transactionId: string;
  dayDifference: number;
}

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/**
 * BR-8: a statement line is suggested against a transaction with the same direction and amount
 * dated within `toleranceDays`. The closest date wins (the earlier transaction on a tie, by the
 * given order) and a transaction is suggested once.
 */
export function suggestMatches(
  lines: readonly MatchLine[],
  transactions: readonly MatchTxn[],
  toleranceDays = 3,
): Suggestion[] {
  const used = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const line of lines) {
    let best: Suggestion | undefined;
    for (const txn of transactions) {
      if (used.has(txn.id)) continue;
      if (txn.direction !== lineDirection(line)) continue;
      if (!Money.of(txn.amount).equals(Money.of(lineAmount(line)))) continue;
      const gap = Math.abs(dayNumber(txn.txnDate) - dayNumber(line.lineDate));
      if (gap > toleranceDays) continue;
      if (best === undefined || gap < best.dayDifference) {
        best = { lineId: line.id, transactionId: txn.id, dayDifference: gap };
      }
    }
    if (best !== undefined) {
      used.add(best.transactionId);
      suggestions.push(best);
    }
  }
  return suggestions;
}

export interface ReconciliationInput {
  statementClosingBalance: string;
  /** Book balance on the statement end date. */
  bookBalance: string;
  /** Book transactions up to the end date that no statement line is matched to. */
  unreconciledBook: readonly { direction: Direction; amount: string }[];
  /** Statement lines that no book transaction is matched to. */
  unreconciledStatement: readonly Pick<StatementLine, 'debit' | 'credit'>[];
}

export interface ReconciliationFigures {
  bookUnreconciled: string;
  statementUnreconciled: string;
  /** Book balance less unreconciled book items plus unreconciled statement items. */
  expectedClosing: string;
  /** Statement closing less the expected closing; zero when the books and the bank agree. */
  difference: string;
}

/**
 * BR-8: statement closing = book balance - unreconciled book items + unreconciled statement items.
 * Items are signed from the account's view (in and credits positive, out and debits negative).
 */
export function reconciliationFigures(input: ReconciliationInput): ReconciliationFigures {
  const book = input.unreconciledBook.reduce(
    (sum, item) => sum.add(signed(item.direction, item.amount)),
    Money.zero(),
  );
  const statement = input.unreconciledStatement.reduce(
    (sum, line) => sum.add(signed(lineDirection(line), lineAmount(line))),
    Money.zero(),
  );
  const expected = Money.of(input.bookBalance).sub(book).add(statement);
  return {
    bookUnreconciled: book.toString(),
    statementUnreconciled: statement.toString(),
    expectedClosing: expected.toString(),
    difference: Money.of(input.statementClosingBalance).sub(expected).toString(),
  };
}

export function assertCanComplete(figures: Pick<ReconciliationFigures, 'difference'>): void {
  if (!Money.of(figures.difference).isZero()) {
    throw new RuleViolationError(
      'reconciliation_difference',
      `The statement and the books differ by ${figures.difference}`,
      { difference: figures.difference },
    );
  }
}

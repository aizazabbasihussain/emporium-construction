import { describe, expect, it } from 'vitest';
import { RuleViolationError, ValidationError } from '../errors.js';
import { Money } from '../kernel/money.js';
import {
  accountKinds,
  assertAfterOpening,
  assertCanComplete,
  assertDirectionMatchesType,
  assertPositiveAmount,
  assertReconciliationTransition,
  assertReversible,
  assertWithinOverdraft,
  balanceOn,
  lineAmount,
  lineDirection,
  lowestBalanceFrom,
  movementOn,
  oppositeDirection,
  parseStatementCsv,
  reconciliationFigures,
  reconciliationStatuses,
  reconciliationTransitions,
  signed,
  suggestMatches,
  summarizePosition,
  txnTypes,
  typeDirection,
  type LedgerEntry,
} from './index.js';

const e = (direction: 'in' | 'out', amount: string, txnDate: string): LedgerEntry => ({
  direction,
  amount,
  txnDate,
});

describe('balances (BR-1)', () => {
  const entries = [e('in', '1000.00', '2026-11-01'), e('out', '250.50', '2026-11-03')];
  it('adds the opening balance and the signed entries on or before the date', () => {
    expect(balanceOn('500.00', entries, '2026-10-31').toString()).toBe('500.00');
    expect(balanceOn('500.00', entries, '2026-11-01').toString()).toBe('1500.00');
    expect(balanceOn('500.00', entries, '2026-11-03').toString()).toBe('1249.50');
    expect(balanceOn('500.00', entries, '2027-01-01').toString()).toBe('1249.50');
  });
  it('signs amounts by direction', () => {
    expect(signed('in', '5').toString()).toBe('5.00');
    expect(signed('out', '5').toString()).toBe('-5.00');
    expect(oppositeDirection('in')).toBe('out');
    expect(oppositeDirection('out')).toBe('in');
  });
  it('totals the movement of one day (BR-9)', () => {
    const day = [...entries, e('in', '10.00', '2026-11-03'), e('out', '1.00', '2026-11-03')];
    const m = movementOn(day, '2026-11-03');
    expect([m.in.toString(), m.out.toString()]).toEqual(['10.00', '251.50']);
    expect(movementOn(day, '2026-12-01').in.toString()).toBe('0.00');
  });
  it('refuses a zero, negative or non-numeric amount', () => {
    expect(assertPositiveAmount('0.01').toString()).toBe('0.01');
    expect(() => assertPositiveAmount('0')).toThrow(ValidationError);
    expect(() => assertPositiveAmount('-3')).toThrow(ValidationError);
  });
  it('refuses a date before the opening date', () => {
    expect(() => assertAfterOpening('2026-11-01', '2026-11-01')).not.toThrow();
    expect(() => assertAfterOpening('2026-10-31', '2026-11-01')).toThrow(RuleViolationError);
  });
});

describe('overdraw rules (BR-3)', () => {
  it('finds the lowest end-of-day balance from a date, so a backdated payment is caught later', () => {
    const entries = [
      e('in', '100.00', '2026-11-01'),
      e('out', '80.00', '2026-11-05'),
      e('in', '10.00', '2026-11-06'),
    ];
    expect(lowestBalanceFrom('0.00', entries, '2026-11-01').toString()).toBe('20.00');
    expect(lowestBalanceFrom('0.00', entries, '2026-11-05').toString()).toBe('20.00');
    expect(lowestBalanceFrom('0.00', entries, '2026-11-06').toString()).toBe('30.00');
    expect(lowestBalanceFrom('0.00', [], '2026-11-06').toString()).toBe('0.00');
    expect(
      lowestBalanceFrom(
        '0.00',
        [...entries, e('out', '60.00', '2026-11-03')],
        '2026-11-03',
      ).toString(),
    ).toBe('-40.00');
  });

  it.each([
    ['cash', false, '-0.01', true],
    ['cash', true, '-0.01', true],
    ['petty_cash', true, '-5.00', true],
    ['bank', false, '-0.01', true],
    ['bank', true, '-500.00', false],
    ['wallet', false, '-1.00', true],
    ['wallet', true, '-1.00', false],
    ['cash', false, '0.00', false],
    ['bank', false, '10.00', false],
  ] as const)('%s with overdraft %s at %s blocked=%s', (kind, allowOverdraft, low, blocked) => {
    const run = () => assertWithinOverdraft({ kind, allowOverdraft, lowestBalance: Money.of(low) });
    if (blocked) {
      expect(run).toThrow(RuleViolationError);
    } else {
      expect(run).not.toThrow();
    }
  });

  it('reports the shortfall', () => {
    try {
      assertWithinOverdraft({
        kind: 'cash',
        allowOverdraft: false,
        lowestBalance: Money.of('-12.5'),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as RuleViolationError).details).toEqual({ shortfall: '12.50' });
    }
  });
});

describe('transaction rules', () => {
  it('ties the direction to the type, except for other', () => {
    for (const type of txnTypes) {
      const implied = typeDirection[type];
      for (const direction of ['in', 'out'] as const) {
        const run = () => assertDirectionMatchesType(type, direction);
        if (implied === null || implied === direction) {
          expect(run).not.toThrow();
        } else {
          expect(run).toThrow(ValidationError);
        }
      }
    }
    expect(accountKinds).toHaveLength(4);
  });

  it('reverses only a plain, unreversed, unreconciled entry with a reason (BR-2, BR-8)', () => {
    const plain = { reversesId: null, reversedById: null, reconciledIn: null };
    expect(() => assertReversible(plain, 'wrong account')).not.toThrow();
    expect(() => assertReversible(plain, '  ')).toThrow(ValidationError);
    expect(() => assertReversible({ ...plain, reversesId: 'x' }, 'r')).toThrow(
      /cannot be reversed/,
    );
    expect(() => assertReversible({ ...plain, reversedById: 'x' }, 'r')).toThrow(/already/);
    expect(() => assertReversible({ ...plain, reconciledIn: 'x' }, 'r')).toThrow(/reconciled/);
  });

  it('summarizes the daily position (BR-9)', () => {
    const position = summarizePosition([
      { accountId: 'a', kind: 'cash', balance: '100.00', movementIn: '10.00', movementOut: '0.00' },
      {
        accountId: 'b',
        kind: 'petty_cash',
        balance: '5.00',
        movementIn: '0.00',
        movementOut: '1.00',
      },
      { accountId: 'c', kind: 'bank', balance: '1000.00', movementIn: '0.00', movementOut: '2.00' },
      { accountId: 'd', kind: 'wallet', balance: '-1.00', movementIn: '0.00', movementOut: '0.00' },
    ]);
    expect(position).toEqual({
      totalCash: '105.00',
      totalBank: '999.00',
      total: '1104.00',
      movementIn: '10.00',
      movementOut: '3.00',
    });
  });
});

describe('statement import (BR-8)', () => {
  const header = 'Date,Description,Debit,Credit';
  it('reads both date formats, quotes and thousands separators', () => {
    const lines = parseStatementCsv(
      `${header}\r\n2026-11-03,"Cheque, 0042","1,250.50",\n05/11/2026,Deposit,,"2,000.00"\n\n`,
    );
    expect(lines).toEqual([
      { lineDate: '2026-11-03', description: 'Cheque, 0042', debit: '1250.50', credit: '0.00' },
      { lineDate: '2026-11-05', description: 'Deposit', debit: '0.00', credit: '2000.00' },
    ]);
    expect(parseStatementCsv(`${header}\n2026-11-03,"say ""hi""",5,`)[0]?.description).toBe(
      'say "hi"',
    );
  });

  it.each([
    ['', 'statement_header_invalid'],
    ['a,b,c,d\n2026-11-03,x,1,', 'statement_header_invalid'],
    [header, 'statement_empty'],
    [`${header}\n2026-11-03,x,1`, 'statement_row_invalid'],
    [`${header}\n2026-02-30,x,1,`, 'statement_date_invalid'],
    [`${header}\nsoon,x,1,`, 'statement_date_invalid'],
    [`${header}\n2026-11-03,x,abc,`, 'statement_amount_invalid'],
    [`${header}\n2026-11-03,x,1,2`, 'statement_row_invalid'],
    [`${header}\n2026-11-03,x,,`, 'statement_row_invalid'],
    [`${header}\n2026-11-03,x,0,0`, 'statement_row_invalid'],
  ])('rejects %j with %s', (text, code) => {
    try {
      parseStatementCsv(text);
      expect.unreachable();
    } catch (error) {
      expect((error as ValidationError).code).toBe(code);
    }
  });

  it('reads direction and amount of a line', () => {
    expect(lineDirection({ debit: '0.00', credit: '5.00' })).toBe('in');
    expect(lineDirection({ debit: '5.00', credit: '0.00' })).toBe('out');
    expect(lineAmount({ debit: '7.00', credit: '0.00' })).toBe('7.00');
    expect(lineAmount({ debit: '0.00', credit: '9.00' })).toBe('9.00');
  });
});

describe('matching suggestions (BR-8)', () => {
  const line = (id: string, lineDate: string, debit: string, credit: string) => ({
    id,
    lineDate,
    debit,
    credit,
  });
  const txn = (id: string, txnDate: string, direction: 'in' | 'out', amount: string) => ({
    id,
    txnDate,
    direction,
    amount,
  });

  it('matches by amount, direction and date proximity, the closest date first', () => {
    const result = suggestMatches(
      [line('l1', '2026-11-10', '0.00', '500.00'), line('l2', '2026-11-10', '40.00', '0.00')],
      [
        txn('far', '2026-11-05', 'in', '500.00'),
        txn('near', '2026-11-09', 'in', '500.00'),
        txn('wrong-way', '2026-11-10', 'in', '40.00'),
        txn('pay', '2026-11-12', 'out', '40.00'),
      ],
    );
    expect(result).toEqual([
      { lineId: 'l1', transactionId: 'near', dayDifference: 1 },
      { lineId: 'l2', transactionId: 'pay', dayDifference: 2 },
    ]);
  });

  it('suggests a transaction once and honours the tolerance and the amount', () => {
    const lines = [
      line('l1', '2026-11-10', '0.00', '10.00'),
      line('l2', '2026-11-10', '0.00', '10.00'),
    ];
    expect(suggestMatches(lines, [txn('t', '2026-11-10', 'in', '10.00')])).toHaveLength(1);
    expect(suggestMatches(lines, [txn('t', '2026-11-14', 'in', '10.00')])).toHaveLength(0);
    expect(suggestMatches(lines, [txn('t', '2026-11-14', 'in', '10.00')], 4)).toHaveLength(1);
    expect(suggestMatches(lines, [txn('t', '2026-11-10', 'in', '10.01')])).toHaveLength(0);
  });

  it('keeps the first of two equally close transactions', () => {
    const result = suggestMatches(
      [line('l', '2026-11-10', '0.00', '10.00')],
      [txn('a', '2026-11-09', 'in', '10.00'), txn('b', '2026-11-11', 'in', '10.00')],
    );
    expect(result[0]?.transactionId).toBe('a');
  });
});

describe('completion rule (BR-8)', () => {
  const base = {
    statementClosingBalance: '10000.00',
    bookBalance: '10000.00',
    unreconciledBook: [],
    unreconciledStatement: [],
  };
  it('is zero when everything is matched', () => {
    const figures = reconciliationFigures(base);
    expect(figures.difference).toBe('0.00');
    expect(() => assertCanComplete(figures)).not.toThrow();
  });

  it('worked example: a cheque issued but not cleared and a bank charge not yet booked', () => {
    // Books: 10,000. A 1,500 cheque is in the books but not on the statement (out, -1,500).
    // The bank charged 200, on the statement but not in the books (debit, -200).
    // Statement closing = 10,000 - (-1,500) + (-200) = 11,300.
    const figures = reconciliationFigures({
      statementClosingBalance: '11300.00',
      bookBalance: '10000.00',
      unreconciledBook: [{ direction: 'out', amount: '1500.00' }],
      unreconciledStatement: [{ debit: '200.00', credit: '0.00' }],
    });
    expect(figures).toEqual({
      bookUnreconciled: '-1500.00',
      statementUnreconciled: '-200.00',
      expectedClosing: '11300.00',
      difference: '0.00',
    });
  });

  it('worked example: a deposit in transit and a direct bank credit, with a difference left', () => {
    // Books 8,000. A 700 receipt is booked but not yet banked (in, +700).
    // The bank credited 300 that the books lack (credit, +300).
    // Expected statement closing = 8,000 - 700 + 300 = 7,600; the statement says 7,650.
    const figures = reconciliationFigures({
      statementClosingBalance: '7650.00',
      bookBalance: '8000.00',
      unreconciledBook: [{ direction: 'in', amount: '700.00' }],
      unreconciledStatement: [{ debit: '0.00', credit: '300.00' }],
    });
    expect(figures.expectedClosing).toBe('7600.00');
    expect(figures.difference).toBe('50.00');
    try {
      assertCanComplete(figures);
      expect.unreachable();
    } catch (error) {
      expect((error as RuleViolationError).details).toEqual({ difference: '50.00' });
    }
  });

  it('allows draft to completed and back, nothing else', () => {
    for (const from of reconciliationStatuses) {
      for (const to of reconciliationStatuses) {
        const run = () => assertReconciliationTransition(from, to);
        if (reconciliationTransitions[from].includes(to)) {
          expect(run).not.toThrow();
        } else {
          expect(run).toThrow(RuleViolationError);
        }
      }
    }
  });
});

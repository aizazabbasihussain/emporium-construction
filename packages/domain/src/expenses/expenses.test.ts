import { describe, expect, it } from 'vitest';
import {
  advanceStatuses,
  assertAdvanceIssued,
  assertClaimEditable,
  assertClaimTransition,
  assertDuplicatesAcknowledged,
  assertReceipts,
  claimStatuses,
  claimTotal,
  claimTransitions,
  costKey,
  custodianBalance,
  findDuplicates,
  isBalanceZero,
  nonNegativeAmount,
  normalizeClaimLines,
  positiveAmount,
  settlementNote,
  type CategoryRule,
  type ClaimLine,
  type ClaimLineInput,
  type ClaimStatus,
} from './index.js';

const input = (over: Partial<ClaimLineInput> = {}): ClaimLineInput => ({
  expenseDate: '2026-10-20',
  category: 'transport',
  description: 'Van to site',
  costObjectType: 'project',
  costObjectId: 'project-1',
  costCodeId: 'code-500',
  amount: '1500',
  ...over,
});

const line = (over: Partial<ClaimLine> = {}): ClaimLine => ({
  lineNo: 1,
  expenseDate: '2026-10-20',
  category: 'transport',
  description: 'Van to site',
  costObjectType: 'project',
  costObjectId: 'project-1',
  costCodeId: 'code-500',
  amount: '1500.00',
  receiptFileId: null,
  ...over,
});

describe('claim status machine', () => {
  const allowed = new Set(
    claimStatuses.flatMap((from) => claimTransitions[from].map((to) => `${from}>${to}`)),
  );

  it.each(claimStatuses.flatMap((from) => claimStatuses.map((to) => [from, to] as const)))(
    '%s to %s',
    (from, to) => {
      if (allowed.has(`${from}>${to}`)) {
        expect(() => assertClaimTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertClaimTransition(from, to)).toThrow(/cannot go from/);
      }
    },
  );

  it('lists exactly the transitions of the spec', () => {
    expect([...allowed].sort()).toEqual(
      [
        'draft>submitted',
        'draft>cancelled',
        'submitted>approved',
        'submitted>rejected',
        'submitted>returned',
        'submitted>cancelled',
        'approved>posted',
        'approved>cancelled',
        'returned>submitted',
        'returned>cancelled',
        'posted>cancelled',
      ].sort(),
    );
  });

  it('edits only drafts and returned claims', () => {
    for (const status of claimStatuses) {
      const editable = status === 'draft' || status === 'returned';
      if (editable) expect(() => assertClaimEditable(status)).not.toThrow();
      else expect(() => assertClaimEditable(status)).toThrow(/Only a draft or returned/);
    }
  });

  it('settles only issued advances', () => {
    for (const status of advanceStatuses) {
      if (status === 'issued') expect(() => assertAdvanceIssued(status)).not.toThrow();
      else expect(() => assertAdvanceIssued(status)).toThrow(/Only an issued advance/);
    }
  });
});

describe('amounts', () => {
  it('accepts positive amounts with at most two decimals', () => {
    expect(positiveAmount(' 12.5 ', 'amount')).toBe('12.50');
    expect(positiveAmount('0.01', 'amount')).toBe('0.01');
  });

  it.each(['0', '0.00', '-1', '1.234', 'abc', '', '1e3'])('rejects %s', (text) => {
    expect(() => positiveAmount(text, 'amount')).toThrow();
  });

  it('distinguishes a malformed amount from a zero one', () => {
    expect(() => positiveAmount('0', 'amount')).toThrow(/greater than zero/);
    expect(() => positiveAmount('x', 'amount')).toThrow(/at most two decimals/);
  });

  it('allows zero where a threshold is meant', () => {
    expect(nonNegativeAmount('0', 'limit')).toBe('0.00');
    expect(nonNegativeAmount('2500.5', 'limit')).toBe('2500.50');
    expect(() => nonNegativeAmount('-1', 'limit')).toThrow(/at most two decimals/);
  });
});

describe('normalizeClaimLines (BR-2)', () => {
  it('numbers and cleans the lines', () => {
    const lines = normalizeClaimLines([
      input({ description: '  Van  ' }),
      input({ costObjectType: 'overhead', costObjectId: null, amount: '20.5' }),
    ]);
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ description: 'Van', amount: '1500.00', receiptFileId: null });
    expect(lines[1]).toMatchObject({ costObjectId: null, amount: '20.50' });
  });

  it('keeps a receipt reference', () => {
    expect(normalizeClaimLines([input({ receiptFileId: 'file-1' })])[0]?.receiptFileId).toBe(
      'file-1',
    );
  });

  it.each([
    ['no lines', [], 'lines_required'],
    ['no category', [input({ category: ' ' })], 'category_required'],
    ['no description', [input({ description: ' ' })], 'description_required'],
    ['a project line without a project', [input({ costObjectId: null })], 'project_required'],
    [
      'an overhead line with a project',
      [input({ costObjectType: 'overhead' })],
      'overhead_has_no_project',
    ],
    ['a zero amount', [input({ amount: '0' })], 'amount_not_positive'],
    ['a bad date', [input({ expenseDate: '20/10/2026' })], 'invalid_date'],
  ])('rejects %s', (_name, lines, code) => {
    expect(() => normalizeClaimLines(lines)).toThrow(expect.objectContaining({ code }));
  });
});

describe('claimTotal (BR-4)', () => {
  it('sums the lines exactly', () => {
    expect(claimTotal([{ amount: '0.10' }, { amount: '0.20' }])).toBe('0.30');
    expect(claimTotal([])).toBe('0.00');
  });
});

describe('receipt rule (BR-3)', () => {
  const categories = new Map<string, CategoryRule>([
    ['transport', { code: 'transport', receiptRequired: true, maxWithoutReceipt: '500.00' }],
    ['food', { code: 'food', receiptRequired: false, maxWithoutReceipt: '0.00' }],
  ]);

  it('needs a receipt only above the threshold', () => {
    expect(() => assertReceipts([line({ amount: '500.00' })], categories)).not.toThrow();
    expect(() => assertReceipts([line({ amount: '500.01' })], categories)).toThrow(
      expect.objectContaining({ code: 'receipt_required', details: { lineNos: [1] } }),
    );
  });

  it('accepts a receipt, a category without the rule and an unknown category', () => {
    expect(() =>
      assertReceipts([line({ amount: '900.00', receiptFileId: 'file-1' })], categories),
    ).not.toThrow();
    expect(() =>
      assertReceipts([line({ category: 'food', amount: '900.00' })], categories),
    ).not.toThrow();
    expect(() =>
      assertReceipts([line({ category: 'other', amount: '900.00' })], categories),
    ).not.toThrow();
  });

  it('lists every line that lacks one', () => {
    expect(() =>
      assertReceipts(
        [
          line({ amount: '600.00' }),
          line({ lineNo: 2, amount: '10.00' }),
          line({ lineNo: 3, amount: '700.00' }),
        ],
        categories,
      ),
    ).toThrow(expect.objectContaining({ details: { lineNos: [1, 3] } }));
  });
});

describe('duplicate guard (BR-9)', () => {
  const prior = {
    claimNumber: 'EXP-2026-0001',
    lineNo: 2,
    expenseDate: '2026-10-15',
    category: 'transport',
    amount: '1500.00',
  };

  it('matches the same category and amount within seven days, either side', () => {
    expect(findDuplicates([line({ expenseDate: '2026-10-22' })], [prior])).toEqual([
      { lineNo: 1, matchedClaimNumber: 'EXP-2026-0001', matchedLineNo: 2 },
    ]);
    expect(findDuplicates([line({ expenseDate: '2026-10-08' })], [prior])).toHaveLength(1);
  });

  it('does not match beyond seven days or on another amount or category', () => {
    expect(findDuplicates([line({ expenseDate: '2026-10-23' })], [prior])).toEqual([]);
    expect(findDuplicates([line({ expenseDate: '2026-10-07' })], [prior])).toEqual([]);
    expect(
      findDuplicates([line({ expenseDate: '2026-10-15', amount: '1500.01' })], [prior]),
    ).toEqual([]);
    expect(
      findDuplicates([line({ expenseDate: '2026-10-15', category: 'food' })], [prior]),
    ).toEqual([]);
  });

  it('compares amounts as numbers', () => {
    expect(
      findDuplicates([line({ expenseDate: '2026-10-15', amount: '1500' })], [prior]),
    ).toHaveLength(1);
  });

  it('finds a repeat inside the same claim and reports the earlier line', () => {
    const lines = [
      line(),
      line({ lineNo: 2, expenseDate: '2026-10-21' }),
      line({ lineNo: 3, amount: '9.00' }),
    ];
    expect(findDuplicates(lines, [])).toEqual([
      { lineNo: 2, matchedClaimNumber: null, matchedLineNo: 1 },
    ]);
  });

  it('prefers the match inside the claim over an earlier claim', () => {
    const lines = [line(), line({ lineNo: 2 })];
    expect(findDuplicates(lines, [{ ...prior, expenseDate: '2026-10-20' }])[0]).toEqual({
      lineNo: 1,
      matchedClaimNumber: 'EXP-2026-0001',
      matchedLineNo: 2,
    });
    expect(findDuplicates(lines, [{ ...prior, expenseDate: '2026-10-20' }])[1]).toEqual({
      lineNo: 2,
      matchedClaimNumber: null,
      matchedLineNo: 1,
    });
  });

  it('blocks a submit until the warning is acknowledged', () => {
    const duplicates = [{ lineNo: 1, matchedClaimNumber: null, matchedLineNo: 2 }];
    expect(() => assertDuplicatesAcknowledged(duplicates, false)).toThrow(
      expect.objectContaining({ code: 'duplicate_expense_warning' }),
    );
    expect(() => assertDuplicatesAcknowledged(duplicates, true)).not.toThrow();
    expect(() => assertDuplicatesAcknowledged([], false)).not.toThrow();
  });
});

describe('custodianBalance (BR-1)', () => {
  const claim = (status: ClaimStatus, total = '100.00') => ({ status, total });

  it('counts approved and posted claims only', () => {
    const advances = [{ amount: '1000.00', status: 'issued' as const }];
    for (const status of claimStatuses) {
      const counted = status === 'approved' || status === 'posted';
      expect(custodianBalance(advances, [claim(status)]), status).toBe(
        counted ? '900.00' : '1000.00',
      );
    }
  });

  it('counts issued and settled advances but not cancelled ones', () => {
    const balance = (status: (typeof advanceStatuses)[number]) =>
      custodianBalance([{ amount: '500.00', status }], []);
    expect(balance('issued')).toBe('500.00');
    expect(balance('settled')).toBe('500.00');
    expect(balance('cancelled')).toBe('0.00');
  });

  it('goes negative when claims exceed the advances', () => {
    expect(
      custodianBalance([{ amount: '100.00', status: 'issued' }], [claim('posted', '250.50')]),
    ).toBe('-150.50');
    expect(custodianBalance([], [])).toBe('0.00');
  });
});

describe('settlement (BR-8)', () => {
  it('recognises a zero balance', () => {
    expect(isBalanceZero('0.00')).toBe(true);
    expect(isBalanceZero('-0.00')).toBe(true);
    expect(isBalanceZero('0.01')).toBe(false);
  });

  it('asks for a note unless the balance is zero', () => {
    expect(settlementNote('0.00', undefined)).toBeNull();
    expect(settlementNote('0.00', '  ')).toBeNull();
    expect(settlementNote('0.00', ' done ')).toBe('done');
    expect(settlementNote('12.00', 'Returned cash')).toBe('Returned cash');
    expect(() => settlementNote('12.00', ' ')).toThrow(
      expect.objectContaining({ code: 'note_required' }),
    );
    expect(() => settlementNote('-5.00', null)).toThrow(/note/);
  });
});

describe('costKey (BR-5)', () => {
  it('prefixes the line id', () => {
    expect(costKey('abc')).toBe('exp:abc');
  });
});

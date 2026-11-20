import { describe, expect, it } from 'vitest';
import {
  ageItems,
  assertChequeDetails,
  assertDepositable,
  assertWriteOffAllowed,
  bucketIndex,
  bucketLabels,
  checkWithholding,
  daysPastDue,
  invoiceOutstanding,
  isReminderTime,
  isUpcoming,
  nextPdcStatus,
  parseBuckets,
  pdcActions,
  pdcStatuses,
  pdcTransitions,
  suggestAllocation,
  validateAllocations,
} from './index.js';

const room = (entries: [string, string][]) => new Map(entries);

describe('PDC state machine (BR-6, T-3)', () => {
  it('allows exactly the listed transitions and refuses every other pair', () => {
    for (const from of pdcStatuses) {
      for (const action of pdcActions) {
        const expected = pdcTransitions[from][action];
        if (expected === undefined) {
          expect(() => nextPdcStatus(from, action)).toThrow(/cannot be moved/);
        } else {
          expect(nextPdcStatus(from, action)).toBe(expected);
        }
      }
    }
  });

  it('ends the life of a returned or replaced cheque; a cleared one can only bounce', () => {
    for (const status of ['returned', 'replaced'] as const) {
      expect(pdcTransitions[status]).toEqual({});
    }
    expect(pdcTransitions.cleared).toEqual({ bounce: 'bounced' });
  });

  it('deposits on or after the cheque date without a reason', () => {
    expect(assertDepositable('2026-11-18', '2026-11-18', undefined)).toBeNull();
    expect(assertDepositable('2026-11-10', '2026-11-18', undefined)).toBeNull();
  });

  it('needs a reason to deposit before the cheque date', () => {
    expect(() => assertDepositable('2026-11-19', '2026-11-18', undefined)).toThrow(
      /needs a reason/,
    );
    expect(() => assertDepositable('2026-11-19', '2026-11-18', '  ')).toThrow(/needs a reason/);
    expect(assertDepositable('2026-11-19', '2026-11-18', ' client asked ')).toBe('client asked');
  });

  it('requires the cheque details', () => {
    const ok = { chequeNumber: '123', bankName: 'HBL', chequeDate: '2026-11-20' };
    expect(() => assertChequeDetails(ok)).not.toThrow();
    expect(() => assertChequeDetails({ ...ok, chequeNumber: ' ' })).toThrow(/Cheque number/);
    expect(() => assertChequeDetails({ ...ok, bankName: undefined })).toThrow(/Cheque number/);
    expect(() => assertChequeDetails({ ...ok, chequeNumber: undefined })).toThrow(/Cheque number/);
    expect(() => assertChequeDetails({ ...ok, chequeDate: undefined })).toThrow(/cheque date/);
  });

  it('reminds from 09:00 Karachi and lists the next seven days (BR-7, T-8)', () => {
    expect(isReminderTime(new Date('2026-11-18T03:59:00Z'))).toBe(false);
    expect(isReminderTime(new Date('2026-11-18T04:00:00Z'))).toBe(true);
    expect(isUpcoming('2026-11-18', '2026-11-18', '2026-11-25')).toBe(true);
    expect(isUpcoming('2026-11-25', '2026-11-18', '2026-11-25')).toBe(true);
    expect(isUpcoming('2026-11-26', '2026-11-18', '2026-11-25')).toBe(false);
    expect(isUpcoming('2026-11-17', '2026-11-18', '2026-11-25')).toBe(false);
  });
});

describe('allocation (BR-3, T-2)', () => {
  const lines = [
    { kind: 'invoice' as const, invoiceId: 'a', amount: '700.00' },
    { kind: 'withholding' as const, invoiceId: 'a', amount: '50.00' },
    { kind: 'invoice' as const, invoiceId: 'b', amount: '300.00' },
  ];

  it('accepts allocations that add up to the receipt plus the withheld amount', () => {
    expect(() =>
      validateAllocations({
        receiptAmount: '1000',
        withheldAmount: '50',
        allocations: lines,
        allocatable: room([
          ['a', '750.00'],
          ['b', '300.00'],
        ]),
      }),
    ).not.toThrow();
  });

  it('refuses a wrong total, a wrong withholding total and over-allocation', () => {
    const base = {
      receiptAmount: '1000',
      withheldAmount: '50',
      allocations: lines,
      allocatable: room([
        ['a', '750.00'],
        ['b', '300.00'],
      ]),
    };
    expect(() => validateAllocations({ ...base, receiptAmount: '999' })).toThrow(
      /Allocations total/,
    );
    expect(() =>
      validateAllocations({
        ...base,
        allocations: [
          { kind: 'invoice', invoiceId: 'a', amount: '750.00' },
          { kind: 'invoice', invoiceId: 'b', amount: '300.00' },
        ],
      }),
    ).toThrow(/Withholding allocations/);
    expect(() =>
      validateAllocations({
        ...base,
        allocatable: room([
          ['a', '749.99'],
          ['b', '300.00'],
        ]),
      }),
    ).toThrow(/cannot take/);
    expect(() => validateAllocations({ ...base, allocatable: room([['a', '750.00']]) })).toThrow(
      /cannot take/,
    );
  });

  it('refuses bad amounts and an advance without its id', () => {
    const base = {
      receiptAmount: '100',
      withheldAmount: '0',
      allocations: [{ kind: 'invoice' as const, invoiceId: 'a', amount: '100' }],
      allocatable: room([['a', '100']]),
    };
    expect(() => validateAllocations({ ...base, receiptAmount: '0' })).toThrow(/above zero/);
    expect(() => validateAllocations({ ...base, receiptAmount: '-5' })).toThrow(/above zero/);
    expect(() => validateAllocations({ ...base, withheldAmount: '-1' })).toThrow(/negative/);
    expect(() =>
      validateAllocations({
        ...base,
        allocations: [{ kind: 'invoice', invoiceId: 'a', amount: '0' }],
      }),
    ).toThrow(/Each allocation/);
    expect(() =>
      validateAllocations({
        ...base,
        allocations: [{ kind: 'advance', invoiceId: 'a', amount: '100' }],
      }),
    ).toThrow(/names the advance/);
    expect(() =>
      validateAllocations({
        ...base,
        allocations: [{ kind: 'advance', invoiceId: 'a', advanceId: 'x', amount: '100' }],
      }),
    ).not.toThrow();
  });

  it('suggests oldest due first and stops when the money is used (BR-3)', () => {
    const items = [
      { invoiceId: 'c', dueDate: '2026-12-01', allocatable: '500.00' },
      { invoiceId: 'b', dueDate: '2026-10-01', allocatable: '200.00' },
      { invoiceId: 'a', dueDate: '2026-10-01', allocatable: '100.00' },
      { invoiceId: 'z', dueDate: '2026-09-01', allocatable: '0.00' },
    ];
    expect(suggestAllocation('350', items)).toEqual([
      { invoiceId: 'a', amount: '100.00' },
      { invoiceId: 'b', amount: '200.00' },
      { invoiceId: 'c', amount: '50.00' },
    ]);
    expect(suggestAllocation('50', items)).toEqual([{ invoiceId: 'a', amount: '50.00' }]);
    expect(suggestAllocation('1000', items)).toHaveLength(3);
    expect(suggestAllocation('0', items)).toEqual([]);
  });
});

describe('withholding and balances (BR-1, BR-4, BR-11, T-1, T-5)', () => {
  it('flags a difference above the tolerance only', () => {
    expect(checkWithholding('100', '100', '0')).toMatchObject({
      difference: '0.00',
      flagged: false,
    });
    expect(checkWithholding('100', '98', '2')).toMatchObject({
      difference: '-2.00',
      flagged: false,
    });
    expect(checkWithholding('100', '97.99', '2')).toMatchObject({ flagged: true });
    expect(checkWithholding('100', '102.01', '2')).toMatchObject({
      difference: '2.01',
      flagged: true,
    });
  });

  it('computes the outstanding amount of an invoice', () => {
    expect(
      invoiceOutstanding({ gross: '1000', credited: '100', allocated: '600', adjusted: '5' }),
    ).toBe('295.00');
  });

  it('allows a write-off within the limit and the balance only', () => {
    expect(() => assertWriteOffAllowed('50', '50', '100')).not.toThrow();
    expect(() => assertWriteOffAllowed('50', '0', '100')).toThrow(/above zero/);
    expect(() => assertWriteOffAllowed('500', '101', '100')).toThrow(/limited to/);
    expect(() => assertWriteOffAllowed('40', '50', '100')).toThrow(/exceeds the balance/);
  });
});

describe('aging (BR-8, T-4)', () => {
  const bounds = parseBuckets('30, 60,90');

  it('parses and labels the H-30 buckets and refuses bad limits', () => {
    expect(bounds).toEqual([30, 60, 90]);
    expect(bucketLabels(bounds)).toEqual(['current', '0-30', '31-60', '61-90', '90+']);
    for (const bad of ['', 'a', '0', '30,30', '60,30', '1.5']) {
      expect(() => parseBuckets(bad)).toThrow(/rising whole days/);
    }
  });

  it('places the boundary days in the right bucket', () => {
    const at = (days: number) => bucketIndex(days, bounds);
    expect([-5, 0].map(at)).toEqual([0, 0]);
    expect([1, 30].map(at)).toEqual([1, 1]);
    expect([31, 60].map(at)).toEqual([2, 2]);
    expect([61, 90].map(at)).toEqual([3, 3]);
    expect([91, 400].map(at)).toEqual([4, 4]);
    expect(daysPastDue('2026-10-01', '2026-10-31')).toBe(30);
  });

  it('groups outstanding amounts per key and ignores settled items', () => {
    const report = ageItems(
      [
        { key: 'p1', dueDate: '2026-10-31', outstanding: '100.00' },
        { key: 'p1', dueDate: '2026-08-01', outstanding: '40.00' },
        { key: 'p2', dueDate: '2026-12-01', outstanding: '25.00' },
        { key: 'p2', dueDate: '2026-01-01', outstanding: '0.00' },
        { key: 'p2', dueDate: '2026-01-01', outstanding: '-3.00' },
      ],
      '2026-11-30',
      bounds,
    );
    expect(report.labels).toHaveLength(5);
    expect(report.rows).toEqual([
      { key: 'p1', buckets: ['0.00', '100.00', '0.00', '0.00', '40.00'], total: '140.00' },
      { key: 'p2', buckets: ['25.00', '0.00', '0.00', '0.00', '0.00'], total: '25.00' },
    ]);
    expect(report.totals).toEqual(['25.00', '100.00', '0.00', '0.00', '40.00']);
    expect(report.total).toBe('165.00');
  });
});

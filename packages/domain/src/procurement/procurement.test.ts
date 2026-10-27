import { describe, expect, it } from 'vitest';
import {
  addQuantity,
  subQuantity,
  assertGrnTransition,
  assertNotBelowReceived,
  assertPhotoAttached,
  assertPoTransition,
  assertRequisitionTransition,
  assertSelection,
  assertWithinTolerance,
  compareQuotes,
  destinationOf,
  documentNumber,
  grnStatuses,
  grnTransitions,
  isReceivable,
  lineTotal,
  maxAcceptable,
  normalizePoLines,
  normalizeReceiptLines,
  normalizeRequisitionLines,
  orderedStatus,
  purchaseOrderStatuses,
  purchaseOrderTransitions,
  receiptCost,
  receiptStatus,
  remainingCommitment,
  requisitionStatuses,
  requisitionTransitions,
  sumMoney,
} from './index.js';

describe('state machines are exhaustive (constitution 10.4)', () => {
  it('requisition: every pair is allowed exactly as the table says', () => {
    for (const from of requisitionStatuses) {
      for (const to of requisitionStatuses) {
        const allowed = requisitionTransitions[from].includes(to);
        const run = () => assertRequisitionTransition(from, to);
        if (allowed) expect(run).not.toThrow();
        else expect(run, `${from} -> ${to}`).toThrow(/cannot go/);
      }
    }
  });

  it('purchase order: every pair is allowed exactly as the table says', () => {
    for (const from of purchaseOrderStatuses) {
      for (const to of purchaseOrderStatuses) {
        const allowed = purchaseOrderTransitions[from].includes(to);
        const run = () => assertPoTransition(from, to);
        if (allowed) expect(run).not.toThrow();
        else expect(run, `${from} -> ${to}`).toThrow(/cannot go/);
      }
    }
  });

  it('receipt: only posted can be cancelled', () => {
    for (const from of grnStatuses) {
      for (const to of grnStatuses) {
        const run = () => assertGrnTransition(from, to);
        if (grnTransitions[from].includes(to)) expect(run).not.toThrow();
        else expect(run).toThrow(/cannot go/);
      }
    }
  });

  it('only approved and partly received orders can take a receipt', () => {
    expect(purchaseOrderStatuses.filter(isReceivable)).toEqual(['approved', 'partly_received']);
  });
});

describe('lines and totals (BR-3)', () => {
  it('rounds the line total half-up to two decimals', () => {
    expect(lineTotal('3.0000', '0.1250')).toBe('0.38');
    expect(lineTotal('2.0000', '0.1249')).toBe('0.25');
    expect(lineTotal('10.5000', '100.0000')).toBe('1050.00');
  });

  it('the order total is the sum of the rounded line totals', () => {
    const { lines, total } = normalizePoLines([
      { itemId: 'a', quantity: '3', unitCode: ' bag ', rate: '0.125', costCodeId: 'c' },
      {
        itemId: 'b',
        description: ' Steel ',
        quantity: '2',
        unitCode: 'kg',
        rate: '0.125',
        costCodeId: 'c',
        requisitionLineId: 'r1',
      },
    ]);
    expect(lines.map((l) => l.lineTotal)).toEqual(['0.38', '0.25']);
    expect(total).toBe('0.63');
    expect(lines[0]).toMatchObject({
      lineNo: 1,
      unitCode: 'bag',
      requisitionLineId: null,
      description: '',
    });
    expect(lines[1]).toMatchObject({ lineNo: 2, description: 'Steel', requisitionLineId: 'r1' });
  });

  it('rejects empty, zero, malformed and over-precise input', () => {
    const line = { itemId: 'a', quantity: '1', unitCode: 'nos', rate: '1', costCodeId: 'c' };
    expect(() => normalizePoLines([])).toThrow(/at least one line/);
    expect(() => normalizePoLines([{ ...line, quantity: '0' }])).toThrow(/more than zero/);
    expect(() => normalizePoLines([{ ...line, quantity: '1.00001' }])).toThrow(/at most 4/);
    expect(() => normalizePoLines([{ ...line, rate: '-1' }])).toThrow(/rate/);
    expect(() => normalizePoLines([{ ...line, rate: 'abc' }])).toThrow(/rate/);
  });

  it('normalizes requisition lines', () => {
    const lines = normalizeRequisitionLines([
      { itemId: 'a', quantity: '5', unitCode: 'bag', costCodeId: 'c' },
      {
        itemId: 'b',
        description: ' x ',
        quantity: '1.5',
        unitCode: 'kg',
        costCodeId: 'c',
        estimatedRate: '12.5',
      },
      { itemId: 'c', quantity: '1', unitCode: 'kg', costCodeId: 'c', estimatedRate: null },
    ]);
    expect(lines.map((l) => [l.lineNo, l.quantity, l.estimatedRate, l.description])).toEqual([
      [1, '5.0000', null, ''],
      [2, '1.5000', '12.5000', 'x'],
      [3, '1.0000', null, ''],
    ]);
    expect(() => normalizeRequisitionLines([])).toThrow(/at least one/);
    expect(() =>
      normalizeRequisitionLines([
        { itemId: 'a', quantity: '1', unitCode: 'k', costCodeId: 'c', estimatedRate: 'x' },
      ]),
    ).toThrow(/estimated_rate/);
  });

  it('sums money and formats document numbers', () => {
    expect(sumMoney([])).toBe('0.00');
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(documentNumber('REQ', 2026, 7)).toBe('REQ-2026-0007');
  });
});

describe('destination (BR-1)', () => {
  it('needs exactly one of project and store', () => {
    expect(destinationOf({ projectId: 'p' })).toEqual({ type: 'project', id: 'p' });
    expect(destinationOf({ storeId: 's', projectId: null })).toEqual({ type: 'store', id: 's' });
    expect(() => destinationOf({})).toThrow(/either a project or a store/);
    expect(() => destinationOf({ projectId: 'p', storeId: 's' })).toThrow(/either a project/);
  });
});

describe('quote comparison (BR-2)', () => {
  const lines = [
    { id: 'l1', quantity: '10' },
    { id: 'l2', quantity: '5' },
  ];
  const quotes = [
    {
      quoteId: 'qa',
      rates: new Map([
        ['l1', '10.0000'],
        ['l2', '20.0000'],
      ]),
    },
    {
      quoteId: 'qb',
      rates: new Map([
        ['l1', '9.0000'],
        ['l2', '25.0000'],
      ]),
    },
    { quoteId: 'qc', rates: new Map([['l1', '5.0000']]) },
    {
      quoteId: 'qd',
      rates: new Map([
        ['l1', '10.0000'],
        ['l2', '20.0000'],
      ]),
    },
  ];

  it('ranks by line rate and by total, complete quotes first, ties by id', () => {
    const { byLine, totals } = compareQuotes(lines, quotes);
    expect(byLine.get('l1')?.map((e) => [e.quoteId, e.rank])).toEqual([
      ['qc', 1],
      ['qb', 2],
      ['qa', 3],
      ['qd', 4],
    ]);
    expect(byLine.get('l2')?.map((e) => e.quoteId)).toEqual(['qa', 'qd', 'qb']);
    expect(totals).toEqual([
      { quoteId: 'qa', total: '200.00', complete: true, rank: 1 },
      { quoteId: 'qd', total: '200.00', complete: true, rank: 2 },
      { quoteId: 'qb', total: '215.00', complete: true, rank: 3 },
      { quoteId: 'qc', total: '50.00', complete: false, rank: 4 },
    ]);
  });

  it('a vendor that is not the lowest rate needs a written reason', () => {
    const ranking = [
      { quoteId: 'qc', rate: '5.0000' },
      { quoteId: 'qe', rate: '5.0000' },
      { quoteId: 'qa', rate: '10.0000' },
    ];
    expect(() => assertSelection(ranking, 'qc', null)).not.toThrow();
    expect(() => assertSelection(ranking, 'qe', undefined)).not.toThrow();
    expect(() => assertSelection(ranking, 'qa', '   ')).toThrow(/written reason/);
    expect(() => assertSelection(ranking, 'qa', undefined)).toThrow(/written reason/);
    expect(() => assertSelection(ranking, 'qa', 'Closer to site')).not.toThrow();
    expect(() => assertSelection(ranking, 'zz', 'x')).toThrow(/no rate/);
  });
});

describe('receipt quantities (BR-6)', () => {
  it('allows the remaining quantity at 0% tolerance and nothing more', () => {
    expect(maxAcceptable('100', '40', '0')).toBe('60.0000');
    expect(() => assertWithinTolerance('60', '100', '40', '0')).not.toThrow();
    expect(() => assertWithinTolerance('60.0001', '100', '40', '0')).toThrow(/more than the order/);
  });

  it('adds the tolerance as a percent of the ordered quantity', () => {
    expect(maxAcceptable('100', '40', '5')).toBe('65.0000');
    expect(() => assertWithinTolerance('65', '100', '40', '5')).not.toThrow();
    expect(() => assertWithinTolerance('65.0001', '100', '40', '5')).toThrow();
  });

  it('never allows a negative amount', () => {
    expect(maxAcceptable('100', '120', '0')).toBe('0.0000');
  });

  it('normalizes receipt lines', () => {
    const lines = normalizeReceiptLines([
      { poLineId: 'a', acceptedQty: '5' },
      { poLineId: 'b', acceptedQty: '0', rejectedQty: '2', note: ' cracked ' },
    ]);
    expect(lines).toEqual([
      { poLineId: 'a', acceptedQty: '5.0000', rejectedQty: '0.0000', note: '' },
      { poLineId: 'b', acceptedQty: '0.0000', rejectedQty: '2.0000', note: 'cracked' },
    ]);
    expect(() => normalizeReceiptLines([])).toThrow(/at least one line/);
    expect(() => normalizeReceiptLines([{ poLineId: 'a', acceptedQty: '0' }])).toThrow(
      /at least one line/,
    );
    expect(() =>
      normalizeReceiptLines([
        { poLineId: 'a', acceptedQty: '1' },
        { poLineId: 'a', acceptedQty: '1' },
      ]),
    ).toThrow(/only once/);
    expect(() => normalizeReceiptLines([{ poLineId: 'a', acceptedQty: '-1' }])).toThrow(
      /accepted_qty/,
    );
  });

  it('costs the accepted quantity at the order rate and keeps the rest committed', () => {
    expect(receiptCost('3', '0.125')).toBe('0.38');
    expect(remainingCommitment('1000.00', '400.00')).toBe('600.00');
    expect(remainingCommitment('1000.00', '1050.00')).toBe('0.00');
  });

  it('needs a photo only when the setting says so', () => {
    expect(() => assertPhotoAttached(true, 0)).toThrow(/photo/);
    expect(() => assertPhotoAttached(true, 1)).not.toThrow();
    expect(() => assertPhotoAttached(false, 0)).not.toThrow();
  });
});

describe('order and requisition status from quantities', () => {
  it('derives the receipt status of an approved order', () => {
    expect(receiptStatus([{ quantity: '10', receivedQty: '0' }])).toBe('approved');
    expect(
      receiptStatus([
        { quantity: '10', receivedQty: '4' },
        { quantity: '5', receivedQty: '5' },
      ]),
    ).toBe('partly_received');
    expect(
      receiptStatus([
        { quantity: '10', receivedQty: '10' },
        { quantity: '5', receivedQty: '6' },
      ]),
    ).toBe('received');
  });

  it('derives the ordered status of an approved requisition', () => {
    expect(orderedStatus([{ quantity: '10', ordered: '0' }])).toBe('approved');
    expect(
      orderedStatus([
        { quantity: '10', ordered: '10' },
        { quantity: '5', ordered: '1' },
      ]),
    ).toBe('partly_ordered');
    expect(
      orderedStatus([
        { quantity: '10', ordered: '10' },
        { quantity: '5', ordered: '5' },
      ]),
    ).toBe('ordered');
  });

  it('an amended line cannot go below what was received (BR-5)', () => {
    expect(() => assertNotBelowReceived('10', '10')).not.toThrow();
    expect(() => assertNotBelowReceived('9.9999', '10')).toThrow(/less than was already received/);
  });
});

describe('quantity arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addQuantity('0.1000', '0.2000')).toBe('0.3000');
    expect(subQuantity('1.0000', '0.0001')).toBe('0.9999');
  });
});

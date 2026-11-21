import { describe, expect, it } from 'vitest';
import {
  allocatePayment,
  assertBillTransition,
  assertPaymentTransition,
  billFigures,
  billStatusAfterPayments,
  billTransitions,
  chequeIsPostDated,
  coveredQuantity,
  exceedsCommitments,
  groupByVendor,
  lineAmount,
  lineVariance,
  matchLine,
  openQuantity,
  paymentTransitions,
  varianceTreatment,
  vendorBalance,
  withholdingMonth,
  type BillStatus,
  type PaymentStatus,
} from './index.js';

const billStates = Object.keys(billTransitions) as BillStatus[];
const paymentStates = Object.keys(paymentTransitions) as PaymentStatus[];

describe('bill and payment state machines (constitution 5.8, T-4)', () => {
  it('allows exactly the listed bill transitions and refuses every other pair', () => {
    for (const from of billStates) {
      for (const to of billStates) {
        if (billTransitions[from].includes(to)) {
          expect(() => assertBillTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertBillTransition(from, to)).toThrow(/cannot become/);
        }
      }
    }
  });

  it('allows exactly the listed payment transitions and refuses every other pair', () => {
    for (const from of paymentStates) {
      for (const to of paymentStates) {
        if (paymentTransitions[from].includes(to)) {
          expect(() => assertPaymentTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertPaymentTransition(from, to)).toThrow(/cannot become/);
        }
      }
    }
  });

  it('derives the status of a posted bill from what is allocated (BR-7)', () => {
    expect(billStatusAfterPayments('1000.00', '0.00')).toBe('posted');
    expect(billStatusAfterPayments('1000.00', '-5.00')).toBe('posted');
    expect(billStatusAfterPayments('1000.00', '400.00')).toBe('partly_paid');
    expect(billStatusAfterPayments('1000.00', '1000.00')).toBe('paid');
  });
});

describe('three-way match (BR-1, T-1)', () => {
  const base = {
    poRate: '100.0000',
    receivedQty: '10.0000',
    billedBefore: '0.0000',
    billedQty: '10.0000',
    billedRate: '100.0000',
    qtyTolerancePercent: '0',
    rateTolerancePercent: '0',
  };

  it('computes line amounts half-up and refuses malformed numbers', () => {
    expect(lineAmount('10.5', '99.9999')).toBe('1050.00');
    expect(lineAmount('10.5', '99.9995')).toBe('1049.99');
    expect(lineAmount('3', '0.3333')).toBe('1.00');
    expect(() => lineAmount('x', '1')).toThrow(/valid decimal/);
  });

  it('matches a bill at the order rate for the received quantity', () => {
    const result = matchLine(base);
    expect(result).toMatchObject({ qtyVariance: '0.0000', rateVariance: '0.0000' });
    expect(result.withinTolerance).toBe(true);
  });

  it('flags a bill above the order rate when the tolerance is zero', () => {
    const result = matchLine({ ...base, billedRate: '105.0000' });
    expect(result.rateVariance).toBe('5.0000');
    expect(result.withinTolerance).toBe(false);
  });

  it('accepts a rate difference within the percentage tolerance, in either direction', () => {
    expect(
      matchLine({ ...base, billedRate: '102.0000', rateTolerancePercent: '2' }).withinTolerance,
    ).toBe(true);
    expect(
      matchLine({ ...base, billedRate: '98.0000', rateTolerancePercent: '2' }).withinTolerance,
    ).toBe(true);
    expect(
      matchLine({ ...base, billedRate: '97.0000', rateTolerancePercent: '2' }).withinTolerance,
    ).toBe(false);
  });

  it('counts partial billing across several bills against what is still open', () => {
    const second = matchLine({ ...base, billedBefore: '6.0000', billedQty: '4.0000' });
    expect(second.qtyVariance).toBe('0.0000');
    expect(second.withinTolerance).toBe(true);
    const third = matchLine({ ...base, billedBefore: '6.0000', billedQty: '5.0000' });
    expect(third.qtyVariance).toBe('1.0000');
    expect(third.withinTolerance).toBe(false);
  });

  it('flags over-billing beyond what was received, with a quantity tolerance', () => {
    expect(matchLine({ ...base, billedQty: '12.0000' }).qtyVariance).toBe('2.0000');
    expect(
      matchLine({ ...base, billedQty: '10.5000', qtyTolerancePercent: '5' }).withinTolerance,
    ).toBe(true);
    expect(
      matchLine({ ...base, billedQty: '10.6000', qtyTolerancePercent: '5' }).withinTolerance,
    ).toBe(false);
  });

  it('never reports a negative open quantity', () => {
    expect(openQuantity('5', '8')).toBe('0.0000');
    expect(openQuantity('5', '2')).toBe('3.0000');
  });
});

describe('price variance (BR-5)', () => {
  it('is the billed amount less the covered quantity at the order rate', () => {
    expect(lineVariance({ billedAmount: '1050.00', coveredQty: '10', poRate: '100' })).toBe(
      '50.00',
    );
    expect(lineVariance({ billedAmount: '950.00', coveredQty: '10', poRate: '100' })).toBe(
      '-50.00',
    );
  });

  it('puts the quantity beyond the receipt entirely into the variance', () => {
    expect(coveredQuantity('12', '2')).toBe('10.0000');
    expect(lineVariance({ billedAmount: '1200.00', coveredQty: '10', poRate: '100' })).toBe(
      '200.00',
    );
  });

  it('warns when a bill is worth more than the receipts it covers plus the open orders', () => {
    const base = { billBase: '1000.00', coveredValue: '600.00', openOrderValue: '400.00' };
    expect(exceedsCommitments(base)).toBe(false);
    expect(exceedsCommitments({ ...base, billBase: '1000.01' })).toBe(true);
  });

  it('charges the project for direct-to-site or issued goods and overhead for goods in stock', () => {
    expect(varianceTreatment({ destination: 'project', issued: false })).toBe('project_cost');
    expect(varianceTreatment({ destination: 'store', issued: true })).toBe('project_cost');
    expect(varianceTreatment({ destination: 'store', issued: false })).toBe('overhead_cost');
  });
});

describe('bill figures and balances (BR-4, BR-9)', () => {
  it('nets the withholding off the gross total', () => {
    expect(billFigures({ gross: '1180.00', withholdingTotal: '80.00' })).toEqual({
      gross: '1180.00',
      withholdingTotal: '80.00',
      netPayable: '1100.00',
    });
  });

  it('refuses withholding that is negative or above the gross', () => {
    expect(() => billFigures({ gross: '100', withholdingTotal: '-1' })).toThrow(/Withholding/);
    expect(() => billFigures({ gross: '100', withholdingTotal: '100.01' })).toThrow(/Withholding/);
  });

  it('shows net payable and withholding payable apart and the balance after payments', () => {
    expect(
      vendorBalance({
        bills: [
          { netPayable: '920.00', withholdingTotal: '80.00' },
          { netPayable: '500.00', withholdingTotal: '0.00' },
        ],
        allocated: ['1000.00', '100.00'],
      }),
    ).toEqual({
      netPayable: '1420.00',
      withholdingPayable: '80.00',
      payments: '1100.00',
      balance: '400.00',
    });
    expect(vendorBalance({ bills: [], allocated: [] }).balance).toBe('0.00');
  });

  it('groups bills by vendor in first-seen order (BR-11)', () => {
    const grouped = groupByVendor([
      { id: 'a', vendorPartyId: 'v1' },
      { id: 'b', vendorPartyId: 'v2' },
      { id: 'c', vendorPartyId: 'v1' },
    ]);
    expect(grouped.map((g) => [g.vendorPartyId, g.bills.map((b) => b.id)])).toEqual([
      ['v1', ['a', 'c']],
      ['v2', ['b']],
    ]);
  });

  it('reports the month of a deduction and recognises a post-dated cheque (BR-7, BR-8)', () => {
    expect(withholdingMonth('2026-11-18')).toBe('2026-11');
    expect(chequeIsPostDated('cheque', '2026-12-01', '2026-11-18')).toBe(true);
    expect(chequeIsPostDated('cheque', '2026-11-18', '2026-11-18')).toBe(false);
    expect(chequeIsPostDated('cheque', null, '2026-11-18')).toBe(false);
    expect(chequeIsPostDated('cash', '2026-12-01', '2026-11-18')).toBe(false);
  });
});

describe('payment allocation (BR-7, T-5)', () => {
  const bill = (over: Partial<Parameters<typeof allocatePayment>[1][number]> = {}) => ({
    billId: 'b1',
    gross: '1000.00',
    withholdingTotal: '80.00',
    allocated: '0.00',
    withheld: '0.00',
    ...over,
  });

  it('settles a bill in full: the cash is the gross less the whole withholding', () => {
    expect(allocatePayment([{ billId: 'b1', amount: '1000.00' }], [bill()])).toEqual({
      lines: [{ billId: 'b1', amount: '1000.00', withholding: '80.00' }],
      withholdingDeducted: '80.00',
      amount: '920.00',
    });
  });

  it('takes the proportional withholding on a partial payment and the rest on the last one', () => {
    const first = allocatePayment([{ billId: 'b1', amount: '250.00' }], [bill()]);
    expect(first.lines[0]?.withholding).toBe('20.00');
    expect(first.amount).toBe('230.00');
    const last = allocatePayment(
      [{ billId: 'b1', amount: '750.00' }],
      [bill({ allocated: '250.00', withheld: '20.00' })],
    );
    expect(last.lines[0]?.withholding).toBe('60.00');
    expect(last.amount).toBe('690.00');
  });

  it('never deducts more withholding than the bill still has', () => {
    const result = allocatePayment(
      [{ billId: 'b1', amount: '500.00' }],
      [bill({ allocated: '100.00', withheld: '78.00' })],
    );
    expect(result.lines[0]?.withholding).toBe('2.00');
  });

  it('allocates one payment across several bills', () => {
    const result = allocatePayment(
      [
        { billId: 'b1', amount: '1000.00' },
        { billId: 'b2', amount: '300.00' },
      ],
      [bill(), bill({ billId: 'b2', gross: '300.00', withholdingTotal: '0.00' })],
    );
    expect(result.amount).toBe('1220.00');
    expect(result.withholdingDeducted).toBe('80.00');
  });

  it('refuses empty, non-positive, repeated, unknown and over-allocations', () => {
    expect(() => allocatePayment([], [bill()])).toThrow(/at least one/);
    expect(() => allocatePayment([{ billId: 'b1', amount: '0' }], [bill()])).toThrow(/above zero/);
    expect(() =>
      allocatePayment(
        [
          { billId: 'b1', amount: '1' },
          { billId: 'b1', amount: '1' },
        ],
        [bill()],
      ),
    ).toThrow(/once/);
    expect(() => allocatePayment([{ billId: 'zz', amount: '1' }], [bill()])).toThrow(
      /cannot be paid/,
    );
    expect(() =>
      allocatePayment([{ billId: 'b1', amount: '500.01' }], [bill({ allocated: '500.00' })]),
    ).toThrow(/cannot take/);
  });
});

import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  estimateTotals,
  isRateMissing,
  lineTotal,
  signedLineTotal,
  type CostLine,
  type EstimateTerms,
} from './costing.js';

const line = (
  lineKind: CostLine['lineKind'],
  quantity: string,
  rate: string,
  suppliedBy: CostLine['suppliedBy'] = 'company',
): CostLine => ({ lineKind, quantity, rate, suppliedBy });

const terms = (over: Partial<EstimateTerms> = {}): EstimateTerms => ({
  overheadPercent: '10',
  contingencyPercent: '5',
  targetMarginPercent: '15',
  proposedPrice: null,
  ...over,
});

describe('line total (BR-4)', () => {
  it('rounds half-up to 2 decimals', () => {
    expect(lineTotal({ quantity: '3.0000', rate: '12.5000' })).toBe('37.50');
    expect(lineTotal({ quantity: '1.0000', rate: '0.0050' })).toBe('0.01');
    expect(lineTotal({ quantity: '1.0000', rate: '0.0049' })).toBe('0.00');
    expect(lineTotal({ quantity: '2.5000', rate: '0.0100' })).toBe('0.03');
  });

  it('rejects text that is not a decimal', () => {
    expect(() => lineTotal({ quantity: 'abc', rate: '1' })).toThrow(ValidationError);
    expect(() => lineTotal({ quantity: '1', rate: '1e3' })).toThrow(ValidationError);
  });
});

describe('rate missing (BR-3)', () => {
  it('flags only company lines with a zero rate', () => {
    expect(isRateMissing(line('material', '1', '0'))).toBe(true);
    expect(isRateMissing(line('material', '1', '0.0000'))).toBe(true);
    expect(isRateMissing(line('material', '1', '5'))).toBe(false);
    expect(isRateMissing(line('material', '1', '0', 'client'))).toBe(false);
  });
});

describe('estimate totals (spec P1-07 T-3, AC-1, AC-2)', () => {
  // Hand-calculated: material 1000.00 + labour 500.50 = 1500.50 company cost.
  const lines = [line('material', '10', '100'), line('labour', '2', '250.25')];

  it('adds overhead and contingency to company cost and compares margin', () => {
    const totals = estimateTotals(lines, terms({ proposedPrice: '2000' }));
    expect(totals.companyCost).toBe('1500.50');
    expect(totals.overheadAmount).toBe('150.05');
    expect(totals.contingencyAmount).toBe('75.03'); // 75.025 rounds half-up
    expect(totals.totalCost).toBe('1725.58');
    expect(totals.expectedMargin).toBe('274.42');
    expect(totals.marginPercent).toBe('13.7210');
    expect(totals.targetMarginPercent).toBe('15.0000');
    expect(totals.meetsTarget).toBe(false);
    expect(totals.proposedPrice).toBe('2000.00');
  });

  it('meets the target when the margin percent reaches it', () => {
    const totals = estimateTotals(lines, terms({ proposedPrice: '3000' }));
    expect(totals.meetsTarget).toBe(true);
    expect(totals.marginPercent).toBe('42.4807');
  });

  it('shows no margin without a price and no percent for a zero price', () => {
    const none = estimateTotals(lines, terms());
    expect(none.proposedPrice).toBeNull();
    expect(none.expectedMargin).toBeNull();
    expect(none.marginPercent).toBeNull();
    expect(none.meetsTarget).toBeNull();

    const zero = estimateTotals(lines, terms({ proposedPrice: '0' }));
    expect(zero.expectedMargin).toBe('-1725.58');
    expect(zero.marginPercent).toBeNull();
    expect(zero.meetsTarget).toBeNull();
  });

  it('shows client-supplied lines but keeps them out of cost and margin', () => {
    const withClient = [...lines, line('material', '100', '999', 'client')];
    const base = estimateTotals(lines, terms({ proposedPrice: '2000' }));
    const totals = estimateTotals(withClient, terms({ proposedPrice: '2000' }));
    expect(totals.clientSuppliedValue).toBe('99900.00');
    expect(totals.companyCost).toBe(base.companyCost);
    expect(totals.totalCost).toBe(base.totalCost);
    expect(totals.expectedMargin).toBe(base.expectedMargin);
  });

  it('treats a salvage credit as negative cost, and a client one as nothing', () => {
    const totals = estimateTotals(
      [line('disposal', '1', '1000'), line('salvage_credit', '1', '400')],
      terms({ overheadPercent: '0', contingencyPercent: '0' }),
    );
    expect(totals.companyCost).toBe('600.00');
    const ignored = estimateTotals(
      [line('disposal', '1', '1000'), line('salvage_credit', '1', '400', 'client')],
      terms({ overheadPercent: '0', contingencyPercent: '0' }),
    );
    expect(ignored.companyCost).toBe('1000.00');
    expect(ignored.clientSuppliedValue).toBe('400.00');
  });

  it('allows a salvage credit larger than the cost (negative company cost)', () => {
    const totals = estimateTotals([line('salvage_credit', '1', '50')], terms());
    expect(totals.companyCost).toBe('-50.00');
    expect(totals.overheadAmount).toBe('-5.00');
  });

  it('handles an empty estimate', () => {
    const totals = estimateTotals([], terms({ proposedPrice: '100' }));
    expect(totals.companyCost).toBe('0.00');
    expect(totals.expectedMargin).toBe('100.00');
    expect(totals.marginPercent).toBe('100.0000');
  });
});

describe('signed line total (BR-5)', () => {
  it('is negative only for a salvage credit with a value', () => {
    expect(signedLineTotal(line('material', '2', '10'))).toBe('20.00');
    expect(signedLineTotal(line('salvage_credit', '2', '10'))).toBe('-20.00');
    expect(signedLineTotal(line('salvage_credit', '0', '10'))).toBe('0.00');
  });
});

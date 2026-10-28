import { describe, expect, it } from 'vitest';
import {
  assertCountTransition,
  assertNegativeStockOff,
  assertReturnable,
  assertSufficient,
  assertTransferTransition,
  balanceDifference,
  countStatuses,
  countTransitions,
  countVariance,
  directionOf,
  remainingIssueCost,
  reorderState,
  salvageValue,
  signedQuantity,
  sumParts,
  transferStatuses,
  transferTransitions,
} from './index.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('movement direction', () => {
  it.each([
    ['receipt', 1],
    ['transfer_in', 1],
    ['adjustment_in', 1],
    ['return_in', 1],
    ['salvage_in', 1],
    ['client_receipt', 1],
    ['issue', -1],
    ['transfer_out', -1],
    ['adjustment_out', -1],
    ['client_return', -1],
  ] as const)('%s signs %i', (type, sign) => {
    expect(directionOf(type)).toBe(sign);
    expect(signedQuantity(type, '2.5')).toBe(sign === 1 ? '2.5000' : '-2.5000');
  });

  it('refuses a zero or malformed quantity', () => {
    expect(codeOf(() => signedQuantity('issue', '0'))).toBe('quantity_not_positive');
    expect(codeOf(() => signedQuantity('issue', 'x'))).toBe('invalid_decimal');
  });
});

describe('stock is never negative (BR-1, T-2)', () => {
  it('names the exact shortfall', () => {
    let details: unknown;
    let code: string | undefined;
    try {
      assertSufficient('30', '35.5');
    } catch (error) {
      details = (error as { details?: unknown }).details;
      code = (error as { code: string }).code;
    }
    expect(code).toBe('insufficient_stock');
    expect(details).toEqual({ shortfall: '5.5000', available: '30.0000' });
  });

  it('allows exactly the balance', () => {
    expect(() => assertSufficient('30', '30')).not.toThrow();
  });

  it('accepts only the setting value false', () => {
    expect(() => assertNegativeStockOff(false)).not.toThrow();
    expect(codeOf(() => assertNegativeStockOff(true))).toBe('negative_stock_unsupported');
  });
});

describe('issue cost (BR-3)', () => {
  it('sums the parts of a multi-layer issue', () => {
    expect(
      sumParts([
        { quantity: '10', value: '1000.00' },
        { quantity: '5', value: '600.50' },
      ]),
    ).toEqual({ quantity: '15.0000', value: '1600.50' });
  });
});

describe('returns (BR-6, T-6)', () => {
  it('returns what is left after the return', () => {
    expect(assertReturnable('10', '3', '2')).toBe('5.0000');
    expect(assertReturnable('10', '3', '7')).toBe('0.0000');
  });

  it('refuses more than the issue net of earlier returns', () => {
    expect(codeOf(() => assertReturnable('10', '3', '7.0001'))).toBe('return_exceeds_issue');
  });

  it('restates the cost as the issue value less what came back', () => {
    expect(remainingIssueCost('1000.00', '0.00')).toBe('1000.00');
    expect(remainingIssueCost('1000.00', '333.33')).toBe('666.67');
    expect(remainingIssueCost('1000.00', '1000.00')).toBe('0.00');
  });
});

describe('salvage value (BR-7, H-21)', () => {
  it('is nothing in the default mode', () => {
    expect(salvageValue('zero', '4', '99')).toEqual({ unitValue: '0.0000', value: '0.00' });
  });

  it('uses the stated unit value in estimated mode', () => {
    expect(salvageValue('estimated', '4', '12.5')).toEqual({
      unitValue: '12.5000',
      value: '50.00',
    });
    expect(codeOf(() => salvageValue('estimated', '4', null))).toBe('unit_value_required');
    expect(codeOf(() => salvageValue('estimated', '4', undefined))).toBe('unit_value_required');
    expect(codeOf(() => salvageValue('estimated', '4', ' '))).toBe('unit_value_required');
    expect(codeOf(() => salvageValue('estimated', '4', '-1'))).toBe('amount_negative');
  });

  it('refuses an unknown mode', () => {
    expect(codeOf(() => salvageValue('guess', '4', '1'))).toBe('invalid_salvage_mode');
  });
});

describe('reorder alert (BR-10, T-8)', () => {
  it('alerts once per crossing', () => {
    expect(reorderState('9', '10', false)).toEqual({ alert: true, alerted: true });
    expect(reorderState('8', '10', true)).toEqual({ alert: false, alerted: true });
    expect(reorderState('10', '10', true)).toEqual({ alert: false, alerted: false });
    expect(reorderState('9', '10', false)).toEqual({ alert: true, alerted: true });
  });

  it('has nothing to say without a level', () => {
    expect(reorderState('0', null, true)).toEqual({ alert: false, alerted: false });
  });
});

describe('integrity and counts (BR-8, BR-12)', () => {
  it('reports the difference between a balance and its ledger', () => {
    expect(balanceDifference('5', '5.0000')).toBeNull();
    expect(balanceDifference('5', '4')).toBe('1.0000');
  });

  it('computes the count variance', () => {
    expect(countVariance('10', '8').toFixed(4)).toBe('-2.0000');
    expect(countVariance('10', '12.5').toFixed(4)).toBe('2.5000');
    expect(codeOf(() => countVariance('10', '-1'))).toBe('amount_negative');
  });
});

describe('state machines (constitution 5.8, T-5)', () => {
  it('tests every transfer transition', () => {
    for (const from of transferStatuses) {
      for (const to of transferStatuses) {
        const allowed = transferTransitions[from].includes(to);
        expect(codeOf(() => assertTransferTransition(from, to))).toBe(
          allowed ? undefined : 'transfer_transition',
        );
      }
    }
  });

  it('tests every count transition', () => {
    for (const from of countStatuses) {
      for (const to of countStatuses) {
        const allowed = countTransitions[from].includes(to);
        expect(codeOf(() => assertCountTransition(from, to))).toBe(
          allowed ? undefined : 'count_transition',
        );
      }
    }
  });
});

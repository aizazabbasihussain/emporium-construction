import { describe, expect, it } from 'vitest';
import {
  assertCertificateTransition,
  assertNoRetention,
  assertVariationFits,
  assertVariationTransition,
  assertWorkOrderTransition,
  billBase,
  certificateFigures,
  certificateTransitions,
  certificationEntries,
  currentContractAmount,
  deductionsOf,
  isCertifiedStatus,
  isEditable,
  isFullyCertified,
  isOpenCertificate,
  normalizeBackChargeAmount,
  normalizeContractAmount,
  normalizeVariationAmount,
  remainingCommitment,
  variationTransitions,
  workOrderTransitions,
  type CertificateStatus,
  type VariationStatus,
  type WorkOrderStatus,
} from './index.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'none';
};

const orderStates = Object.keys(workOrderTransitions) as WorkOrderStatus[];
const certificateStates = Object.keys(certificateTransitions) as CertificateStatus[];
const variationStates = Object.keys(variationTransitions) as VariationStatus[];

describe('state machines (constitution 5.8, T-4)', () => {
  it('allows exactly the listed work order transitions and refuses every other pair', () => {
    for (const from of orderStates) {
      for (const to of orderStates) {
        if (workOrderTransitions[from].includes(to)) {
          expect(() => assertWorkOrderTransition(from, to)).not.toThrow();
        } else {
          expect(codeOf(() => assertWorkOrderTransition(from, to))).toBe('work_order_transition');
        }
      }
    }
  });

  it('allows exactly the listed certificate transitions and refuses every other pair', () => {
    for (const from of certificateStates) {
      for (const to of certificateStates) {
        if (certificateTransitions[from].includes(to)) {
          expect(() => assertCertificateTransition(from, to)).not.toThrow();
        } else {
          expect(codeOf(() => assertCertificateTransition(from, to))).toBe(
            'certificate_transition',
          );
        }
      }
    }
  });

  it('allows exactly the listed variation transitions and refuses every other pair', () => {
    for (const from of variationStates) {
      for (const to of variationStates) {
        if (variationTransitions[from].includes(to)) {
          expect(() => assertVariationTransition(from, to)).not.toThrow();
        } else {
          expect(codeOf(() => assertVariationTransition(from, to))).toBe('variation_transition');
        }
      }
    }
  });

  it('classifies statuses', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('active')).toBe(false);
    expect(isCertifiedStatus('certified')).toBe(true);
    expect(isCertifiedStatus('billed')).toBe(true);
    expect(isCertifiedStatus('draft')).toBe(false);
    expect(isOpenCertificate('draft')).toBe(true);
    expect(isOpenCertificate('pending_approval')).toBe(true);
    expect(isOpenCertificate('certified')).toBe(false);
  });
});

describe('contract and variations (BR-1, BR-8)', () => {
  it('adds approved variations to the contract', () => {
    expect(currentContractAmount('1000000', ['100000'])).toBe('1100000.00');
    expect(currentContractAmount('1000000', ['100000', '-25000.50'])).toBe('1074999.50');
    expect(currentContractAmount('1000000', [])).toBe('1000000.00');
  });

  it('keeps the contract above what is certified', () => {
    expect(
      assertVariationFits({ currentContract: '1000', variation: '-400', certified: '600' }),
    ).toBe('600.00');
    expect(
      codeOf(() =>
        assertVariationFits({ currentContract: '1000', variation: '-401', certified: '600' }),
      ),
    ).toBe('variation_below_certified');
    expect(
      codeOf(() =>
        assertVariationFits({ currentContract: '1000', variation: '-1000', certified: '0' }),
      ),
    ).toBe('variation_below_certified');
    expect(
      codeOf(() =>
        assertVariationFits({ currentContract: '1000', variation: '-1500', certified: '0' }),
      ),
    ).toBe('variation_below_certified');
  });

  it('refuses retention other than zero (BR-8)', () => {
    expect(() => assertNoRetention(undefined)).not.toThrow();
    expect(() => assertNoRetention('0')).not.toThrow();
    expect(() => assertNoRetention('0.0000')).not.toThrow();
    expect(codeOf(() => assertNoRetention('5'))).toBe('retention_not_supported');
  });

  it('checks the amounts', () => {
    expect(normalizeContractAmount('1000')).toBe('1000.00');
    expect(codeOf(() => normalizeContractAmount('0'))).toBe('contract_amount_invalid');
    expect(codeOf(() => normalizeContractAmount('-5'))).toBe('contract_amount_invalid');
    expect(normalizeVariationAmount('-5')).toBe('-5.00');
    expect(codeOf(() => normalizeVariationAmount('0'))).toBe('variation_amount_invalid');
    expect(normalizeBackChargeAmount('20000')).toBe('20000.00');
    expect(codeOf(() => normalizeBackChargeAmount('0'))).toBe('back_charge_invalid');
    expect(codeOf(() => normalizeBackChargeAmount('-1'))).toBe('back_charge_invalid');
  });
});

describe('certificates (BR-2, BR-3, T-1 worked example)', () => {
  it('certifies 30% then 70% of 1,000,000 with a 20,000 back-charge and a 100,000 variation', () => {
    const first = certificateFigures({
      basis: 'percent_complete',
      contractAmount: '1000000.00',
      previousCumulative: '0',
      cumulativePercent: '30',
      deductions: '0',
    });
    expect(first).toEqual({
      cumulativePercent: '30.0000',
      cumulativeAmount: '300000.00',
      thisCertificateAmount: '300000.00',
      deductions: '0.00',
      netCertified: '300000.00',
    });
    // The variation raises the contract to 1,100,000; 70% of it is 770,000 cumulative.
    const contract = currentContractAmount('1000000', ['100000']);
    const second = certificateFigures({
      basis: 'percent_complete',
      contractAmount: contract,
      previousCumulative: first.cumulativeAmount,
      cumulativePercent: '70',
      deductions: deductionsOf(['20000']),
    });
    expect(second).toEqual({
      cumulativePercent: '70.0000',
      cumulativeAmount: '770000.00',
      thisCertificateAmount: '470000.00',
      deductions: '20000.00',
      netCertified: '450000.00',
    });
    expect(remainingCommitment(contract, second.cumulativeAmount)).toBe('330000.00');
    expect(isFullyCertified(contract, second.cumulativeAmount)).toBe(false);
    expect(isFullyCertified(contract, contract)).toBe(true);
  });

  it('works from a cumulative amount and derives the percent', () => {
    const figures = certificateFigures({
      basis: 'amount',
      contractAmount: '3000.00',
      previousCumulative: '1000.00',
      cumulativeAmount: '2000',
      deductions: '0',
    });
    expect(figures.cumulativePercent).toBe('66.6667');
    expect(figures.thisCertificateAmount).toBe('1000.00');
  });

  it('rounds the percent of the contract half-up to two decimals', () => {
    const figures = certificateFigures({
      basis: 'percent_complete',
      contractAmount: '1000.01',
      previousCumulative: '0',
      cumulativePercent: '33.3333',
      deductions: '0',
    });
    expect(figures.cumulativeAmount).toBe('333.34');
  });

  it('refuses a cumulative above the contract (AC-2)', () => {
    expect(
      codeOf(() =>
        certificateFigures({
          basis: 'percent_complete',
          contractAmount: '1000',
          previousCumulative: '0',
          cumulativePercent: '100.0001',
          deductions: '0',
        }),
      ),
    ).toBe('over_certified');
    expect(
      codeOf(() =>
        certificateFigures({
          basis: 'amount',
          contractAmount: '1000',
          previousCumulative: '0',
          cumulativeAmount: '1000.01',
          deductions: '0',
        }),
      ),
    ).toBe('over_certified');
  });

  it('refuses missing or malformed inputs', () => {
    const base = { contractAmount: '1000', previousCumulative: '0', deductions: '0' };
    expect(codeOf(() => certificateFigures({ ...base, basis: 'percent_complete' }))).toBe(
      'percent_required',
    );
    expect(codeOf(() => certificateFigures({ ...base, basis: 'amount' }))).toBe('amount_required');
    expect(
      codeOf(() =>
        certificateFigures({ ...base, basis: 'percent_complete', cumulativePercent: '-1' }),
      ),
    ).toBe('percent_invalid');
    expect(
      codeOf(() =>
        certificateFigures({ ...base, basis: 'percent_complete', cumulativePercent: '1.00001' }),
      ),
    ).toBe('percent_invalid');
    expect(
      codeOf(() => certificateFigures({ ...base, basis: 'amount', cumulativeAmount: '-1' })),
    ).toBe('amount_invalid');
  });

  it('needs new work, or deductions only with zero new work (BR-2)', () => {
    const base = {
      basis: 'amount' as const,
      contractAmount: '1000',
      previousCumulative: '400',
      cumulativeAmount: '400',
    };
    expect(codeOf(() => certificateFigures({ ...base, deductions: '0' }))).toBe(
      'certificate_empty',
    );
    expect(
      codeOf(() => certificateFigures({ ...base, cumulativeAmount: '399', deductions: '0' })),
    ).toBe('certificate_not_cumulative');
    // Zero new work and a deduction nets below zero.
    expect(codeOf(() => certificateFigures({ ...base, deductions: '10' }))).toBe('negative_net');
  });

  it('refuses a negative net certified (BR-3)', () => {
    expect(
      codeOf(() =>
        certificateFigures({
          basis: 'amount',
          contractAmount: '1000',
          previousCumulative: '0',
          cumulativeAmount: '100',
          deductions: '100.01',
        }),
      ),
    ).toBe('negative_net');
    const exact = certificateFigures({
      basis: 'amount',
      contractAmount: '1000',
      previousCumulative: '0',
      cumulativeAmount: '100',
      deductions: '100',
    });
    expect(exact.netCertified).toBe('0.00');
  });

  it('sums back-charges exactly', () => {
    expect(deductionsOf([])).toBe('0.00');
    expect(deductionsOf(['0.10', '0.20'])).toBe('0.30');
  });

  it('never commits less than nothing', () => {
    expect(remainingCommitment('100', '150')).toBe('0.00');
    expect(remainingCommitment('100', '40')).toBe('60.00');
  });
});

describe('cost entries and the bill base (BR-4, BR-5)', () => {
  it('posts the gross as approved cost and only cost-recovering back-charges as negative entries', () => {
    const entries = certificationEntries({
      grossAmount: '470000',
      costCodeId: 'code-300',
      backCharges: [
        { id: 'a', amount: '20000', recoversCost: true, costCodeId: 'code-100' },
        { id: 'b', amount: '5000', recoversCost: false, costCodeId: null },
      ],
    });
    expect(entries).toEqual({
      gross: { amount: '470000.00', costCodeId: 'code-300' },
      recoveries: [{ backChargeId: 'a', amount: '-20000.00', costCodeId: 'code-100' }],
    });
  });

  it('refuses to certify a zero or negative gross', () => {
    expect(
      codeOf(() => certificationEntries({ grossAmount: '0', costCodeId: 'c', backCharges: [] })),
    ).toBe('certificate_empty');
    expect(
      codeOf(() => certificationEntries({ grossAmount: '-1', costCodeId: 'c', backCharges: [] })),
    ).toBe('certificate_empty');
  });

  it('bills the net certified, never zero (BR-5)', () => {
    expect(billBase('450000')).toBe('450000.00');
    expect(codeOf(() => billBase('0'))).toBe('net_not_billable');
    expect(codeOf(() => billBase('-1'))).toBe('net_not_billable');
  });
});

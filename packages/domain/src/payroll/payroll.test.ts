import { describe, expect, it } from 'vitest';
import { RuleViolationError, ValidationError } from '../errors.js';
import {
  assertApproverIsNotFinalizer,
  assertLinesPayable,
  assertReopenable,
  assertRunTransition,
  assertStatusFollowsLines,
  buildPayslip,
  isPositiveMoney,
  moneyDifference,
  needsPaymentApproval,
  planCashTransactions,
  runStatusFromLines,
  runTransitions,
  spreadDifference,
  sumMoney,
  type PayslipSource,
  type RunStatus,
} from './index.js';

const statuses: RunStatus[] = ['draft', 'finalized', 'part_paid', 'paid'];

describe('run state machine (T-4)', () => {
  for (const from of statuses) {
    for (const to of statuses) {
      const allowed = runTransitions[from].includes(to);
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'refused'}`, () => {
        if (allowed) expect(() => assertRunTransition(from, to)).not.toThrow();
        else expect(() => assertRunTransition(from, to)).toThrow(RuleViolationError);
      });
      it(`${from} -> ${to} after a payment change is ${allowed || from === to ? 'allowed' : 'refused'}`, () => {
        if (allowed || from === to) {
          expect(() => assertStatusFollowsLines(from, to)).not.toThrow();
        } else {
          expect(() => assertStatusFollowsLines(from, to)).toThrow(RuleViolationError);
        }
      });
    }
  }

  it('follows the paid lines (BR-6)', () => {
    expect(runStatusFromLines([])).toBe('finalized');
    expect(runStatusFromLines([{ status: 'unpaid' }, { status: 'unpaid' }])).toBe('finalized');
    expect(runStatusFromLines([{ status: 'paid' }, { status: 'unpaid' }])).toBe('part_paid');
    expect(runStatusFromLines([{ status: 'paid' }, { status: 'paid' }])).toBe('paid');
  });

  it('reopens only a finalized run with nothing paid (BR-7)', () => {
    expect(() => assertReopenable('finalized', 0)).not.toThrow();
    expect(() => assertReopenable('draft', 0)).toThrow('Only a finalized run');
    expect(() => assertReopenable('part_paid', 1)).toThrow('Only a finalized run');
    expect(() => assertReopenable('finalized', 2)).toThrow('paid lines');
  });
});

describe('spreading the cost difference (T-1)', () => {
  it('spreads pro rata and adds up to the paisa', () => {
    const parts = spreadDifference('100.00', [
      { key: 'a', weight: '1' },
      { key: 'b', weight: '1' },
      { key: 'c', weight: '1' },
    ]);
    expect(parts).toEqual([
      { key: 'a', amount: '33.34' },
      { key: 'b', amount: '33.33' },
      { key: 'c', amount: '33.33' },
    ]);
  });

  it('gives the paisas to the largest remainders', () => {
    const parts = spreadDifference('0.03', [
      { key: 'a', weight: '10' },
      { key: 'b', weight: '30' },
      { key: 'c', weight: '60' },
    ]);
    expect(parts.map((p) => p.amount)).toEqual(['0.00', '0.01', '0.02']);
    expect(sumMoney(parts.map((p) => p.amount))).toBe('0.03');
  });

  it('spreads a negative difference', () => {
    const parts = spreadDifference('-10.01', [
      { key: 'a', weight: '3' },
      { key: 'b', weight: '1' },
    ]);
    expect(parts).toEqual([
      { key: 'a', amount: '-7.51' },
      { key: 'b', amount: '-2.50' },
    ]);
  });

  it('spreads nothing for a zero difference and gives a zero-weight share nothing', () => {
    expect(spreadDifference('0.00', [{ key: 'a', weight: '2' }])).toEqual([
      { key: 'a', amount: '0.00' },
    ]);
    expect(
      spreadDifference('5.00', [
        { key: 'a', weight: '0' },
        { key: 'b', weight: '4' },
      ]),
    ).toEqual([
      { key: 'a', amount: '0.00' },
      { key: 'b', amount: '5.00' },
    ]);
  });

  it('tells whether there is anything to pay', () => {
    expect(isPositiveMoney('0.01')).toBe(true);
    expect(isPositiveMoney('0.00')).toBe(false);
  });

  it('works out the difference as signed money', () => {
    expect(moneyDifference('1500.50', '1000')).toBe('500.50');
    expect(moneyDifference('1000', '1500.50')).toBe('-500.50');
    expect(moneyDifference('10.00', '10')).toBe('0.00');
  });

  it('refuses a fraction of a paisa, no shares, negative weights and zero total weight', () => {
    expect(() => spreadDifference('1.005', [{ key: 'a', weight: '1' }])).toThrow(ValidationError);
    expect(() => spreadDifference('1.00', [])).toThrow('nothing to spread');
    expect(() => spreadDifference('1.00', [{ key: 'a', weight: '-1' }])).toThrow(ValidationError);
    expect(() => spreadDifference('1.00', [{ key: 'a', weight: '0' }])).toThrow(ValidationError);
  });
});

describe('payments (T-3)', () => {
  const lines = [
    { id: 'l1', netPay: '1000.00' },
    { id: 'l2', netPay: '2500.50' },
  ];

  it('plans one cash transaction for the selection or one per line', () => {
    expect(planCashTransactions(lines, false)).toEqual([
      { lineIds: ['l1', 'l2'], amount: '3500.50' },
    ]);
    expect(planCashTransactions(lines, true)).toEqual([
      { lineIds: ['l1'], amount: '1000.00' },
      { lineIds: ['l2'], amount: '2500.50' },
    ]);
    expect(() => planCashTransactions([], false)).toThrow(ValidationError);
  });

  it('asks for approval above the band only', () => {
    expect(needsPaymentApproval('1.00', '0')).toBe(true);
    expect(needsPaymentApproval('0.00', '0')).toBe(false);
    expect(needsPaymentApproval('100.00', '100')).toBe(false);
    expect(needsPaymentApproval('100.01', '100')).toBe(true);
  });

  it('keeps the finalizer out of the approvers', () => {
    expect(() => assertApproverIsNotFinalizer(['a'], 'b')).not.toThrow();
    expect(() => assertApproverIsNotFinalizer(['a'], null)).not.toThrow();
    expect(() => assertApproverIsNotFinalizer(['a', 'b'], 'b')).toThrow(RuleViolationError);
  });

  it('pays only unpaid lines of the run, each once', () => {
    expect(() => assertLinesPayable(['l1'], lines)).not.toThrow();
    expect(() => assertLinesPayable([], lines)).toThrow(ValidationError);
    expect(() => assertLinesPayable(['l9'], lines)).toThrow(RuleViolationError);
    expect(() => assertLinesPayable(['l1', 'l1'], lines)).toThrow(RuleViolationError);
  });
});

describe('payslip privacy (T-5)', () => {
  const source: PayslipSource = {
    number: 'PSL-2026-0001',
    workerId: 'w1',
    workerCode: 'W-001',
    workerName: 'Synthetic Worker 1',
    period: '2026-10',
    payBasis: 'daily_rate',
    rate: '1000.00',
    presentDays: '20',
    halfDays: '2',
    paidLeaveDays: '0',
    offDays: '4',
    absentDays: '1',
    overtimeHours: '6',
    basicPay: '21000.00',
    overtimePay: '1125.00',
    allowances: '500.00',
    deductions: '100.00',
    advanceRecovery: '2000.00',
    netPay: '20525.00',
  };

  it('shows the rate only on the worker own payslip', () => {
    expect(buildPayslip(source, 'w1').rate).toBe('1000.00');
    expect(buildPayslip(source, 'w2').rate).toBeNull();
    expect(buildPayslip(source, null).rate).toBeNull();
  });

  it('carries the attendance summary', () => {
    expect(buildPayslip(source, null).attendance).toEqual({
      presentDays: '20',
      halfDays: '2',
      paidLeaveDays: '0',
      offDays: '4',
      absentDays: '1',
      overtimeHours: '6',
    });
  });
});

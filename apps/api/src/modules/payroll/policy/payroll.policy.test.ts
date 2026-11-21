import { describe, expect, it } from 'vitest';
import {
  assertApprovalNamed,
  assertAttendanceCostComplete,
  assertFound,
  assertLabourCode,
  assertNoRunYet,
  assertPaymentReversible,
  assertPeriodApproved,
  assertRequestOfRun,
  assertReversalReason,
  assertRunFinalized,
  assertRunPayable,
  assertSheetUnchanged,
  assertUpdated,
} from './payroll.policy.js';

const code = (value: string) => expect.objectContaining({ code: value }) as Error;

describe('payroll policy', () => {
  it('reports a missing record and a lost update', () => {
    expect(() => assertFound(undefined, 'run')).toThrowError(code('run_not_found'));
    expect(assertFound('x', 'run')).toBe('x');
    expect(() => assertUpdated(undefined)).toThrowError(code('version_conflict'));
    expect(assertUpdated(1)).toBe(1);
  });

  it('BR-1: an approved period and one run per period', () => {
    expect(() => assertPeriodApproved('submitted')).toThrowError(code('period_not_approved'));
    expect(() => assertPeriodApproved('approved')).not.toThrow();
    expect(() => assertNoRunYet({})).toThrowError(code('run_exists'));
    expect(() => assertNoRunYet(undefined)).not.toThrow();
  });

  it('BR-7: the sheet must still match the run', () => {
    expect(() => assertSheetUnchanged('10.00', '11.00')).toThrowError(code('wage_sheet_changed'));
    expect(() => assertSheetUnchanged('10.00', '10.00')).not.toThrow();
  });

  it('BR-2: the labour cost code and the attendance cost', () => {
    expect(() => assertLabourCode(undefined)).toThrowError(code('labour_cost_code_invalid'));
    expect(() => assertLabourCode({ id: 'a', active: false })).toThrowError(
      code('labour_cost_code_invalid'),
    );
    expect(assertLabourCode({ id: 'a', active: true })).toBe('a');
    expect(() => assertAttendanceCostComplete('1.00', '2.00')).toThrowError(
      code('attendance_cost_incomplete'),
    );
    expect(() => assertAttendanceCostComplete('2.00', '2.00')).not.toThrow();
  });

  it('BR-3, BR-4: payslips and payments follow the run status', () => {
    expect(() => assertRunFinalized('draft')).toThrowError(code('run_not_finalized'));
    for (const status of ['finalized', 'part_paid', 'paid']) {
      expect(() => assertRunFinalized(status)).not.toThrow();
    }
    for (const status of ['draft', 'paid']) {
      expect(() => assertRunPayable(status)).toThrowError(code('run_not_payable'));
    }
    for (const status of ['finalized', 'part_paid']) {
      expect(() => assertRunPayable(status)).not.toThrow();
    }
  });

  it('BR-4: a payment above the band names its request, and the request is of this run', () => {
    expect(() => assertApprovalNamed(true, undefined)).toThrowError(code('approval_required'));
    expect(() => assertApprovalNamed(true, 'doc')).not.toThrow();
    expect(() => assertApprovalNamed(false, undefined)).not.toThrow();
    expect(() => assertRequestOfRun({ status: 'none' } as never, 'r1')).toThrowError(
      code('approval_not_found'),
    );
    expect(() =>
      assertRequestOfRun({ status: 'approved', context: { runId: 'r2' } } as never, 'r1'),
    ).toThrowError(code('approval_not_found'));
    expect(() =>
      assertRequestOfRun({ status: 'approved', context: null } as never, 'r1'),
    ).toThrowError(code('approval_not_found'));
    expect(() =>
      assertRequestOfRun({ status: 'approved', context: { runId: 'r1' } } as never, 'r1'),
    ).not.toThrow();
  });

  it('BR-5: a reversal needs a reason and happens once', () => {
    expect(() => assertReversalReason('   ')).toThrowError(code('reason_required'));
    expect(assertReversalReason('  typo ')).toBe('typo');
    expect(() => assertPaymentReversible('reversed')).toThrowError(code('payment_not_reversible'));
    expect(() => assertPaymentReversible('paid')).not.toThrow();
  });
});

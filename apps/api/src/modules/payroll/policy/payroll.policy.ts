import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import type { ApprovalState, RequestDto } from '../../approvals/index.js';

/** A missing record is reported as not found, whoever asks. */
export function assertFound<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return row;
}

/** Constitution 5.2: the update matched no row although the record exists, so the version moved on. */
export function assertUpdated<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return row;
}

/** BR-1: a run is made only for a wage period that is approved. */
export function assertPeriodApproved(status: string): void {
  if (status !== 'approved') {
    throw new RuleViolationError(
      'period_not_approved',
      'A payroll run needs an approved wage period',
    );
  }
}

/** BR-1: one run per wage period. */
export function assertNoRunYet(existing: unknown): void {
  if (existing !== undefined) {
    throw new ConflictError('run_exists', 'This wage period already has a payroll run');
  }
}

/** BR-7: the wage sheet is locked, so a run whose total no longer matches it is stale. */
export function assertSheetUnchanged(runTotal: string, sheetTotal: string): void {
  if (runTotal !== sheetTotal) {
    throw new RuleViolationError('wage_sheet_changed', 'The wage sheet no longer matches this run');
  }
}

/** BR-2: the labour cost code named by the setting exists and is active. */
export function assertLabourCode(code: { id: string; active: boolean } | undefined): string {
  if (code === undefined || !code.active) {
    throw new RuleViolationError(
      'labour_cost_code_invalid',
      'The labour cost code in the settings is missing or inactive',
    );
  }
  return code.id;
}

/**
 * BR-2: every approved attendance cost entry of the month must be found, or the wage sheet and the
 * ledger would disagree about what was allocated.
 */
export function assertAttendanceCostComplete(found: string, expected: string): void {
  if (found !== expected) {
    throw new RuleViolationError(
      'attendance_cost_incomplete',
      `The approved attendance cost in the ledger (${found}) differs from the wage reconciliation (${expected})`,
    );
  }
}

/** BR-3: payslips exist once the run is finalized, and stay readable while it is paid. */
export function assertRunFinalized(status: string): void {
  if (status === 'draft') {
    throw new RuleViolationError('run_not_finalized', 'Payslips exist only for a finalized run');
  }
}

/** BR-4: lines are paid only once the run is finalized. */
export function assertRunPayable(status: string): void {
  if (status !== 'finalized' && status !== 'part_paid') {
    throw new RuleViolationError(
      'run_not_payable',
      'Only a finalized run with unpaid lines can be paid',
    );
  }
}

/** BR-4: a payment above the approval band names the approved request it relies on. */
export function assertApprovalNamed(needed: boolean, approvalDocId: string | undefined): void {
  if (needed && approvalDocId === undefined) {
    throw new RuleViolationError(
      'approval_required',
      'This payment needs an approved payment request first',
    );
  }
}

/** BR-4: the request found for the document must belong to a payroll payment of this run. */
export function assertRequestOfRun(
  state: ApprovalState,
  runId: string,
): asserts state is RequestDto {
  if (state.status === 'none' || state.context?.runId !== runId) {
    throw new NotFoundError('approval_not_found', 'No payroll payment request was found');
  }
}

/** BR-5: a reversal needs a reason. */
export function assertReversalReason(reason: string): string {
  const text = reason.trim();
  if (text === '') throw new ValidationError('reason_required', 'Give the reason for the reversal');
  return text;
}

/** BR-5: a payment is reversed once. */
export function assertPaymentReversible(status: string): void {
  if (status !== 'paid') {
    throw new RuleViolationError('payment_not_reversible', 'This payment is already reversed');
  }
}

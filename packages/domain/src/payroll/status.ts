import { RuleViolationError } from '../errors.js';

export type RunStatus = 'draft' | 'finalized' | 'part_paid' | 'paid';
export type LineStatus = 'unpaid' | 'paid';

/**
 * Constitution 5.8: the allowed run transitions. A draft is finalized; an unpaid finalized run can
 * be reopened to a draft (BR-7). Paying moves it to part_paid and paid, and reversing a payment
 * moves it back (BR-5), so the status always follows the lines (BR-6).
 */
export const runTransitions: Record<RunStatus, readonly RunStatus[]> = {
  draft: ['finalized'],
  finalized: ['draft', 'part_paid', 'paid'],
  part_paid: ['finalized', 'paid'],
  paid: ['finalized', 'part_paid'],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!runTransitions[from].includes(to)) {
    throw new RuleViolationError('run_transition', `A ${from} payroll run cannot become ${to}`);
  }
}

/** BR-6: after a payment change the status follows the lines; staying in the same status is fine. */
export function assertStatusFollowsLines(from: RunStatus, to: RunStatus): void {
  if (from !== to) assertRunTransition(from, to);
}

/** BR-6: the status of a finalized run follows how many of its lines are paid. */
export function runStatusFromLines(lines: readonly { status: LineStatus }[]): RunStatus {
  const paid = lines.filter((line) => line.status === 'paid').length;
  if (paid === 0) return 'finalized';
  return paid === lines.length ? 'paid' : 'part_paid';
}

/** BR-7: only a finalized run with nothing paid can be reopened. */
export function assertReopenable(status: RunStatus, paidLines: number): void {
  if (status !== 'finalized') {
    throw new RuleViolationError('run_not_reopenable', 'Only a finalized run can be reopened');
  }
  if (paidLines > 0) {
    throw new RuleViolationError(
      'run_has_payments',
      'A run with paid lines cannot be reopened; correct it in the next month',
    );
  }
}

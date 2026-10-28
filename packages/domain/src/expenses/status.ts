import { RuleViolationError } from '../errors.js';

export const claimStatuses = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'returned',
  'posted',
  'cancelled',
] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

/**
 * Constitution 5.8, BR-4 to BR-7: the allowed claim transitions as an explicit table. A claim the
 * approver returns can be corrected and submitted again; a rejected one ends. Cancelling an approved
 * claim reverses its cost entries; a posted claim is reversed (also ends as `cancelled`).
 */
export const claimTransitions: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'returned', 'cancelled'],
  approved: ['posted', 'cancelled'],
  rejected: [],
  returned: ['submitted', 'cancelled'],
  posted: ['cancelled'],
  cancelled: [],
};

export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (!claimTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'claim_transition',
      `An expense claim cannot go from ${from} to ${to}`,
    );
  }
}

/** Only a draft or a returned claim can be edited. */
export function assertClaimEditable(status: ClaimStatus): void {
  if (status !== 'draft' && status !== 'returned') {
    throw new RuleViolationError(
      'claim_read_only',
      'Only a draft or returned expense claim can be edited',
    );
  }
}

export const advanceStatuses = ['issued', 'settled', 'cancelled'] as const;
export type AdvanceStatus = (typeof advanceStatuses)[number];

/** BR-8: only an advance that is still issued can be settled. */
export function assertAdvanceIssued(status: AdvanceStatus): void {
  if (status !== 'issued') {
    throw new RuleViolationError('advance_not_issued', 'Only an issued advance can be settled');
  }
}

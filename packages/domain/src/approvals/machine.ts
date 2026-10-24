import { RuleViolationError } from '../errors.js';

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';

export const requestStatuses: readonly RequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'returned',
  'cancelled',
];

/**
 * Allowed status transitions (constitution 5.8). Every other status is final; a returned request
 * is resubmitted as a new request version.
 */
export const allowedTransitions: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  pending: ['approved', 'rejected', 'returned', 'cancelled'],
  approved: [],
  rejected: [],
  returned: [],
  cancelled: [],
};

export const canTransition = (from: RequestStatus, to: RequestStatus): boolean =>
  allowedTransitions[from].includes(to);

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new RuleViolationError(
      'request_not_pending',
      `A ${from} approval request cannot become ${to}`,
      { from, to },
    );
  }
}

/** Only a pending request can be acted on or cancelled. */
export function assertOpen(status: RequestStatus): void {
  if (status !== 'pending') {
    throw new RuleViolationError(
      'request_not_pending',
      `This approval request is already ${status}`,
      {
        status,
      },
    );
  }
}

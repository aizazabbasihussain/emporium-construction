import { RuleViolationError } from '../errors.js';

export const transferStatuses = ['draft', 'in_transit', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof transferStatuses)[number];

/** Constitution 5.8, BR-4: a transfer is sent, then received; before it is received it can be cancelled. */
export const transferTransitions: Record<TransferStatus, readonly TransferStatus[]> = {
  draft: ['in_transit', 'cancelled'],
  in_transit: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!transferTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'transfer_transition',
      `A transfer cannot go from ${from} to ${to}`,
    );
  }
}

export const countStatuses = ['draft', 'counted', 'approved', 'cancelled'] as const;
export type CountStatus = (typeof countStatuses)[number];

/** BR-8: a count is submitted for approval and its adjustments post when the approval comes. */
export const countTransitions: Record<CountStatus, readonly CountStatus[]> = {
  draft: ['counted', 'cancelled'],
  counted: ['approved', 'draft', 'cancelled'],
  approved: [],
  cancelled: [],
};

export function assertCountTransition(from: CountStatus, to: CountStatus): void {
  if (!countTransitions[from].includes(to)) {
    throw new RuleViolationError('count_transition', `A count cannot go from ${from} to ${to}`);
  }
}

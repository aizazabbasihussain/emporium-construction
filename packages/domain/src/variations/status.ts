import { RuleViolationError } from '../errors.js';

export const variationStatuses = [
  'draft',
  'pending_internal_approval',
  'submitted_to_client',
  'client_approved',
  'client_rejected',
  'cancelled',
] as const;
export type VariationStatus = (typeof variationStatuses)[number];

/**
 * Constitution 5.8, BR-3, BR-6 and BR-7: the allowed transitions as an explicit table. Whether the
 * internal approval has been granted is the approval engine's state, not a status of its own, so
 * `pending_internal_approval` to `submitted_to_client` is checked against that state (BR-3).
 */
export const variationTransitions: Record<VariationStatus, readonly VariationStatus[]> = {
  draft: ['pending_internal_approval', 'cancelled'],
  pending_internal_approval: ['submitted_to_client', 'cancelled'],
  submitted_to_client: ['client_approved', 'client_rejected', 'cancelled'],
  client_approved: [],
  client_rejected: [],
  cancelled: [],
};

export function assertTransition(from: VariationStatus, to: VariationStatus): void {
  if (!variationTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'variation_transition',
      `A variation cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-6: only a draft can be edited; a client-approved variation is never edited or deleted. */
export function assertEditable(status: VariationStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError(
      'variation_read_only',
      status === 'client_approved'
        ? 'An approved variation cannot be changed; reverse it with a deductive variation'
        : 'Only a draft variation can be edited',
    );
  }
}

/** BR-7: `client_rejected` and `cancelled` end the variation; only a rejected one can be copied. */
export function assertCopyable(status: VariationStatus): void {
  if (status !== 'client_rejected') {
    throw new RuleViolationError(
      'variation_not_copyable',
      'Only a variation the client rejected can be copied into a new draft',
    );
  }
}

const OPEN: readonly VariationStatus[] = [
  'draft',
  'pending_internal_approval',
  'submitted_to_client',
];

/** Whether the variation is still undecided (BR-8: only then can costs be at risk). */
export const isOpenStatus = (status: string): boolean => OPEN.includes(status as VariationStatus);

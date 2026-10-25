import { RuleViolationError } from '../errors.js';

export const quotationStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const;
export type QuotationStatus = (typeof quotationStatuses)[number];

/**
 * Constitution 5.8 and BR-4: the allowed transitions as an explicit table. A request that the
 * approvers reject, return or cancel falls back to draft; a later revision supersedes an issued,
 * rejected or expired quotation.
 */
export const quotationTransitions: Record<QuotationStatus, readonly QuotationStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'draft'],
  approved: ['issued'],
  issued: ['accepted', 'rejected', 'expired', 'superseded'],
  accepted: [],
  rejected: ['superseded'],
  expired: ['superseded'],
  superseded: [],
};

export function assertTransition(from: QuotationStatus, to: QuotationStatus): void {
  if (!quotationTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'quotation_transition',
      `A quotation cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-4: only a draft can be edited; everything after submission is read-only. */
export function assertEditable(status: QuotationStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError('quotation_read_only', 'Only a draft quotation can be edited');
  }
}

const REVISABLE: readonly QuotationStatus[] = ['issued', 'rejected', 'expired'];

/** BR-4 and BR-10: a revision starts from an issued, rejected or expired quotation. */
export function assertRevisable(status: QuotationStatus): void {
  if (!REVISABLE.includes(status)) {
    throw new RuleViolationError(
      'quotation_not_revisable',
      'Only an issued, rejected or expired quotation can be revised',
    );
  }
}

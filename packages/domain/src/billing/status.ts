import { RuleViolationError } from '../errors.js';

export const invoiceStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'cancelled',
] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

/**
 * Constitution 5.8, BR-5, BR-6: the allowed transitions as an explicit table. An approval that is
 * refused or returned sends the invoice back to draft. An issued invoice ends as `cancelled` only
 * through a credit note that returns its whole value (BR-5, BR-9).
 */
export const invoiceTransitions: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'draft', 'cancelled'],
  approved: ['issued', 'draft', 'cancelled'],
  issued: ['cancelled'],
  cancelled: [],
};

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!invoiceTransitions[from].includes(to)) {
    throw new RuleViolationError(
      'invoice_transition',
      `An invoice cannot go from ${from} to ${to}`,
    );
  }
}

/** BR-6: only a draft can be edited; issuing locks the invoice. */
export function assertEditable(status: InvoiceStatus): void {
  if (status !== 'draft') {
    throw new RuleViolationError(
      'invoice_read_only',
      status === 'issued'
        ? 'An issued invoice cannot be changed; correct it with a credit note'
        : 'Only a draft invoice can be edited',
    );
  }
}

/** BR-5: an issued invoice is never cancelled directly; only a credit note can do it. */
export function assertCancellableDirectly(status: InvoiceStatus): void {
  if (status === 'issued') {
    throw new RuleViolationError(
      'invoice_cancel_by_credit_note',
      'An issued invoice can be cancelled only by a credit note',
    );
  }
}

import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { Money } from '@emporium/domain/kernel';
import type { ReceiptMethod, ReceiptStatus } from '@emporium/shared';

export function assertFound<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new NotFoundError(`${what}_not_found`, 'Not found');
  return value;
}

/** Optimistic concurrency (constitution 5.2): a missed update means the version moved on. */
export function assertUpdated<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
  return value;
}

/** The caller worked from an old copy of the record (constitution 5.2). */
export function assertVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** Cheque-like methods wait for clearing; the others move money at once (BR-2). */
export const isChequeMethod = (method: ReceiptMethod): boolean =>
  method === 'cheque' || method === 'pdc';

/** BR-2: cash, bank transfer and online receipts name the account that takes the money. */
export function assertAccountForImmediate(
  method: ReceiptMethod,
  accountId: string | undefined,
): void {
  if (!isChequeMethod(method) && accountId === undefined) {
    throw new ValidationError('account_required', 'Choose the cash or bank account that takes it');
  }
}

export function assertPositive(amount: string, field: string): void {
  const value = Money.of(amount);
  if (value.isNegative() || value.isZero()) {
    throw new ValidationError(`${field}_invalid`, `The ${field} must be above zero`);
  }
}

/** BR-3: an invoice that is not issued, or belongs to another customer, takes no allocation. */
export function assertInvoicesOfParty(
  invoiceIds: readonly string[],
  known: ReadonlyMap<string, { partyId: string; sourceType: string }>,
  partyId: string,
): void {
  for (const id of invoiceIds) {
    const invoice = known.get(id);
    if (invoice === undefined || invoice.partyId !== partyId) {
      throw new RuleViolationError(
        'invoice_not_open',
        `Invoice ${id} is not an issued invoice of this customer`,
      );
    }
  }
}

/** BR-5: an advance allocation belongs on an advance invoice and names an advance of it. */
export function assertAdvanceMatches(
  sourceType: string | undefined,
  advanceInvoiceId: string | null | undefined,
  invoiceId: string,
): void {
  if (sourceType !== 'advance' || advanceInvoiceId !== invoiceId) {
    throw new RuleViolationError(
      'advance_mismatch',
      'The advance does not belong to this advance invoice',
    );
  }
}

/** BR-3 and BR-9: money is allocated once; a receipt that no longer counts takes no allocation. */
export function assertAllocatable(status: ReceiptStatus, existingAllocations: number): void {
  if (status === 'cancelled' || status === 'bounced') {
    throw new RuleViolationError('receipt_not_active', `A ${status} receipt cannot be allocated`);
  }
  if (existingAllocations > 0) {
    throw new RuleViolationError(
      'receipt_already_allocated',
      'Allocations are immutable; cancel the receipt and record it again',
    );
  }
}

/**
 * BR-9: cleared money is cancelled by a reversing cash entry (never while reconciled); a cheque
 * still in hand is cancelled without cash; anything else is moved through the cheque register.
 */
export function assertCancellable(input: {
  status: ReceiptStatus;
  pdcStatus: string | undefined;
  reconciled: boolean;
  advanceReceived: boolean;
  reason: string;
}): void {
  if (input.reason.trim() === '') {
    throw new ValidationError('reason_required', 'A reason is required');
  }
  // A cleared cheque is undone by a bounce, which keeps the register right.
  const cleared = input.status === 'cleared' && input.pdcStatus === undefined;
  const inHand = input.status === 'pending_clearing' && input.pdcStatus === 'received';
  if (!cleared && !inHand) {
    throw new RuleViolationError(
      'receipt_not_cancellable',
      `A ${input.status} receipt cannot be cancelled here`,
    );
  }
  if (input.reconciled) {
    throw new RuleViolationError(
      'receipt_reconciled',
      'The receipt is on a reconciled bank statement; un-reconcile it first',
    );
  }
  if (input.advanceReceived) {
    throw new RuleViolationError(
      'advance_already_received',
      'Billing has recorded this advance as received and cannot take it back',
    );
  }
}

export function assertReversalDate(date: string, clearedOn: string | null): void {
  if (clearedOn !== null && date < clearedOn) {
    throw new RuleViolationError(
      'reversal_before_clearing',
      'A reversal cannot be dated before the receipt',
    );
  }
}

export interface ApprovalFacts {
  status: string;
  amount: string;
  approvers: readonly string[];
}

/** BR-11, H-09: the owner approved a write-off that covers the amount; the approver does not record it. */
export function assertWriteOffApproved(input: {
  approvalDocId: string | undefined;
  facts: ApprovalFacts | undefined;
  amount: string;
  actorUserId: string;
  alreadyUsed: boolean;
}): void {
  if (input.approvalDocId === undefined) {
    throw new RuleViolationError(
      'approval_required',
      'A write-off needs an approved request first',
    );
  }
  const facts = assertFound(input.facts, 'approval');
  if (facts.status !== 'approved') {
    throw new RuleViolationError('approval_not_approved', 'The request is not approved');
  }
  if (facts.approvers.includes(input.actorUserId)) {
    throw new RuleViolationError(
      'approver_cannot_record',
      'The approver cannot record the write-off',
    );
  }
  if (Money.of(input.amount).compare(Money.of(facts.amount)) > 0) {
    throw new RuleViolationError(
      'approval_amount_exceeded',
      'The approval covers a smaller amount',
    );
  }
  if (input.alreadyUsed) {
    throw new RuleViolationError('approval_used', 'This approval was already used');
  }
}

export function assertFollowupOpen(status: string): void {
  if (status !== 'open') {
    throw new RuleViolationError('followup_closed', 'The follow-up is already done');
  }
}

/** The advances of a bounce or cancellation: billing cannot un-receive an advance. */
export function assertNoReceivedAdvance(hasAdvance: boolean): void {
  if (hasAdvance) {
    throw new RuleViolationError(
      'advance_already_received',
      'Billing has recorded this advance as received and cannot take it back',
    );
  }
}

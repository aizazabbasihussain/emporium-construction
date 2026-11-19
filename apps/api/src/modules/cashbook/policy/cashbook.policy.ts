import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { Money } from '@emporium/domain/kernel';
import type { AccountKind } from '@emporium/domain/cashbook';

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

/** Only a masked account number is stored: at most the last four digits may appear. */
export function assertMasked(value: string | null): void {
  if (value !== null && value.replace(/\D/g, '').length > 4) {
    throw new ValidationError(
      'account_number_not_masked',
      'Store only a masked account number, for example ****1234',
    );
  }
}

/** BR-1, BR-3: an opening balance below zero only fits an account that may be overdrawn. */
export function assertOpeningBalance(input: {
  kind: AccountKind;
  allowOverdraft: boolean;
  openingBalance: string;
}): void {
  if (!Money.of(input.openingBalance).isNegative()) return;
  if (input.kind === 'cash' || input.kind === 'petty_cash' || !input.allowOverdraft) {
    throw new RuleViolationError(
      'opening_balance_negative',
      'Only a bank account or wallet that allows an overdraft may open below zero',
    );
  }
}

/** Cash and petty cash never go negative, so the overdraft flag only applies to the other kinds. */
export function assertOverdraftFlagAllowed(kind: AccountKind, allowOverdraft: boolean): void {
  if (allowOverdraft && (kind === 'cash' || kind === 'petty_cash')) {
    throw new RuleViolationError(
      'overdraft_not_allowed',
      'A cash or petty cash account cannot be overdrawn',
    );
  }
}

export function assertAccountUnused(transactionCount: number): void {
  if (transactionCount > 0) {
    throw new RuleViolationError(
      'account_in_use',
      'An account with transactions cannot be deleted; deactivate it instead',
    );
  }
}

export function assertAccountActive(active: boolean): void {
  if (!active) {
    throw new RuleViolationError('account_inactive', 'The account is inactive');
  }
}

export function assertDifferentAccounts(fromId: string, toId: string): void {
  if (fromId === toId) {
    throw new ValidationError('transfer_same_account', 'A transfer needs two different accounts');
  }
}

/** BR-7: a tag is a short chart-of-accounts code; empty means untagged. */
export function normalizeTag(tag: string | null | undefined): string | null {
  const trimmed = tag?.trim() ?? '';
  if (trimmed === '') return null;
  if (trimmed.length > 40) {
    throw new ValidationError('tag_invalid', 'An account tag is at most 40 characters');
  }
  return trimmed;
}

/** BR-5: above the threshold a payment needs the approval id of its approved request. */
export function requiresApproval(amount: string, threshold: string): boolean {
  return Money.of(amount).compare(Money.of(threshold)) > 0;
}

export interface ApprovalFacts {
  status: string;
  amount: string;
  approvers: readonly string[];
  /** Money already paid against this request and not reversed. */
  alreadyPaid: string;
}

/**
 * BR-5 and H-09: the request is approved, covers the amounts paid under it, and the user who
 * records the payment did not approve it. `facts` is undefined when no request was found.
 */
export function assertApproved(input: {
  approvalDocId: string | undefined;
  facts: ApprovalFacts | undefined;
  amount: string;
  actorUserId: string | null;
}): void {
  if (input.approvalDocId === undefined) {
    throw new RuleViolationError(
      'approval_required',
      'This amount needs an approved request first',
    );
  }
  const facts = input.facts;
  if (facts === undefined) {
    throw new NotFoundError('approval_not_found', 'No approval request was found');
  }
  if (facts.status !== 'approved') {
    throw new RuleViolationError('approval_not_approved', 'The request is not approved');
  }
  if (input.actorUserId !== null && facts.approvers.includes(input.actorUserId)) {
    throw new RuleViolationError(
      'approver_cannot_record',
      'The user who approved the request cannot record the payment',
    );
  }
  const covered = Money.of(facts.amount);
  if (Money.of(facts.alreadyPaid).add(Money.of(input.amount)).compare(covered) > 0) {
    throw new RuleViolationError(
      'approval_amount_exceeded',
      `The approval covers ${covered.toString()}, of which ${facts.alreadyPaid} is already paid`,
    );
  }
}

/** A reversal is not dated before the entry it reverses. */
export function assertReversalDate(reversalDate: string, originalDate: string): void {
  if (reversalDate < originalDate) {
    throw new RuleViolationError(
      'reversal_before_original',
      'A reversal cannot be dated before the entry it reverses',
    );
  }
}

export function assertDraft(status: string): void {
  if (status !== 'draft') {
    throw new RuleViolationError('reconciliation_not_draft', 'The reconciliation is completed');
  }
}

/** The statement period must hold the statement's lines. */
export function assertLinesInPeriod(
  lines: readonly { lineDate: string }[],
  from: string,
  to: string,
): void {
  if (lines.some((line) => line.lineDate < from || line.lineDate > to)) {
    throw new ValidationError(
      'statement_line_out_of_period',
      'A statement line is dated outside the statement period',
    );
  }
}

/** BR-8: a statement line and a book entry are matched only when they move the same money. */
export function assertMatchable(
  line: { direction: string; amount: string },
  txn: { direction: string; amount: string },
): void {
  if (line.direction !== txn.direction || !Money.of(line.amount).equals(Money.of(txn.amount))) {
    throw new RuleViolationError(
      'match_mismatch',
      'The statement line and the transaction differ in direction or amount',
    );
  }
}

export function assertPeriod(from: string, to: string): void {
  if (to < from) {
    throw new ValidationError('period_invalid', 'The statement end is before its start');
  }
}

/** A pending money movement is recorded once. */
export function assertPending(status: string): void {
  if (status !== 'pending') {
    throw new RuleViolationError('source_already_recorded', 'This movement is already recorded');
  }
}

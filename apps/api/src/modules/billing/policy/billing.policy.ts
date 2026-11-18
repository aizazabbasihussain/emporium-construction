import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope } from '@emporium/domain/identity';
import { Money } from '@emporium/domain/kernel';
import type { Actor } from '../types.js';

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

/** Identity BR-4: a scoped user reaches only the projects they are assigned to. */
export function assertProjectReachable(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  projectId: string,
): void {
  if (!hasScope(actor, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** A cancelled or closed project is not billed any more. */
export function assertProjectBillable(status: string): void {
  if (status === 'cancelled' || status === 'closed') {
    throw new RuleViolationError('project_not_billable', `A ${status} project cannot be billed`);
  }
}

/** BR-2: the tax authority comes from the project location, so the project needs one. */
export function assertProjectHasLocation(locationId: string | null): string {
  if (locationId === null) {
    throw new RuleViolationError(
      'project_location_required',
      'The project has no location, so the tax authority cannot be resolved',
    );
  }
  return locationId;
}

/** BR-1: a manual schedule edit waits for approval and blocks invoices until it is decided. */
export function assertNoPendingScheduleEdit(pendingEditId: string | null): void {
  if (pendingEditId !== null) {
    throw new RuleViolationError(
      'schedule_edit_pending',
      'A change of the billing schedule is waiting for approval',
    );
  }
}

/** BR-2: the stages of an invoice are planned, belong to the project and are on no other live invoice. */
export function assertStagesAvailable(input: {
  requested: readonly string[];
  found: readonly { id: string; status: string }[];
  taken: readonly string[];
}): void {
  if (input.requested.length === 0) {
    throw new ValidationError('stages_required', 'Choose at least one stage to bill');
  }
  if (new Set(input.requested).size !== input.requested.length) {
    throw new ValidationError('stage_repeated', 'A stage is listed twice');
  }
  if (input.found.length !== input.requested.length) {
    throw new NotFoundError('stage_not_found', 'A stage was not found on this project');
  }
  if (input.found.some((stage) => stage.status !== 'planned') || input.taken.length > 0) {
    throw new RuleViolationError('stage_not_planned', 'A stage is already invoiced');
  }
}

/** The tax engine rates one supply kind per document, so an invoice carries one. */
export function assertSingleSupplyKind(kinds: readonly string[]): string {
  const distinct = [...new Set(kinds)];
  if (distinct.length !== 1) {
    throw new ValidationError('mixed_supply_kinds', 'An invoice bills goods or services, not both');
  }
  return distinct[0] as string;
}

/** BR-6: what was approved is what is issued; any change in the figures needs a new approval. */
export function assertFiguresUnchanged(
  stored: Record<string, string>,
  current: Record<string, string>,
): void {
  const changed = Object.keys(stored).filter((key) => stored[key] !== current[key]);
  if (changed.length > 0) {
    throw new RuleViolationError(
      'figures_changed',
      `The figures changed since approval (${changed.join(', ')}); return the document to draft and submit it again`,
    );
  }
}

/** BR-9: a credit note is issued only for an issued invoice. */
export function assertIssuedInvoice(status: string): void {
  if (status !== 'issued') {
    throw new RuleViolationError('invoice_not_issued', 'Only an issued invoice can be credited');
  }
}

/** BR-9 and BR-6: issuing needs the approval of the owner. */
export function assertApproved(status: string): void {
  if (status !== 'approved') {
    throw new RuleViolationError('approval_required', 'The document is not approved yet');
  }
}

/** A credit note is submitted again only after an earlier request ended without approval. */
export function assertSubmittable(approvalStatus: string): void {
  if (approvalStatus === 'pending' || approvalStatus === 'approved') {
    throw new RuleViolationError('already_submitted', 'The document is already submitted');
  }
}

/** A credit note starts as a draft and is submitted once. */
export function assertDraftCredit(status: string): void {
  if (status !== 'draft') {
    throw new RuleViolationError('credit_note_issued', 'The credit note is already issued');
  }
}

/** BR-8: an advance that has been applied to invoices cannot be credited. */
export function assertAdvanceUnused(applied: string): void {
  if (Money.of(applied).value.gt(0)) {
    throw new RuleViolationError(
      'advance_in_use',
      'The advance is already applied to invoices and cannot be credited',
    );
  }
}

/** BR-8: only a received advance can be marked so; once. */
export function assertAdvanceRequested(status: string): void {
  if (status !== 'requested') {
    throw new RuleViolationError('advance_not_requested', 'The advance was already received');
  }
}

/** The advance invoice must be issued before the money counts as received. */
export function assertAdvanceInvoiceIssued(status: string | null): void {
  if (status !== 'issued') {
    throw new RuleViolationError(
      'advance_invoice_not_issued',
      'The advance invoice must be issued before the advance is received',
    );
  }
}

/** BR-12: one provider per invoice source type. */
export function assertSourceFree(registered: boolean, type: string): void {
  if (registered) {
    throw new ConflictError('source_registered', `An invoice source ${type} is already registered`);
  }
}

export function assertSourceKnown<T>(provider: T | undefined, type: string): T {
  if (provider === undefined) {
    throw new ValidationError('unknown_invoice_source', `Unknown invoice source ${type}`);
  }
  return provider;
}

export function assertPositive(amount: string, field: string): void {
  if (!Money.of(amount).value.gt(0)) {
    throw new ValidationError(`${field}_invalid`, `${field} must be above zero`);
  }
}

import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { hasScope } from '@emporium/domain/identity';
import { subcontractsPermissions } from '@emporium/shared';
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

export function assertApplied(applied: boolean): void {
  if (!applied) {
    throw new ConflictError('version_conflict', 'The record was changed by someone else');
  }
}

/** Spec section 6 and identity BR-4: a supervisor reaches only the projects assigned to them. */
export function assertProjectReachable(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  projectId: string,
): void {
  if (!hasScope(actor, 'project', projectId)) {
    throw new NotFoundError('project_not_found', 'Not found');
  }
}

/** BR-9: amount fields are shown only to those who hold `subcontracts.amount.read`. */
export const canSeeAmounts = (permissions: ReadonlySet<string>): boolean =>
  permissions.has(subcontractsPermissions.amountRead);

/** BR-1: an order is for an active project. */
export function assertProjectActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError(
      'project_not_active',
      'Work orders can be made only for an active project',
    );
  }
}

/** BR-1: the party is an active subcontractor or labour contractor. */
export function assertSubcontractor(
  party: { roles: readonly string[]; status: string } | undefined,
): void {
  if (party === undefined) {
    throw new NotFoundError('party_not_found', 'The subcontractor does not exist');
  }
  if (!party.roles.some((role) => role === 'subcontractor' || role === 'labour_contractor')) {
    throw new RuleViolationError(
      'not_a_subcontractor',
      'The party is not a subcontractor or labour contractor',
    );
  }
  if (party.status !== 'active') {
    throw new RuleViolationError('party_inactive', 'The subcontractor is not active');
  }
}

export function assertCostCodeActive(active: boolean): void {
  if (!active) {
    throw new RuleViolationError('cost_code_inactive', 'The cost code is not active');
  }
}

/** Only a draft can be edited. */
export function assertDraft(status: string, what: string): void {
  if (status !== 'draft') {
    throw new RuleViolationError(`${what}_not_editable`, `Only a draft ${what} can be changed`);
  }
}

/** BR-1: variations and certificates apply to an order that is active. */
export function assertOrderActive(status: string): void {
  if (status !== 'active') {
    throw new RuleViolationError('order_not_active', 'The work order is not active');
  }
}

/**
 * BR-2: certificates are cumulative, so only one is open at a time (the previous cumulative is then
 * the latest certified one).
 */
export function assertNoOpenCertificate(counts: ReadonlyMap<string, number>): void {
  if ((counts.get('draft') ?? 0) + (counts.get('pending_approval') ?? 0) > 0) {
    throw new RuleViolationError(
      'open_certificate',
      'Certify or cancel the open certificate of this work order first',
    );
  }
}

/** BR-6: closing needs every draft certificate dealt with. */
export function assertCanClose(status: string, counts: ReadonlyMap<string, number>): void {
  if (status !== 'active' && status !== 'completed') {
    throw new RuleViolationError(
      'order_not_closable',
      'Only an active or completed order can be closed',
    );
  }
  assertNoOpenCertificate(counts);
}

/** BR-6: an order closed before it is fully certified needs a reason (the closing adjustment). */
export function assertCloseReason(remaining: boolean, reason: string | null): void {
  if (remaining && reason === null) {
    throw new ValidationError(
      'close_reason_required',
      'Give the reason for closing before the contract is fully certified',
    );
  }
}

/** BR-7: an active order with anything certified can only be closed. */
export function assertCanCancel(counts: ReadonlyMap<string, number>): void {
  if ((counts.get('certified') ?? 0) + (counts.get('billed') ?? 0) > 0) {
    throw new RuleViolationError(
      'order_has_certified',
      'Work has been certified; close the work order instead of cancelling it',
    );
  }
  assertNoOpenCertificate(counts);
}

/** Separation of duties: the person who proposed a variation does not approve it. */
export function assertNotOwnVariation(actorId: string, createdBy: string | null): void {
  if (actorId === createdBy) {
    throw new RuleViolationError(
      'own_variation',
      'The person who proposed the variation cannot approve it',
    );
  }
}

/** BR-3: a back-charge that recovers a company cost names the cost code it offsets. */
export function assertRecoveryCode(recoversCost: boolean, costCodeId: string | undefined): void {
  if (recoversCost && costCodeId === undefined) {
    throw new ValidationError(
      'cost_code_required',
      'A back-charge that recovers a cost needs the cost code',
    );
  }
}

/** BR-3: a back-charge is linked to a draft certificate of its own work order. */
export function assertLinkable(
  certificate: { work_order_id: string; status: string } | undefined,
  workOrderId: string,
): void {
  if (certificate === undefined || certificate.work_order_id !== workOrderId) {
    throw new NotFoundError('certificate_not_found', 'Not found');
  }
  assertDraft(certificate.status, 'certificate');
}

/** BR-3: a back-charge on a certificate that is no longer a draft is final. */
export function assertChargeEditable(certificateStatus: string | null): void {
  if (certificateStatus !== null) assertDraft(certificateStatus, 'certificate');
}

/** BR-5: only a certified certificate without a live bill becomes a bill. */
export function assertBillable(status: string, liveBill: boolean): void {
  if (status !== 'certified') {
    throw new RuleViolationError(
      'certificate_not_certified',
      'Only a certified certificate can be billed',
    );
  }
  if (liveBill) {
    throw new RuleViolationError('already_billed', 'A bill already exists for this certificate');
  }
}

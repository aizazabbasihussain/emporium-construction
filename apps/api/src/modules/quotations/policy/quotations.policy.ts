import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from '@emporium/domain';
import { quotationsPermissions, type FileOperation } from '@emporium/shared';

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

/** A reference supplied by the caller must exist. */
export function assertKnown(exists: boolean, code: string, message: string): void {
  if (!exists) throw new ValidationError(code, message);
}

/** BR-1: a quotation is built from a locked estimate only. */
export function assertEstimateLocked(status: string): void {
  if (status !== 'locked') {
    throw new RuleViolationError(
      'estimate_not_locked',
      'A quotation can be made only from a locked estimate',
    );
  }
}

/** BR-4: a quotation has at most one revision in progress. */
export function assertNoOpenRevision(open: boolean): void {
  if (open) {
    throw new ConflictError('revision_open', 'This quotation already has a revision in progress');
  }
}

/** BR-5: an expired quotation cannot be accepted, even before the daily job has marked it. */
export function assertNotPastExpiry(pastExpiry: boolean): void {
  if (pastExpiry) {
    throw new RuleViolationError('quotation_expired', 'The validity of this quotation has passed');
  }
}

/** BR-8: the company profile is needed to print a quotation. */
export function assertCompanyProfile<T>(company: T | null): T {
  if (company === null) {
    throw new RuleViolationError(
      'company_profile_missing',
      'Enter the company profile before printing a quotation',
    );
  }
  return company;
}

/**
 * BR-6: the acceptance document of a quotation. Anyone who may read quotations sees it; adding or
 * removing it needs the permission to accept.
 */
export function canAccessAcceptanceFile(request: {
  permissions: ReadonlySet<string>;
  operation: FileOperation;
  quotationExists: boolean;
}): boolean {
  if (!request.quotationExists) return false;
  return request.operation === 'read'
    ? request.permissions.has(quotationsPermissions.read)
    : request.permissions.has(quotationsPermissions.accept);
}

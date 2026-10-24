import { DomainError } from '@emporium/domain';
import { importerPermissions } from '@emporium/shared';

/** BR-4: only a holder of `importer.batch.force` may re-import a file that was already committed. */
export function assertMayForce(permissions: ReadonlySet<string>, force: boolean): void {
  if (force && !permissions.has(importerPermissions.batchForce)) {
    throw new DomainError(
      'forbidden',
      'permission_denied',
      `Missing permission ${importerPermissions.batchForce}`,
      { permission: importerPermissions.batchForce },
    );
  }
}

/** BR-2: a commit needs a successful dry run of the same file by the same user. */
export function assertOwnDryRun(batchCreatedBy: string | null, userId: string): void {
  if (batchCreatedBy !== userId) {
    throw new DomainError(
      'forbidden',
      'dry_run_by_other_user',
      'Only the user who ran the dry run can commit this batch',
    );
  }
}

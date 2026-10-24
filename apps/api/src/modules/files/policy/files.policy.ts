import { ForbiddenError, NotFoundError } from '@emporium/domain';
import type { FileOperation } from '@emporium/shared';
import { filesPermissions } from '@emporium/shared';
import type { Db, FileAccessCheck, FileActor } from '../types.js';

const permissionFor = {
  upload: filesPermissions.upload,
  read: filesPermissions.read,
  remove: filesPermissions.remove,
} as const satisfies Record<FileOperation, string>;

/** BR-4, section 6: the caller needs the files permission for the operation... */
export function assertFilePermission(actor: FileActor, operation: FileOperation): void {
  if (!actor.permissions.has(permissionFor[operation])) {
    throw new ForbiddenError('forbidden', 'You do not have permission for this file operation');
  }
}

/**
 * ...and the owning entity type's check must agree. A refusal is reported as "not found" so a
 * caller cannot learn which entities exist.
 */
export async function assertEntityAccess(
  check: FileAccessCheck,
  request: { actor: FileActor; entityId: string; operation: FileOperation; db: Db },
): Promise<void> {
  if (!(await check(request))) throw new NotFoundError('entity_not_found', 'Not found');
}

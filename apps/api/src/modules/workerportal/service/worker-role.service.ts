import { WORKER_ROLE, workerportalPermissions } from '@emporium/shared';
import type { Identity } from '../../identity/index.js';
import type { Db } from '../types.js';

/**
 * Start-up step: registers the `worker` role (idempotent, via identity) and, only when this call
 * created it, grants it the permission to read its own records. A role that already exists keeps
 * whatever permissions an admin has set since.
 */
export async function ensureWorkerRole(
  identity: Pick<Identity, 'registerRole' | 'roles'>,
  db: Db,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const created = await identity.registerRole(
      WORKER_ROLE,
      'Worker',
      'Sees only their own attendance, advances and approved wages',
      tx,
    );
    if (created) {
      await identity.roles.setPermissions(
        WORKER_ROLE,
        [workerportalPermissions.selfRead],
        { actorUserId: null, requestId: null },
        tx,
      );
    }
    return created;
  });
}

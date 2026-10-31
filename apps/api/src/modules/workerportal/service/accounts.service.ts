import { NotFoundError } from '@emporium/domain';
import type { Clock } from '@emporium/domain/kernel';
import type { Identity } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Workforce } from '../../workforce/index.js';
import { assertLinkableRoles, assertUserFree } from '../policy/workerportal.policy.js';
import {
  deleteAccountOfWorker,
  findAccountOfUser,
  findAccountOfWorker,
  insertAccount,
  type AccountRow,
} from '../repo/workerportal.repo.js';
import type { AccountDto, Actor, Db } from '../types.js';
import { createRecorder } from './support.js';

export interface AccountsDeps {
  platform: Platform;
  clock: Clock;
  identity: Pick<Identity, 'users'>;
  workforce: Pick<Workforce, 'getWorker'>;
}

export type AccountsService = ReturnType<typeof createAccountsService>;

const accountOf = (row: AccountRow): AccountDto => ({
  userId: row.user_id,
  workerId: row.worker_id,
  linkedBy: row.linked_by,
  linkedAt: new Date(row.linked_at).toISOString(),
});

export function createAccountsService(deps: AccountsDeps) {
  const { platform, clock, identity, workforce } = deps;
  const record = createRecorder(platform);

  return {
    /** `GET /admin/workers/:id/account`: the login linked to the worker, or null. */
    async get(db: Db, workerId: string, actor: Actor): Promise<AccountDto | null> {
      await workforce.getWorker(db, workerId, actor);
      const row = await findAccountOfWorker(db, workerId);
      return row === undefined ? null : accountOf(row);
    },

    /**
     * `PUT /admin/workers/:id/account` (BR-1): links the user to the worker. Linking the same pair
     * again changes nothing; linking another user replaces the earlier login.
     */
    async link(
      workerId: string,
      input: { userId: string; confirmOtherRoles: boolean },
      actor: Actor,
      tx: Db,
    ): Promise<AccountDto> {
      await workforce.getWorker(tx, workerId, actor);
      const user = (await identity.users.list(tx)).find(
        (candidate) => candidate.id === input.userId,
      );
      if (user === undefined) throw new NotFoundError('user_not_found', 'Not found');

      const before = await findAccountOfWorker(tx, workerId, true);
      if (before?.user_id === user.id) return accountOf(before);
      assertUserFree((await findAccountOfUser(tx, user.id))?.worker_id, workerId);
      assertLinkableRoles(user.roles, input.confirmOtherRoles);

      if (before !== undefined) await deleteAccountOfWorker(tx, workerId);
      const row = await insertAccount(tx, {
        userId: user.id,
        workerId,
        linkedBy: actor.userId,
        linkedAt: clock.now(),
      });
      await record(tx, actor, {
        action: 'workerportal.account.link',
        entityType: 'wkp_worker_account',
        entityId: workerId,
        before: before === undefined ? null : { userId: before.user_id },
        after: { userId: row.user_id, otherRolesConfirmed: input.confirmOtherRoles },
        event: {
          type: 'workerportal.account.changed',
          payload: { workerId, userId: row.user_id, change: 'link' },
        },
      });
      return accountOf(row);
    },

    /** `DELETE /admin/workers/:id/account` (BR-1). */
    async unlink(workerId: string, actor: Actor, tx: Db): Promise<void> {
      await workforce.getWorker(tx, workerId, actor);
      const before = await findAccountOfWorker(tx, workerId, true);
      if (before === undefined) throw new NotFoundError('account_not_found', 'Not found');
      await deleteAccountOfWorker(tx, workerId);
      await record(tx, actor, {
        action: 'workerportal.account.unlink',
        entityType: 'wkp_worker_account',
        entityId: workerId,
        before: { userId: before.user_id },
        after: null,
        event: {
          type: 'workerportal.account.changed',
          payload: { workerId, userId: before.user_id, change: 'unlink' },
        },
      });
    },
  };
}

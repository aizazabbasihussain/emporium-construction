import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteAccountOfWorker,
  findAccountOfUser,
  findAccountOfWorker,
  insertAccount,
} from './workerportal.repo.js';
import { ADMIN, LOGIN_A, LOGIN_B, createPortalKit, type PortalKit } from '../test-support.js';

let kit: PortalKit;
beforeAll(async () => {
  kit = await createPortalKit();
}, 120_000);
afterAll(() => kit.close());

describe('worker account repository', () => {
  it('inserts, finds by user and by worker, and deletes', async () => {
    const worker = kit.workerA.id;
    expect(await findAccountOfUser(kit.db, LOGIN_A)).toBeUndefined();
    expect(await findAccountOfWorker(kit.db, worker)).toBeUndefined();

    const row = await insertAccount(kit.db, {
      userId: LOGIN_A,
      workerId: worker,
      linkedBy: ADMIN,
      linkedAt: new Date('2026-10-25T10:00:00Z'),
    });
    expect(row).toMatchObject({ user_id: LOGIN_A, worker_id: worker, linked_by: ADMIN });
    expect(await findAccountOfUser(kit.db, LOGIN_A)).toEqual(row);
    expect(await findAccountOfWorker(kit.db, worker, true)).toEqual(row);

    await deleteAccountOfWorker(kit.db, worker);
    expect(await findAccountOfUser(kit.db, LOGIN_A)).toBeUndefined();
  });

  it('allows at most one login per worker and one worker per login', async () => {
    const at = new Date('2026-10-25T10:00:00Z');
    await insertAccount(kit.db, {
      userId: LOGIN_B,
      workerId: kit.workerB.id,
      linkedBy: ADMIN,
      linkedAt: at,
    });
    await expect(
      insertAccount(kit.db, {
        userId: LOGIN_A,
        workerId: kit.workerB.id,
        linkedBy: ADMIN,
        linkedAt: at,
      }),
    ).rejects.toThrow();
    await expect(
      insertAccount(kit.db, {
        userId: LOGIN_B,
        workerId: kit.workerA.id,
        linkedBy: ADMIN,
        linkedAt: at,
      }),
    ).rejects.toThrow();
    await deleteAccountOfWorker(kit.db, kit.workerB.id);
  });
});

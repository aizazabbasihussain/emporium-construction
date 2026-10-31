import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  LOGIN_A,
  LOGIN_B,
  LOGIN_MIXED,
  auditCount,
  createPortalKit,
  eventCount,
  type PortalKit,
} from '../test-support.js';

let kit: PortalKit;
beforeAll(async () => {
  kit = await createPortalKit();
}, 120_000);
afterAll(() => kit.close());

const MISSING = '018f0000-0000-7000-8000-000000000999';
const errorCode = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('accounts service (BR-1)', () => {
  it('links a worker-only login, audits it and emits an event', async () => {
    const admin = await kit.actorFor(ADMIN);
    expect(await kit.workerPortal.accounts.get(kit.db, kit.workerA.id, admin)).toBeNull();

    const account = await kit.db.transaction((tx) =>
      kit.workerPortal.accounts.link(
        kit.workerA.id,
        { userId: LOGIN_A, confirmOtherRoles: false },
        admin,
        tx,
      ),
    );
    expect(account).toMatchObject({
      userId: LOGIN_A,
      workerId: kit.workerA.id,
      linkedBy: ADMIN,
      linkedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(await kit.workerPortal.accounts.get(kit.db, kit.workerA.id, admin)).toEqual(account);
    expect(await auditCount(kit.db, 'workerportal.account.link')).toBe(1);
    expect(await eventCount(kit.db, 'workerportal.account.changed')).toBe(1);
  });

  it('changes nothing when the same pair is linked again', async () => {
    const admin = await kit.actorFor(ADMIN);
    const again = await kit.db.transaction((tx) =>
      kit.workerPortal.accounts.link(
        kit.workerA.id,
        { userId: LOGIN_A, confirmOtherRoles: false },
        admin,
        tx,
      ),
    );
    expect(again.userId).toBe(LOGIN_A);
    expect(await auditCount(kit.db, 'workerportal.account.link')).toBe(1);
  });

  it('refuses a login that already belongs to another worker', async () => {
    const admin = await kit.actorFor(ADMIN);
    expect(
      await errorCode(() =>
        kit.db.transaction((tx) =>
          kit.workerPortal.accounts.link(
            kit.workerB.id,
            { userId: LOGIN_A, confirmOtherRoles: false },
            admin,
            tx,
          ),
        ),
      ),
    ).toBe('user_already_linked');
  });

  it('replaces the earlier login of the worker', async () => {
    const admin = await kit.actorFor(ADMIN);
    await kit.db.transaction((tx) =>
      kit.workerPortal.accounts.link(
        kit.workerA.id,
        { userId: LOGIN_B, confirmOtherRoles: false },
        admin,
        tx,
      ),
    );
    expect((await kit.workerPortal.accounts.get(kit.db, kit.workerA.id, admin))?.userId).toBe(
      LOGIN_B,
    );
    const audits = await kit.db.query<{ before: unknown; after: unknown }>(
      `select before, after from sys_audit_log
        where action = 'workerportal.account.link' and entity_id = $1
        order by at desc, id desc limit 1`,
      [kit.workerA.id],
    );
    expect(audits[0]?.before).toEqual({ userId: LOGIN_A });
  });

  it('needs the admin to confirm a login with other roles', async () => {
    const admin = await kit.actorFor(ADMIN);
    expect(
      await errorCode(() =>
        kit.db.transaction((tx) =>
          kit.workerPortal.accounts.link(
            kit.workerB.id,
            { userId: LOGIN_MIXED, confirmOtherRoles: false },
            admin,
            tx,
          ),
        ),
      ),
    ).toBe('user_has_other_roles');
    expect(await kit.workerPortal.accounts.get(kit.db, kit.workerB.id, admin)).toBeNull();

    await kit.link(kit.workerB.id, LOGIN_MIXED, true);
    expect((await kit.workerPortal.accounts.get(kit.db, kit.workerB.id, admin))?.userId).toBe(
      LOGIN_MIXED,
    );
  });

  it('reports an unknown worker or user as not found', async () => {
    const admin = await kit.actorFor(ADMIN);
    expect(
      await errorCode(() =>
        kit.db.transaction((tx) =>
          kit.workerPortal.accounts.link(
            MISSING,
            { userId: LOGIN_A, confirmOtherRoles: false },
            admin,
            tx,
          ),
        ),
      ),
    ).toBe('worker_not_found');
    expect(
      await errorCode(() =>
        kit.db.transaction((tx) =>
          kit.workerPortal.accounts.link(
            kit.workerA.id,
            { userId: MISSING, confirmOtherRoles: false },
            admin,
            tx,
          ),
        ),
      ),
    ).toBe('user_not_found');
    expect(await errorCode(() => kit.workerPortal.accounts.get(kit.db, MISSING, admin))).toBe(
      'worker_not_found',
    );
  });

  it('unlinks, audits it, and reports a second unlink as not found', async () => {
    const admin = await kit.actorFor(ADMIN);
    await kit.db.transaction((tx) => kit.workerPortal.accounts.unlink(kit.workerA.id, admin, tx));
    expect(await kit.workerPortal.accounts.get(kit.db, kit.workerA.id, admin)).toBeNull();
    expect(await auditCount(kit.db, 'workerportal.account.unlink')).toBe(1);
    expect(
      await errorCode(() =>
        kit.db.transaction((tx) => kit.workerPortal.accounts.unlink(kit.workerA.id, admin, tx)),
      ),
    ).toBe('account_not_found');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortalKit, type PortalKit } from '../test-support.js';
import { ensureWorkerRole } from './worker-role.service.js';

let kit: PortalKit;
beforeAll(async () => {
  kit = await createPortalKit();
}, 120_000);
afterAll(() => kit.close());

describe('ensureWorkerRole', () => {
  it('created the worker role with its one permission at start-up', async () => {
    const role = (await kit.identity.roles.list(kit.db)).find((r) => r.code === 'worker');
    expect(role).toMatchObject({ name: 'Worker', permissions: ['workerportal.self.read'] });
  });

  it('leaves an existing role, and what an admin set on it, untouched', async () => {
    await kit.db.transaction((tx) =>
      kit.identity.roles.setPermissions('worker', [], { actorUserId: null, requestId: null }, tx),
    );
    expect(await ensureWorkerRole(kit.identity, kit.db)).toBe(false);
    const role = (await kit.identity.roles.list(kit.db)).find((r) => r.code === 'worker');
    expect(role?.permissions).toEqual([]);
  });
});

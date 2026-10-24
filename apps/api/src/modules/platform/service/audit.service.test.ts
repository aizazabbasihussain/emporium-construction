import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ID, createKernel, type Kernel } from '../test-support.js';

let k: Kernel;

beforeAll(async () => {
  k = await createKernel();
}, 60_000);

describe('audit (T-6, BR-8)', () => {
  it('records before and after, omits secrets, and is searchable', async () => {
    await k.db.transaction((tx) =>
      k.platform.audit.record(
        {
          actorUserId: ADMIN_ID,
          action: 'user.update',
          entityType: 'user',
          entityId: 'u1',
          before: { name: 'A', password: 'old' },
          after: { name: 'B', password: 'new', token: 't' },
          requestId: 'req-9',
        },
        tx,
      ),
    );
    const rows = await k.platform.audit.search(k.db, {
      entityType: 'user',
      entityId: 'u1',
      actorUserId: ADMIN_ID,
      from: '2020-01-01T00:00:00Z',
      to: '2100-01-01T00:00:00Z',
      limit: 10,
      offset: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: 'req-9',
      before: { name: 'A', password: '[redacted]' },
      after: { name: 'B', password: '[redacted]', token: '[redacted]' },
    });
  });

  it('stores null for missing before, after and entity id', async () => {
    await k.db.transaction((tx) =>
      k.platform.audit.record(
        { actorUserId: null, action: 'system.start', entityType: 'system' },
        tx,
      ),
    );
    const [row] = await k.platform.audit.search(k.db, {
      entityType: 'system',
      limit: 1,
      offset: 0,
    });
    expect(row).toMatchObject({ actor_user_id: null, entity_id: null, before: null, after: null });
  });

  it('shares the caller transaction: a rollback removes the audit row', async () => {
    await expect(
      k.db.transaction(async (tx) => {
        await k.platform.audit.record({ actorUserId: null, action: 'x', entityType: 'rolled' }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await k.platform.audit.search(k.db, { entityType: 'rolled', limit: 5, offset: 0 }),
    ).toEqual([]);
  });

  it('cannot be updated or deleted through the database', async () => {
    await expect(k.db.query("update sys_audit_log set action = 'tampered'")).rejects.toThrow(
      /append-only/,
    );
    await expect(k.db.query('delete from sys_audit_log')).rejects.toThrow(/append-only/);
  });

  it('lets another module allocate a number, publish an event and audit in one transaction (AC-1)', async () => {
    const number = await k.db.transaction(async (tx) => {
      const n = await k.platform.numbering.next('invoice', tx);
      await k.platform.events.publish({ type: 'invoice.issued', payload: { number: n } }, tx);
      await k.platform.audit.record(
        { actorUserId: ADMIN_ID, action: 'invoice.issue', entityType: 'invoice', entityId: n },
        tx,
      );
      return n;
    });
    expect(number).toBe('INV-2026-0001');
    const events = await k.db.query<{ payload: { number: string } }>(
      "select payload from sys_outbox where type = 'invoice.issued'",
    );
    expect(events[0]?.payload.number).toBe(number);
    expect(
      await k.platform.audit.search(k.db, {
        entityType: 'invoice',
        entityId: number,
        limit: 1,
        offset: 0,
      }),
    ).toHaveLength(1);

    // And all three disappear together on rollback.
    await expect(
      k.db.transaction(async (tx) => {
        await k.platform.numbering.next('invoice', tx);
        await k.platform.events.publish({ type: 'invoice.issued', payload: {} }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(await k.db.query("select 1 from sys_outbox where type = 'invoice.issued'")).toHaveLength(
      1,
    );
  });
});

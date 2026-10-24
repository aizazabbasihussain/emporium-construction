import { BusinessDate } from '@emporium/domain/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ID, createKernel, type Kernel } from '../test-support.js';

let k: Kernel;
const ctx = { actorUserId: ADMIN_ID, requestId: 'req-1' };

beforeAll(async () => {
  k = await createKernel();
}, 60_000);

const set = (value: unknown, expectedVersion: number) =>
  k.db.transaction((tx) =>
    k.platform.settings.set({ key: 'backdating_days', value, expectedVersion }, ctx, tx),
  );

describe('settings (T-7)', () => {
  it('returns the seeded value', async () => {
    expect(await k.platform.settings.get(k.db, 'backdating_days')).toMatchObject({
      value: 3,
      version: 1,
    });
  });

  it('rejects unknown keys and wrong types', async () => {
    await expect(k.platform.settings.get(k.db, 'nope')).rejects.toMatchObject({
      code: 'unknown_setting',
    });
    await expect(set('5', 1)).rejects.toMatchObject({ code: 'invalid_setting' });
  });

  it('updates with the expected version, audits, and conflicts on a stale version', async () => {
    const saved = await set(7, 1);
    expect(saved).toMatchObject({ value: 7, version: 2 });
    await expect(set(8, 1)).rejects.toMatchObject({ code: 'version_conflict' });
    const audit = await k.platform.audit.search(k.db, {
      entityType: 'setting',
      limit: 5,
      offset: 0,
    });
    expect(audit[0]).toMatchObject({ action: 'setting.update', actor_user_id: ADMIN_ID });
    expect(audit[0]?.before).toMatchObject({ value: 3 });
    expect(audit[0]?.after).toMatchObject({ value: 7 });
  });

  it('falls back to the registry default and creates the row on first save', async () => {
    await k.db.query("delete from sys_settings where key = 'backdating_days'");
    expect(await k.platform.settings.get(k.db, 'backdating_days')).toMatchObject({
      value: 3,
      version: 0,
    });
    await expect(set(4, 5)).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await set(4, 0)).toMatchObject({ value: 4, version: 1 });
  });
});

describe('backdating service (T-3, BR-5)', () => {
  const today = BusinessDate.parse('2026-10-24');
  const check = (daysAgo: number, canOverride: boolean, reason?: string) =>
    k.db.transaction((tx) =>
      k.platform.backdating.check(
        {
          date: today.addDays(-daysAgo),
          canOverride,
          reason,
          actorUserId: ADMIN_ID,
          requestId: 'req-2',
          entityType: 'voucher',
          entityId: 'v1',
        },
        tx,
      ),
    );

  it('uses the configured allowance (4 here) at its boundary', async () => {
    await expect(check(0, false)).resolves.toBeUndefined();
    await expect(check(4, false)).resolves.toBeUndefined();
    await expect(check(5, false)).rejects.toMatchObject({ code: 'backdating_not_allowed' });
  });

  it('accepts an override with permission and reason and audits who, date and reason', async () => {
    await check(30, true, 'Paper voucher found late');
    const audit = await k.platform.audit.search(k.db, {
      entityType: 'voucher',
      entityId: 'v1',
      limit: 5,
      offset: 0,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'backdate.override',
      actor_user_id: ADMIN_ID,
      after: { date: '2026-09-24', reason: 'Paper voucher found late' },
    });
  });

  it('rejects an override without permission or without reason, and writes no audit', async () => {
    await expect(check(30, false, 'reason')).rejects.toMatchObject({
      code: 'backdating_not_allowed',
    });
    await expect(check(30, true)).rejects.toMatchObject({ code: 'backdating_reason_required' });
    const audit = await k.platform.audit.search(k.db, {
      entityType: 'voucher',
      limit: 5,
      offset: 0,
    });
    expect(audit).toHaveLength(1);
  });

  it('audits an override without request or entity ids as nulls', async () => {
    await k.db.transaction((tx) =>
      k.platform.backdating.check(
        {
          date: today.addDays(-40),
          canOverride: true,
          reason: 'r',
          actorUserId: null,
          entityType: 'bare',
        },
        tx,
      ),
    );
    const [row] = await k.platform.audit.search(k.db, { entityType: 'bare', limit: 1, offset: 0 });
    expect(row).toMatchObject({ entity_id: null, request_id: null, actor_user_id: null });
  });

  it('does not audit dates inside the allowance', async () => {
    await check(1, true, 'not needed');
    expect(
      await k.platform.audit.search(k.db, { entityType: 'voucher', limit: 5, offset: 0 }),
    ).toHaveLength(1);
  });
});

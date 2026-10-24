import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ID, createKernel, type Kernel } from '../test-support.js';

let k: Kernel;
const ctx = { actorUserId: ADMIN_ID, requestId: 'req-1' };

beforeAll(async () => {
  k = await createKernel();
}, 60_000);

const next = (code: string) => k.db.transaction((tx) => k.platform.numbering.next(code, tx));

describe('numbering (T-1)', () => {
  it('allocates sequential seeded numbers INV-2026-0001, 0002 (H-27)', async () => {
    expect(await next('invoice')).toBe('INV-2026-0001');
    expect(await next('invoice')).toBe('INV-2026-0002');
    expect(await next('quotation')).toBe('QUO-2026-0001');
  });

  it('releases a number when the transaction rolls back', async () => {
    await expect(
      k.db.transaction(async (tx) => {
        expect(await k.platform.numbering.next('invoice', tx)).toBe('INV-2026-0003');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await next('invoice')).toBe('INV-2026-0003');
  });

  it('resets yearly on the first allocation of a new business year', async () => {
    k.clock.set('2026-12-31T20:00:00Z'); // already 2027-01-01 in Karachi
    expect(await next('invoice')).toBe('INV-2027-0001');
    expect(await next('invoice')).toBe('INV-2027-0002');
    k.clock.set('2026-10-24T10:00:00Z');
  });

  it('reports an unknown series', async () => {
    await expect(next('nope')).rejects.toMatchObject({ code: 'series_not_found' });
  });

  it('keeps 10 parallel allocations unique and gapless (AC-2)', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => next('purchase_order')));
    const numbers = results.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    expect(new Set(results).size).toBe(10);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('number series administration', () => {
  const input = {
    code: 'credit_note',
    prefix: 'CN',
    padding: 3,
    resetYearly: false,
    gapless: true,
    startValue: 5,
  };

  it('creates a series that starts at its start value and audits it', async () => {
    const created = await k.db.transaction((tx) => k.platform.numbering.save(input, ctx, tx));
    expect(created).toMatchObject({ code: 'credit_note', nextValue: 5, version: 1 });
    expect(await next('credit_note')).toBe('CN-005');
    const audit = await k.platform.audit.search(k.db, {
      entityType: 'number_series',
      entityId: 'credit_note',
      limit: 10,
      offset: 0,
    });
    expect(audit.map((a) => a.action)).toEqual(['number_series.create']);
  });

  it('lists series', async () => {
    const list = await k.platform.numbering.list(k.db);
    expect(list.map((s) => s.code)).toContain('credit_note');
  });

  it('refuses to create an existing series and to update a missing one', async () => {
    await expect(
      k.db.transaction((tx) => k.platform.numbering.save(input, ctx, tx)),
    ).rejects.toMatchObject({ code: 'series_exists' });
    await expect(
      k.db.transaction((tx) =>
        k.platform.numbering.save({ ...input, code: 'ghost', version: 1 }, ctx, tx),
      ),
    ).rejects.toMatchObject({ code: 'series_not_found' });
  });

  it('keeps a used gapless series from being rewound or relaxed (BR-2)', async () => {
    const save = (patch: object) =>
      k.db.transaction((tx) =>
        k.platform.numbering.save({ ...input, version: 1, ...patch }, ctx, tx),
      );
    await expect(save({ nextValue: 1 })).rejects.toMatchObject({ code: 'gapless_series_locked' });
    await expect(save({ gapless: false })).rejects.toMatchObject({
      code: 'gapless_series_locked',
    });
    const renamed = await save({ prefix: 'CRN' });
    expect(renamed).toMatchObject({ prefix: 'CRN', nextValue: 6, version: 2 });
    expect(await next('credit_note')).toBe('CRN-006');
  });

  it('applies edits to new documents only and rejects a stale version', async () => {
    await next('variation');
    const edited = await k.db.transaction((tx) =>
      k.platform.numbering.save(
        {
          code: 'variation',
          prefix: 'VO',
          padding: 5,
          resetYearly: true,
          gapless: false,
          startValue: 1,
          nextValue: 50,
          version: 1,
        },
        ctx,
        tx,
      ),
    );
    expect(edited.nextValue).toBe(50);
    expect(await next('variation')).toBe('VO-2026-00050');
    await expect(
      k.db.transaction((tx) =>
        k.platform.numbering.save(
          {
            code: 'variation',
            prefix: 'VO',
            padding: 5,
            resetYearly: true,
            gapless: false,
            startValue: 1,
            version: 1,
          },
          ctx,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
});

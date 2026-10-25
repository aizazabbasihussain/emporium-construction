import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createQuotationsKit, uid, type QuotationsKit } from '../test-support.js';
import {
  findQuotation,
  insertHistory,
  insertQuotation,
  listHistory,
  listIssuedExpiredBefore,
  listStages,
  openRevisionExists,
  replaceStages,
  searchQuotations,
  softDeleteQuotation,
  updateQuotation,
} from './quotations.repo.js';

let kit: QuotationsKit;
const at = new Date('2026-10-25T10:00:00Z');

beforeAll(async () => {
  kit = await createQuotationsKit();
}, 60_000);
afterAll(() => kit.close());

const quotation = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(200 + n),
  number: `RQ-${n}`,
  estimate_id: uid(900),
  party_id: uid(901),
  title: `Repo quotation ${n}`,
  sector: 'private',
  validity_days: 30,
  price: '1000.5',
  ...extra,
});

describe('quotations (integration, PGlite)', () => {
  it('inserts, finds, updates and soft-deletes with the version check', async () => {
    const row = await insertQuotation(kit.db, quotation(1), ADMIN, at);
    expect(row).toMatchObject({
      number: 'RQ-1',
      revision: 1,
      status: 'draft',
      price: '1000.50',
      scope_text: '',
      issued_at: null,
      expires_on: null,
      parent_id: null,
      version: 1,
    });
    expect(await findQuotation(kit.db, row.id)).toEqual(row);
    expect(await findQuotation(kit.db, row.id, true)).toEqual(row);
    expect(await findQuotation(kit.db, uid(999))).toBeUndefined();

    const updated = await updateQuotation(kit.db, row.id, 1, { title: 'Changed' }, ADMIN, at);
    expect(updated).toMatchObject({ title: 'Changed', version: 2 });
    expect(await updateQuotation(kit.db, row.id, 1, { title: 'Stale' }, null, at)).toBeUndefined();
    expect(await softDeleteQuotation(kit.db, row.id, 1, ADMIN, at)).toBe(false);
    expect(await softDeleteQuotation(kit.db, row.id, 2, ADMIN, at)).toBe(true);
    expect(await findQuotation(kit.db, row.id)).toBeUndefined();
  });

  it('keeps a number and revision unique and refuses a non-positive price', async () => {
    await insertQuotation(kit.db, quotation(2), ADMIN, at);
    await expect(
      insertQuotation(kit.db, quotation(2, { id: uid(299) }), ADMIN, at),
    ).rejects.toThrow();
    await expect(
      insertQuotation(kit.db, quotation(3, { price: '0' }), ADMIN, at),
    ).rejects.toThrow();
    await expect(
      insertQuotation(kit.db, quotation(4, { validity_days: 0 }), ADMIN, at),
    ).rejects.toThrow();
  });

  it('finds an open revision of a parent', async () => {
    const parent = await insertQuotation(kit.db, quotation(5), ADMIN, at);
    expect(await openRevisionExists(kit.db, parent.id)).toBe(false);
    const child = await insertQuotation(
      kit.db,
      quotation(6, { number: 'RQ-5', revision: 2, parent_id: parent.id }),
      ADMIN,
      at,
    );
    expect(await openRevisionExists(kit.db, parent.id)).toBe(true);
    // A second open revision of the same parent is refused by the database.
    await expect(
      insertQuotation(
        kit.db,
        quotation(7, { number: 'RQ-5', revision: 3, parent_id: parent.id }),
        ADMIN,
        at,
      ),
    ).rejects.toThrow();
    await updateQuotation(kit.db, child.id, 1, { status: 'pending_approval' }, ADMIN, at);
    expect(await openRevisionExists(kit.db, parent.id)).toBe(true);
    await updateQuotation(kit.db, child.id, 2, { status: 'issued' }, ADMIN, at);
    expect(await openRevisionExists(kit.db, parent.id)).toBe(false);
  });

  it('replaces the stages as a whole, in order', async () => {
    const row = await insertQuotation(kit.db, quotation(8), ADMIN, at);
    const stage = (n: number, extra: Record<string, unknown> = {}) => ({
      id: uid(300 + n),
      stage_no: n,
      name: `Stage ${n}`,
      basis: 'percent',
      percent: '50',
      amount: '500.25',
      ...extra,
    });
    await replaceStages(kit.db, row.id, [stage(2, { condition_text: 'On roof' }), stage(1)]);
    expect(await listStages(kit.db, row.id)).toEqual([
      {
        stage_no: 1,
        name: 'Stage 1',
        basis: 'percent',
        percent: '50.0000',
        amount: '500.25',
        condition_text: null,
      },
      {
        stage_no: 2,
        name: 'Stage 2',
        basis: 'percent',
        percent: '50.0000',
        amount: '500.25',
        condition_text: 'On roof',
      },
    ]);
    await replaceStages(kit.db, row.id, [stage(9)]);
    expect(await listStages(kit.db, row.id)).toHaveLength(1);
    await expect(replaceStages(kit.db, row.id, [stage(1, { percent: '0' })])).rejects.toThrow();
  });

  it('writes and reads the status history in order', async () => {
    const row = await insertQuotation(kit.db, quotation(9), ADMIN, at);
    await insertHistory(kit.db, {
      id: uid(401),
      quotationId: row.id,
      from: null,
      to: 'draft',
      at,
      by: ADMIN,
      note: null,
    });
    await insertHistory(kit.db, {
      id: uid(402),
      quotationId: row.id,
      from: 'draft',
      to: 'pending_approval',
      at: new Date('2026-10-25T11:00:00Z'),
      by: null,
      note: 'sent',
    });
    const history = await listHistory(kit.db, row.id);
    expect(history.map((h) => [h.from_status, h.to_status, h.changed_by, h.note])).toEqual([
      [null, 'draft', ADMIN, null],
      ['draft', 'pending_approval', null, 'sent'],
    ]);
  });

  it('lists issued quotations whose expiry date is before a day', async () => {
    const issued = await insertQuotation(
      kit.db,
      quotation(10, { status: 'issued', issued_at: at.toISOString(), expires_on: '2026-11-01' }),
      ADMIN,
      at,
    );
    await insertQuotation(
      kit.db,
      quotation(11, { status: 'issued', issued_at: at.toISOString(), expires_on: '2026-11-02' }),
      ADMIN,
      at,
    );
    await insertQuotation(
      kit.db,
      quotation(12, { status: 'accepted', expires_on: '2026-11-01' }),
      ADMIN,
      at,
    );
    expect((await listIssuedExpiredBefore(kit.db, '2026-11-01')).map((r) => r.id)).not.toContain(
      issued.id,
    );
    const due = await listIssuedExpiredBefore(kit.db, '2026-11-02');
    expect(due.map((r) => r.number)).toContain('RQ-10');
    expect(due.map((r) => r.number)).not.toContain('RQ-11');
    expect(due.map((r) => r.number)).not.toContain('RQ-12');
    expect(due.find((r) => r.number === 'RQ-10')?.expires_on).toBe('2026-11-01');
  });

  it('searches by text, status, lead, party and estimate, and pages', async () => {
    const lead = uid(950);
    const party = uid(951);
    const estimate = uid(952);
    await insertQuotation(
      kit.db,
      quotation(13, { lead_id: lead, party_id: party, estimate_id: estimate, status: 'approved' }),
      ADMIN,
      at,
    );
    const q = { limit: 10, offset: 0 };
    expect((await searchQuotations(kit.db, { ...q, leadId: lead })).total).toBe(1);
    expect((await searchQuotations(kit.db, { ...q, partyId: party })).rows[0]?.number).toBe(
      'RQ-13',
    );
    expect((await searchQuotations(kit.db, { ...q, estimateId: estimate })).total).toBe(1);
    expect((await searchQuotations(kit.db, { ...q, status: 'approved', leadId: lead })).total).toBe(
      1,
    );
    expect((await searchQuotations(kit.db, { ...q, status: 'draft', leadId: lead })).total).toBe(0);
    expect((await searchQuotations(kit.db, { ...q, q: '100%' })).total).toBe(0);
    expect((await searchQuotations(kit.db, { ...q, q: 'repo quotation 13' })).total).toBe(1);
    expect((await searchQuotations(kit.db, { ...q, q: ' ' })).total).toBeGreaterThan(1);
    const paged = await searchQuotations(kit.db, { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBeGreaterThan(1);
  });
});

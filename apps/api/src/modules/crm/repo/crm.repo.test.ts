import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createCrmKit, type CrmKit } from '../test-support.js';
import {
  cancelOpenFollowUps,
  findFollowUp,
  findLead,
  findStage,
  firstOpenStage,
  insertFollowUp,
  insertHistory,
  insertLead,
  insertVisit,
  leadsForPipeline,
  listHistory,
  listLossReasons,
  listSources,
  listStages,
  listVisits,
  lossReasonExists,
  markWonEventEmitted,
  openFollowUpDates,
  openFollowUpExists,
  openFollowUpsForLeads,
  searchFollowUps,
  searchLeads,
  softDeleteLead,
  sourceExists,
  updateFollowUp,
  updateLead,
  visitExists,
} from './crm.repo.js';

let kit: CrmKit;
const at = new Date('2026-10-25T10:00:00Z');
const uid = (n: number) => `018f7d7d-0000-7000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  kit = await createCrmKit();
}, 60_000);
afterAll(() => kit.close());

const lead = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(n),
  number: `T-${n}`,
  contact_name: 'Repo Contact',
  contact_phone: '+923001234567',
  work_type: 'other',
  sector: 'private',
  source_code: 'phone',
  stage_code: 'new',
  owner_user_id: ADMIN,
  ...extra,
});

describe('crm repository (integration, PGlite)', () => {
  it('reads the seeded reference data', async () => {
    expect((await listStages(kit.db)).map((s) => s.code)).toEqual([
      'new',
      'visited',
      'quoted',
      'negotiation',
      'won',
      'lost',
    ]);
    expect(await findStage(kit.db, 'won')).toMatchObject({ kind: 'won', active: true });
    expect(await findStage(kit.db, 'nope')).toBeUndefined();
    expect((await firstOpenStage(kit.db))?.code).toBe('new');
    expect((await listSources(kit.db)).length).toBeGreaterThan(3);
    expect((await listLossReasons(kit.db)).length).toBeGreaterThan(3);
    expect(await sourceExists(kit.db, 'phone')).toBe(true);
    expect(await sourceExists(kit.db, 'nope')).toBe(false);
    expect(await lossReasonExists(kit.db, 'price')).toBe(true);
    expect(await lossReasonExists(kit.db, 'nope')).toBe(false);
  });

  it('inserts, finds, updates and soft-deletes a lead with optimistic versions', async () => {
    await insertLead(kit.db, lead(1, { expected_value: '10.50' }), ADMIN, at);
    const found = await findLead(kit.db, uid(1), true);
    expect(found).toMatchObject({
      number: 'T-1',
      expected_value: '10.50',
      stage_kind: 'open',
      version: 1,
      won_event_emitted: false,
    });
    expect(
      await updateLead(kit.db, uid(1), 5, { sector: 'government' }, ADMIN, at),
    ).toBeUndefined();
    expect(await updateLead(kit.db, uid(1), 1, { sector: 'government' }, ADMIN, at)).toEqual({
      id: uid(1),
    });
    expect((await findLead(kit.db, uid(1)))?.sector).toBe('government');
    await markWonEventEmitted(kit.db, uid(1));
    expect((await findLead(kit.db, uid(1)))?.won_event_emitted).toBe(true);
    expect(await softDeleteLead(kit.db, uid(1), 1, ADMIN, at)).toBe(false);
    expect(await softDeleteLead(kit.db, uid(1), 2, ADMIN, at)).toBe(true);
    expect(await findLead(kit.db, uid(1))).toBeUndefined();
  });

  it('enforces the contact rule and unique numbers in the database', async () => {
    await expect(insertLead(kit.db, lead(2, { contact_phone: null }), ADMIN, at)).rejects.toThrow();
    await insertLead(kit.db, lead(3), ADMIN, at);
    await expect(insertLead(kit.db, lead(4, { number: 'T-3' }), ADMIN, at)).rejects.toThrow();
  });

  it('searches with every filter and sort', async () => {
    await insertLead(kit.db, lead(5, { description: '100% marble_floor' }), ADMIN, at);
    const base = { sort: 'number' as const, direction: 'asc' as const, limit: 10, offset: 0 };
    expect((await searchLeads(kit.db, { ...base, q: '100%' })).rows.map((r) => r.id)).toEqual([
      uid(5),
    ]);
    expect((await searchLeads(kit.db, { ...base, q: 'marble_' })).total).toBe(1);
    expect((await searchLeads(kit.db, { ...base, q: '%' })).total).toBe(1);
    const filtered = await searchLeads(kit.db, {
      ...base,
      stageCode: 'new',
      sector: 'private',
      ownerUserId: ADMIN,
      overdueBefore: '2026-10-25',
    });
    expect(filtered.total).toBe(0);
    for (const sort of ['number', 'created', 'value', 'stage'] as const) {
      const { rows } = await searchLeads(kit.db, { ...base, sort, direction: 'desc' });
      expect(rows.length).toBeGreaterThan(0);
    }
    expect((await leadsForPipeline(kit.db)).length).toBeGreaterThan(0);
  });

  it('keeps an append-only stage history', async () => {
    await insertHistory(kit.db, { leadId: uid(3), from: null, to: 'new', at, by: ADMIN });
    await insertHistory(kit.db, { leadId: uid(3), from: 'new', to: 'visited', at, by: ADMIN });
    expect((await listHistory(kit.db, uid(3))).map((h) => h.to_stage)).toEqual(['new', 'visited']);
  });

  it('stores visits with plain dates', async () => {
    const visit = await insertVisit(
      kit.db,
      { id: uid(10), lead_id: uid(3), visit_date: '2026-10-24', visited_by: ADMIN, notes: null },
      ADMIN,
      at,
    );
    expect(visit.visit_date).toBe('2026-10-24');
    expect((await listVisits(kit.db, uid(3))).map((v) => v.id)).toEqual([uid(10)]);
    expect(await visitExists(kit.db, uid(10))).toBe(true);
    expect(await visitExists(kit.db, uid(11))).toBe(false);
  });

  it('allows one open follow-up per lead, assignee and date', async () => {
    const values = (n: number) => ({
      id: uid(n),
      lead_id: uid(3),
      due_date: '2026-10-30',
      assigned_to: ADMIN,
      status: 'open',
    });
    await insertFollowUp(kit.db, values(20), ADMIN, at);
    await expect(insertFollowUp(kit.db, values(21), ADMIN, at)).rejects.toThrow();
    expect(await openFollowUpExists(kit.db, uid(3), ADMIN, '2026-10-30')).toBe(true);
    expect(await openFollowUpExists(kit.db, uid(3), ADMIN, '2026-10-31')).toBe(false);

    const found = await findFollowUp(kit.db, uid(20), true);
    expect(found).toMatchObject({ due_date: '2026-10-30', lead_number: 'T-3', status: 'open' });
    expect(await findFollowUp(kit.db, uid(29))).toBeUndefined();

    expect(await openFollowUpsForLeads(kit.db, [])).toEqual([]);
    expect(await openFollowUpsForLeads(kit.db, [uid(3)])).toHaveLength(1);
    expect((await openFollowUpDates(kit.db)).length).toBeGreaterThan(0);
    expect((await searchFollowUps(kit.db, { leadId: uid(3), limit: 5, offset: 0 })).total).toBe(1);
    expect(
      (await searchFollowUps(kit.db, { assignedTo: uid(99), status: 'done', limit: 5, offset: 0 }))
        .total,
    ).toBe(0);

    expect(await updateFollowUp(kit.db, uid(20), 7, { status: 'done' }, ADMIN, at)).toBeUndefined();
    expect(await cancelOpenFollowUps(kit.db, uid(3), ADMIN, at)).toBe(1);
    expect(await cancelOpenFollowUps(kit.db, uid(3), ADMIN, at)).toBe(0);
    expect((await findFollowUp(kit.db, uid(20)))?.status).toBe('cancelled');
    // The slot is free again once the follow-up is no longer open.
    await insertFollowUp(kit.db, values(22), ADMIN, at);
  });
});

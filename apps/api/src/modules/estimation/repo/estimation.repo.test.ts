import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createEstimationKit, uid, type EstimationKit } from '../test-support.js';
import {
  findEstimate,
  findLockedTotals,
  findTemplate,
  insertEstimate,
  insertTemplate,
  listEstimateLines,
  listTemplateLines,
  openRevisionExists,
  replaceEstimateLines,
  replaceTemplateLines,
  searchEstimates,
  searchTemplates,
  softDeleteEstimate,
  softDeleteTemplate,
  templateCodeTaken,
  updateEstimate,
  updateTemplate,
} from './estimation.repo.js';

let kit: EstimationKit;
const at = new Date('2026-10-25T10:00:00Z');

beforeAll(async () => {
  kit = await createEstimationKit();
}, 60_000);
afterAll(() => kit.close());

const template = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(100 + n),
  code: `R-${n}`,
  name: `Repo template ${n}`,
  work_type: 'room',
  parameters: JSON.stringify([{ key: 'area', label: 'Area', unit: 'sqft' }]),
  ...extra,
});

const estimate = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(200 + n),
  number: `RE-${n}`,
  title: `Repo estimate ${n}`,
  work_type: 'room',
  sector: 'private',
  overhead_percent: '10',
  contingency_percent: '5',
  target_margin_percent: '15',
  ...extra,
});

const tline = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(300 + n),
  line_no: n,
  description: `T line ${n}`,
  line_kind: 'material',
  cost_code_id: uid(900),
  unit_code: 'nos',
  qty_formula: 'area * 2',
  ...extra,
});

const eline = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(400 + n),
  line_no: n,
  description: `E line ${n}`,
  line_kind: 'material',
  cost_code_id: uid(900),
  unit_code: 'nos',
  quantity: '2.5',
  rate: '10',
  ...extra,
});

describe('estimation templates (integration, PGlite)', () => {
  it('inserts, finds, updates and soft-deletes with the version check', async () => {
    const row = await insertTemplate(kit.db, template(1), ADMIN, at);
    expect(row).toMatchObject({ code: 'R-1', work_type: 'room', active: true, version: 1 });
    expect(row.parameters).toEqual([{ key: 'area', label: 'Area', unit: 'sqft' }]);
    expect(await findTemplate(kit.db, row.id)).toEqual(row);
    expect(await findTemplate(kit.db, row.id, true)).toEqual(row);
    expect(await findTemplate(kit.db, uid(999))).toBeUndefined();

    const updated = await updateTemplate(kit.db, row.id, 1, { name: 'Renamed' }, ADMIN, at);
    expect(updated).toMatchObject({ name: 'Renamed', version: 2 });
    expect(await updateTemplate(kit.db, row.id, 1, { name: 'Stale' }, ADMIN, at)).toBeUndefined();

    expect(await softDeleteTemplate(kit.db, row.id, 1, ADMIN, at)).toBe(false);
    expect(await softDeleteTemplate(kit.db, row.id, 2, ADMIN, at)).toBe(true);
    expect(await findTemplate(kit.db, row.id)).toBeUndefined();
  });

  it('keeps template codes unique among live templates, ignoring case', async () => {
    const row = await insertTemplate(kit.db, template(2, { code: 'Case-Code' }), ADMIN, at);
    expect(await templateCodeTaken(kit.db, 'case-code', null)).toBe(true);
    expect(await templateCodeTaken(kit.db, 'case-code', row.id)).toBe(false);
    expect(await templateCodeTaken(kit.db, 'other', null)).toBe(false);
    await expect(
      insertTemplate(kit.db, template(3, { code: 'CASE-CODE' }), ADMIN, at),
    ).rejects.toThrow();
  });

  it('replaces the lines as a whole, in order', async () => {
    const row = await insertTemplate(kit.db, template(4), ADMIN, at);
    await replaceTemplateLines(kit.db, row.id, [tline(2, { default_rate: '7.5' }), tline(1)]);
    expect(
      (await listTemplateLines(kit.db, row.id)).map((l) => [l.line_no, l.default_rate]),
    ).toEqual([
      [1, null],
      [2, '7.5000'],
    ]);
    await replaceTemplateLines(kit.db, row.id, [tline(3, { supplied_by: 'client' })]);
    const lines = await listTemplateLines(kit.db, row.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ line_no: 3, supplied_by: 'client', qty_formula: 'area * 2' });
  });

  it('searches by text, work type and active flag, and pages', async () => {
    await insertTemplate(kit.db, template(5, { work_type: 'slab', active: false }), ADMIN, at);
    const slabs = await searchTemplates(kit.db, { workType: 'slab', limit: 10, offset: 0 });
    expect(slabs.rows.map((r) => r.code)).toEqual(['R-5']);
    expect(slabs.total).toBe(1);
    expect((await searchTemplates(kit.db, { active: false, limit: 10, offset: 0 })).total).toBe(1);
    expect((await searchTemplates(kit.db, { q: '100%', limit: 10, offset: 0 })).total).toBe(0);
    expect(
      (await searchTemplates(kit.db, { q: 'repo template 5', limit: 10, offset: 0 })).total,
    ).toBe(1);
    const paged = await searchTemplates(kit.db, { limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBeGreaterThan(1);
  });
});

describe('estimates (integration, PGlite)', () => {
  it('inserts, finds, updates and soft-deletes with the version check', async () => {
    const row = await insertEstimate(kit.db, estimate(1, { proposed_price: '1500.5' }), ADMIN, at);
    expect(row).toMatchObject({
      number: 'RE-1',
      revision: 1,
      status: 'draft',
      overhead_percent: '10.0000',
      proposed_price: '1500.50',
      locked_at: null,
      parent_estimate_id: null,
      parameters_values: {},
      version: 1,
    });
    expect(await findEstimate(kit.db, row.id)).toEqual(row);
    expect(await findEstimate(kit.db, row.id, true)).toEqual(row);
    expect(await findEstimate(kit.db, uid(999))).toBeUndefined();
    expect(await findLockedTotals(kit.db, row.id)).toBeNull();
    expect(await findLockedTotals(kit.db, uid(999))).toBeUndefined();

    const updated = await updateEstimate(kit.db, row.id, 1, { title: 'Changed' }, ADMIN, at);
    expect(updated).toMatchObject({ title: 'Changed', version: 2 });
    expect(await updateEstimate(kit.db, row.id, 1, { title: 'Stale' }, ADMIN, at)).toBeUndefined();
    expect(await softDeleteEstimate(kit.db, row.id, 1, ADMIN, at)).toBe(false);
    expect(await softDeleteEstimate(kit.db, row.id, 2, ADMIN, at)).toBe(true);
    expect(await findEstimate(kit.db, row.id)).toBeUndefined();
  });

  it('requires the locked totals exactly when the estimate is not a draft', async () => {
    const row = await insertEstimate(kit.db, estimate(2), ADMIN, at);
    await expect(
      updateEstimate(kit.db, row.id, 1, { status: 'locked' }, ADMIN, at),
    ).rejects.toThrow();
    const locked = await updateEstimate(
      kit.db,
      row.id,
      1,
      {
        status: 'locked',
        locked_totals: JSON.stringify({ totalCost: '1.00' }),
        locked_at: at.toISOString(),
      },
      ADMIN,
      at,
    );
    expect(locked?.status).toBe('locked');
    expect(locked?.locked_at).toEqual(at);
    expect(await findLockedTotals(kit.db, row.id)).toEqual({ totalCost: '1.00' });
  });

  it('allows one open revision per parent and one row per number and revision', async () => {
    const parent = await insertEstimate(kit.db, estimate(3), ADMIN, at);
    expect(await openRevisionExists(kit.db, parent.id)).toBe(false);
    const child = await insertEstimate(
      kit.db,
      estimate(3, { id: uid(250), revision: 2, parent_estimate_id: parent.id }),
      ADMIN,
      at,
    );
    expect(await openRevisionExists(kit.db, parent.id)).toBe(true);
    await expect(
      insertEstimate(
        kit.db,
        estimate(3, { id: uid(251), revision: 3, parent_estimate_id: parent.id }),
        ADMIN,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertEstimate(kit.db, estimate(3, { id: uid(252), revision: 2 }), ADMIN, at),
    ).rejects.toThrow();
    await softDeleteEstimate(kit.db, child.id, 1, ADMIN, at);
    expect(await openRevisionExists(kit.db, parent.id)).toBe(false);
  });

  it('replaces the lines as a whole, in order, with numbers as text', async () => {
    const row = await insertEstimate(kit.db, estimate(4), ADMIN, at);
    await replaceEstimateLines(kit.db, row.id, [eline(2, { note: 'n' }), eline(1)]);
    expect(
      (await listEstimateLines(kit.db, row.id)).map((l) => [l.line_no, l.quantity, l.rate, l.note]),
    ).toEqual([
      [1, '2.5000', '10.0000', null],
      [2, '2.5000', '10.0000', 'n'],
    ]);
    await replaceEstimateLines(kit.db, row.id, []);
    expect(await listEstimateLines(kit.db, row.id)).toEqual([]);
    await expect(
      replaceEstimateLines(kit.db, row.id, [eline(1), eline(1, { id: uid(499) })]),
    ).rejects.toThrow();
  });

  it('searches by text, status, lead and client, newest first, and pages', async () => {
    const lead = uid(777);
    await insertEstimate(kit.db, estimate(5, { lead_id: lead, party_id: lead }), ADMIN, at);
    expect((await searchEstimates(kit.db, { leadId: lead, limit: 10, offset: 0 })).total).toBe(1);
    expect((await searchEstimates(kit.db, { partyId: lead, limit: 10, offset: 0 })).total).toBe(1);
    expect(
      (await searchEstimates(kit.db, { q: 'repo estimate 5', limit: 10, offset: 0 })).total,
    ).toBe(1);
    expect((await searchEstimates(kit.db, { q: 'RE-5', limit: 10, offset: 0 })).total).toBe(1);
    expect((await searchEstimates(kit.db, { status: 'locked', limit: 10, offset: 0 })).total).toBe(
      1,
    );
    expect(
      (await searchEstimates(kit.db, { status: 'superseded', limit: 10, offset: 0 })).total,
    ).toBe(0);
    const paged = await searchEstimates(kit.db, { limit: 2, offset: 1 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.total).toBeGreaterThan(2);
  });

  it('has row level security on every table', async () => {
    const rows = await kit.db.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'est\\_%'
          and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });
});

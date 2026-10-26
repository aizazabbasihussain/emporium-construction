import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, createVariationsKit, uid, type VariationsKit } from '../test-support.js';
import {
  findVariation,
  insertHistory,
  insertVariation,
  listApproved,
  listHistory,
  listLineCodes,
  listLines,
  nextSeq,
  replaceLines,
  searchVariations,
  softDeleteVariation,
  updateVariation,
} from './variations.repo.js';

let kit: VariationsKit;
const at = new Date('2026-10-25T10:00:00Z');
const PROJECT = uid(900);
const CODE_A = uid(901);
const CODE_B = uid(902);

beforeAll(async () => {
  kit = await createVariationsKit();
}, 60_000);
afterAll(() => kit.close());

const variation = (n: number, extra: Record<string, unknown> = {}) => ({
  id: uid(300 + n),
  project_id: PROJECT,
  seq: n,
  number: `REPO-V${n}`,
  title: `Repo variation ${n}`,
  discovered_on: '2026-10-20',
  ...extra,
});

describe('variations (integration, PGlite)', () => {
  it('inserts, finds, updates and soft-deletes with the version check', async () => {
    const row = await insertVariation(kit.db, variation(1), ADMIN, at);
    expect(row).toMatchObject({
      number: 'REPO-V1',
      status: 'draft',
      reason: '',
      discovered_on: '2026-10-20',
      price_impact: '0.00',
      cost_impact: '0.00',
      client_approval_ref: null,
      client_approved_on: null,
      copied_from_id: null,
      version: 1,
    });
    expect(await findVariation(kit.db, row.id)).toEqual(row);
    expect(await findVariation(kit.db, row.id, true)).toEqual(row);
    expect(await findVariation(kit.db, uid(999))).toBeUndefined();

    const updated = await updateVariation(kit.db, row.id, 1, { title: 'Changed' }, ADMIN, at);
    expect(updated).toMatchObject({ title: 'Changed', version: 2 });
    expect(await updateVariation(kit.db, row.id, 1, { title: 'Stale' }, null, at)).toBeUndefined();
    expect(await softDeleteVariation(kit.db, row.id, 1, ADMIN, at)).toBe(false);
    expect(await softDeleteVariation(kit.db, row.id, 2, ADMIN, at)).toBe(true);
    expect(await findVariation(kit.db, row.id)).toBeUndefined();
  });

  it('hands out numbers per project, starting at 1', async () => {
    expect(await nextSeq(kit.db, uid(910))).toBe(1);
    expect(await nextSeq(kit.db, uid(910))).toBe(2);
    expect(await nextSeq(kit.db, uid(911))).toBe(1);
    expect(await nextSeq(kit.db, uid(910))).toBe(3);
  });

  it('keeps one number per project and refuses a client approval without its proof', async () => {
    const project = uid(920);
    await insertVariation(
      kit.db,
      variation(1, { id: uid(350), project_id: project, number: 'P-V1' }),
      ADMIN,
      at,
    );
    await expect(
      insertVariation(
        kit.db,
        variation(2, { id: uid(351), project_id: project, seq: 1, number: 'P-V2' }),
        ADMIN,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertVariation(
        kit.db,
        variation(3, { id: uid(352), project_id: project, status: 'client_approved' }),
        ADMIN,
        at,
      ),
    ).rejects.toThrow();
  });

  it('replaces and lists lines and their cost codes', async () => {
    const row = await insertVariation(kit.db, variation(10), ADMIN, at);
    const line = (n: number, code: string, cost: string, price: string) => ({
      id: uid(400 + n),
      lineNo: n,
      description: `Line ${n}`,
      costCodeId: code,
      costAmount: cost,
      priceAmount: price,
    });
    await replaceLines(kit.db, row.id, [
      line(1, CODE_A, '10.5', '20'),
      line(2, CODE_B, '0', '-5.25'),
      line(3, CODE_A, '1', '1'),
    ]);
    expect(await listLines(kit.db, row.id)).toEqual([
      {
        line_no: 1,
        description: 'Line 1',
        cost_code_id: CODE_A,
        cost_amount: '10.50',
        price_amount: '20.00',
      },
      {
        line_no: 2,
        description: 'Line 2',
        cost_code_id: CODE_B,
        cost_amount: '0.00',
        price_amount: '-5.25',
      },
      {
        line_no: 3,
        description: 'Line 3',
        cost_code_id: CODE_A,
        cost_amount: '1.00',
        price_amount: '1.00',
      },
    ]);
    const codes = await listLineCodes(kit.db, [row.id]);
    expect(codes.map((c) => c.cost_code_id).sort()).toEqual([CODE_A, CODE_B].sort());
    await replaceLines(kit.db, row.id, [line(5, CODE_B, '2', '3')]);
    expect(await listLines(kit.db, row.id)).toHaveLength(1);
    expect(await listLineCodes(kit.db, [])).toEqual([]);
  });

  it('records history oldest first', async () => {
    const row = await insertVariation(kit.db, variation(11), ADMIN, at);
    await insertHistory(kit.db, {
      id: uid(500),
      variationId: row.id,
      from: null,
      to: 'draft',
      at,
      by: ADMIN,
      note: null,
    });
    await insertHistory(kit.db, {
      id: uid(501),
      variationId: row.id,
      from: 'draft',
      to: 'cancelled',
      at: new Date('2026-10-26T10:00:00Z'),
      by: null,
      note: 'not needed',
    });
    expect(await listHistory(kit.db, row.id)).toMatchObject([
      { from_status: null, to_status: 'draft', changed_by: ADMIN, note: null },
      { from_status: 'draft', to_status: 'cancelled', changed_by: null, note: 'not needed' },
    ]);
  });

  it('searches one project with a status filter and paging, newest number first', async () => {
    const project = uid(930);
    for (const n of [1, 2, 3]) {
      await insertVariation(
        kit.db,
        variation(20 + n, {
          project_id: project,
          seq: n,
          number: `S-V${n}`,
          ...(n === 2 ? { status: 'cancelled' } : {}),
        }),
        ADMIN,
        at,
      );
    }
    const all = await searchVariations(kit.db, { projectId: project, limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.number)).toEqual(['S-V3', 'S-V2', 'S-V1']);
    const cancelled = await searchVariations(kit.db, {
      projectId: project,
      status: 'cancelled',
      limit: 10,
      offset: 0,
    });
    expect(cancelled.rows.map((r) => r.number)).toEqual(['S-V2']);
    const page = await searchVariations(kit.db, { projectId: project, limit: 1, offset: 2 });
    expect(page).toMatchObject({ total: 3 });
    expect(page.rows.map((r) => r.number)).toEqual(['S-V1']);
  });

  it('lists the client-approved variations of a project in order', async () => {
    const project = uid(940);
    const approved = {
      status: 'client_approved',
      client_approval_ref: 'R',
      client_approved_on: '2026-10-24',
    };
    await insertVariation(
      kit.db,
      variation(31, { project_id: project, seq: 2, number: 'A-V2', ...approved }),
      ADMIN,
      at,
    );
    await insertVariation(
      kit.db,
      variation(32, { project_id: project, seq: 1, number: 'A-V1', ...approved }),
      ADMIN,
      at,
    );
    await insertVariation(
      kit.db,
      variation(33, { project_id: project, seq: 3, number: 'A-V3' }),
      ADMIN,
      at,
    );
    expect((await listApproved(kit.db, project)).map((r) => r.number)).toEqual(['A-V1', 'A-V2']);
    expect((await listApproved(kit.db, project))[0]).toMatchObject({
      client_approval_ref: 'R',
      client_approved_on: '2026-10-24',
    });
  });
});

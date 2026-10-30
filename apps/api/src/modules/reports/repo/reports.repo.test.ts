import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MANAGEMENT,
  createReportsKit,
  type ReportsKit,
  type ScenarioIds,
} from '../test-support.js';
import {
  findSavedFilter,
  findSavedFilterByName,
  insertSavedFilter,
  listClientMaterialRows,
  listSavedFilters,
  softDeleteSavedFilter,
} from './reports.repo.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: ReportsKit;
let ids: ScenarioIds;
beforeAll(async () => {
  kit = await createReportsKit();
  ids = await kit.seed();
}, 240_000);
afterAll(() => kit.close());

const at = new Date('2026-10-25T10:00:00Z');

describe('saved filter repository', () => {
  it('inserts, finds by id and by name (case aside), lists and soft deletes', async () => {
    const id = '018f7a7a-1234-7000-8000-000000000001';
    const row = await insertSavedFilter(
      kit.db,
      { id, userId: MANAGEMENT, reportCode: 'stock', name: 'Low Stock', filter: { a: 1 } },
      at,
    );
    expect(row).toEqual({
      id,
      user_id: MANAGEMENT,
      report_code: 'stock',
      name: 'Low Stock',
      filter: { a: 1 },
      version: 1,
    });
    expect(await findSavedFilter(kit.db, id)).toEqual(row);
    expect((await findSavedFilterByName(kit.db, MANAGEMENT, 'stock', 'low stock'))?.id).toBe(id);
    expect(await findSavedFilterByName(kit.db, MANAGEMENT, 'labour', 'low stock')).toBeUndefined();
    expect((await listSavedFilters(kit.db, MANAGEMENT, null)).map((r) => r.id)).toContain(id);
    expect(await listSavedFilters(kit.db, MANAGEMENT, 'labour')).toEqual([]);
    expect(await softDeleteSavedFilter(kit.db, id, 9, MANAGEMENT, at)).toBe(false);
    expect(await softDeleteSavedFilter(kit.db, id, 1, MANAGEMENT, at)).toBe(true);
    expect(await softDeleteSavedFilter(kit.db, id, 2, MANAGEMENT, at)).toBe(false);
    expect(await findSavedFilter(kit.db, id)).toBeUndefined();
    expect(await listSavedFilters(kit.db, MANAGEMENT, 'stock')).toEqual([]);
  });
});

describe('client material view', () => {
  it('adds the stores up per project, item and owner and filters by project or scope', async () => {
    const all = await listClientMaterialRows(kit.db, { projectId: null, projectIds: null });
    expect(all).toEqual([
      {
        project_id: ids.projectA,
        item_id: ids.clientItem,
        owner_party_id: ids.clientParty,
        received_qty: '20.0000',
        used_qty: '8.0000',
        returned_qty: '2.0000',
        balance_qty: '10.0000',
      },
    ]);
    expect(
      await listClientMaterialRows(kit.db, { projectId: ids.projectB, projectIds: null }),
    ).toEqual([]);
    expect(
      await listClientMaterialRows(kit.db, { projectId: null, projectIds: [ids.projectB] }),
    ).toEqual([]);
    expect(
      await listClientMaterialRows(kit.db, { projectId: null, projectIds: [ids.projectA] }),
    ).toHaveLength(1);
  });
});

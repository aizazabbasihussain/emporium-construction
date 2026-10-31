import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { runIntegrityChecks } from './integrity.js';
import { loadSyntheticCompany, pilotCompany } from './seed.js';

describe('synthetic seed (P1-21 BR-1)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ users: ['admin', 'owner', 'pm'] });
  });
  afterAll(() => h.close());

  it('loads the whole synthetic company through the API and leaves the database consistent', async () => {
    const summary = await loadSyntheticCompany(h, pilotCompany(false));
    expect(summary).toEqual({
      parties: 30,
      itemCategories: 10,
      items: 200,
      costCodes: 60,
      users: 12,
      workers: 50,
      teams: 6,
      projects: 6,
    });
    const count = async (table: string, where = 'true') =>
      Number(
        (
          await h.db.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`)
        )[0]?.n,
      );
    expect(await count('mst_items')).toBe(200);
    expect(await count('lab_workers')).toBe(50);
    expect(await count('lab_teams')).toBe(6);
    expect(await count('prj_projects')).toBe(6);
    expect(await count('prj_projects', `sector = 'government'`)).toBe(0);
    expect(await count('prj_budget_lines')).toBe(18);
    expect(await runIntegrityChecks(h.db)).toEqual([]);
  }, 120_000);
});

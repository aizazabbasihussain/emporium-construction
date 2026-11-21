import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearAlert,
  findLatestForecast,
  findThreshold,
  findThresholdOfScope,
  insertAlert,
  insertForecast,
  insertThreshold,
  listAlerts,
  listOpenAlertCodes,
  listThresholds,
  softDeleteThreshold,
  updateThreshold,
} from './profitability.repo.js';
import { createProfitabilityKit, uid, type ProfitabilityKit } from '../test-support.js';

let kit: ProfitabilityKit;
beforeAll(async () => {
  kit = await createProfitabilityKit();
}, 120_000);
afterAll(() => kit.close());

const at = new Date('2026-10-25T10:00:00Z');
const base = {
  marginFloorPercent: '10',
  overspendPercent: '100',
  receivableAgeDays: 30,
  active: true,
};

describe('thresholds', () => {
  it('inserts, finds by id and by scope, lists, updates with the version and soft-deletes', async () => {
    const company = await insertThreshold(
      kit.db,
      { id: uid(501), scope: 'company', projectId: null, ...base },
      null,
      at,
    );
    expect(company).toMatchObject({
      id: uid(501),
      scope: 'company',
      project_id: null,
      margin_floor_percent: '10.0000',
      overspend_percent: '100.0000',
      receivable_age_days: 30,
      active: true,
      version: 1,
    });
    const project = await insertThreshold(
      kit.db,
      { id: uid(502), scope: 'project', projectId: uid(900), ...base, active: false },
      uid(2),
      at,
    );
    expect((await findThreshold(kit.db, uid(501)))?.scope).toBe('company');
    expect(await findThreshold(kit.db, uid(999))).toBeUndefined();
    expect((await findThresholdOfScope(kit.db, 'company', null))?.id).toBe(uid(501));
    expect((await findThresholdOfScope(kit.db, 'project', uid(900)))?.id).toBe(project.id);
    expect(await findThresholdOfScope(kit.db, 'project', uid(901))).toBeUndefined();
    expect((await listThresholds(kit.db, false)).map((t) => t.id)).toEqual([uid(501), uid(502)]);
    expect((await listThresholds(kit.db, true)).map((t) => t.id)).toEqual([uid(501)]);

    const updated = await updateThreshold(
      kit.db,
      uid(502),
      1,
      { marginFloorPercent: '5.5', overspendPercent: '90', receivableAgeDays: 10, active: true },
      uid(2),
      at,
    );
    expect(updated).toMatchObject({ margin_floor_percent: '5.5000', active: true, version: 2 });
    // A stale version changes nothing.
    expect(await updateThreshold(kit.db, uid(502), 1, { ...base }, uid(2), at)).toBeUndefined();

    expect(await softDeleteThreshold(kit.db, uid(502), 1, uid(2), at)).toBe(false);
    expect(await softDeleteThreshold(kit.db, uid(502), 2, uid(2), at)).toBe(true);
    expect(await findThreshold(kit.db, uid(502))).toBeUndefined();
    // The scope is free again after a removal.
    await insertThreshold(
      kit.db,
      { id: uid(503), scope: 'project', projectId: uid(900), ...base },
      null,
      at,
    );
  });

  it('allows one live row per company and per project, and keeps scope and project together', async () => {
    await expect(
      insertThreshold(
        kit.db,
        { id: uid(510), scope: 'company', projectId: null, ...base },
        null,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertThreshold(
        kit.db,
        { id: uid(511), scope: 'project', projectId: uid(900), ...base },
        null,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertThreshold(
        kit.db,
        { id: uid(512), scope: 'company', projectId: uid(7), ...base },
        null,
        at,
      ),
    ).rejects.toThrow();
    await expect(
      insertThreshold(
        kit.db,
        { id: uid(513), scope: 'project', projectId: uid(8), ...base, marginFloorPercent: '101' },
        null,
        at,
      ),
    ).rejects.toThrow();
  });
});

describe('forecasts', () => {
  it('returns the latest forecast made on or before a date', async () => {
    const forecast = (n: number, date: string, amount: string) =>
      insertForecast(
        kit.db,
        {
          id: uid(600 + n),
          projectId: uid(950),
          costToComplete: amount,
          note: `note ${n}`,
          forecastDate: date,
          setBy: uid(3),
        },
        at,
      );
    const first = await forecast(1, '2026-10-10', '500');
    expect(first).toMatchObject({
      id: uid(601),
      project_id: uid(950),
      cost_to_complete: '500.00',
      forecast_date: '2026-10-10',
      set_by: uid(3),
    });
    await forecast(2, '2026-10-20', '300');
    await forecast(3, '2026-10-20', '250'); // the same day: the later insert wins
    const latest = (asOf: string) => findLatestForecast(kit.db, uid(950), asOf);
    expect(await latest('2026-10-09')).toBeUndefined();
    expect((await latest('2026-10-15'))?.id).toBe(uid(601));
    expect((await latest('2026-10-20'))?.id).toBe(uid(603));
    expect((await latest('2026-12-31'))?.cost_to_complete).toBe('250.00');
    expect(await findLatestForecast(kit.db, uid(951), '2026-12-31')).toBeUndefined();
    await expect(
      insertForecast(
        kit.db,
        {
          id: uid(699),
          projectId: uid(950),
          costToComplete: '-1',
          note: '',
          forecastDate: '2026-10-10',
          setBy: uid(3),
        },
        at,
      ),
    ).rejects.toThrow();
  });
});

describe('alert state', () => {
  it('opens an alert once, clears it, lists open first and keeps the history', async () => {
    const project = uid(960);
    await insertAlert(kit.db, { id: uid(701), projectId: project, alertCode: 'overspend' }, at);
    await insertAlert(
      kit.db,
      { id: uid(702), projectId: project, alertCode: 'margin_below_floor' },
      new Date('2026-10-26T10:00:00Z'),
    );
    expect(await listOpenAlertCodes(kit.db, project)).toEqual(['margin_below_floor', 'overspend']);
    // The same alert cannot be open twice.
    await expect(
      insertAlert(kit.db, { id: uid(703), projectId: project, alertCode: 'overspend' }, at),
    ).rejects.toThrow();
    await expect(
      insertAlert(kit.db, { id: uid(704), projectId: project, alertCode: 'nonsense' }, at),
    ).rejects.toThrow();
    await clearAlert(kit.db, project, 'overspend', new Date('2026-10-27T10:00:00Z'));
    expect(await listOpenAlertCodes(kit.db, project)).toEqual(['margin_below_floor']);
    // Clearing an alert that is not open changes nothing.
    await clearAlert(kit.db, project, 'receivable_overdue', at);
    // Once cleared it can be raised again as a new row.
    await insertAlert(kit.db, { id: uid(705), projectId: project, alertCode: 'overspend' }, at);
    expect(await listOpenAlertCodes(kit.db, uid(961))).toEqual([]);

    const all = await listAlerts(kit.db, { onlyOpen: false, limit: 10 });
    // Open alerts first (the latest raised first), then the cleared one.
    expect(all.map((a) => a.id)).toEqual([uid(702), uid(705), uid(701)]);
    expect(all.find((a) => a.id === uid(701))).toMatchObject({
      raised_at: '2026-10-25T10:00:00Z',
      cleared_at: '2026-10-27T10:00:00Z',
    });
    const open = await listAlerts(kit.db, { onlyOpen: true, limit: 10 });
    expect(open.map((a) => a.id)).toEqual([uid(702), uid(705)]);
    expect((await listAlerts(kit.db, { onlyOpen: false, limit: 1 })).length).toBe(1);
  });
});

describe('row level security (constitution 7.7)', () => {
  it('every pft_ table has RLS enabled', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'pft\\_%' order by 1`,
    );
    expect(tables.map((t) => t.relname)).toEqual([
      'pft_alert_state',
      'pft_forecasts',
      'pft_thresholds',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});

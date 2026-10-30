import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  PROCUREMENT,
  STOREKEEPER,
  SUPERVISOR,
  createReportsKit,
  type ReportsKit,
  type ScenarioIds,
} from '../test-support.js';
import type { Actor, ReportCode, ReportFilters } from '../types.js';

vi.setConfig({ testTimeout: 120_000 });

let kit: ReportsKit;
let ids: ScenarioIds;
beforeAll(async () => {
  kit = await createReportsKit();
  ids = await kit.seed();
}, 240_000);
afterAll(() => kit.close());

const run = (
  code: ReportCode,
  filters: ReportFilters = {},
  actor: Actor = kit.actorFor(MANAGEMENT),
  extra: { sort?: string; direction?: 'asc' | 'desc'; limit?: number; offset?: number } = {},
) => kit.reports.service.run(kit.db, code, { filters, ...extra }, actor);

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

/** A caller who is limited to project A: every report permission, one project in scope. */
const scoped = (projectId: string): Actor => ({
  userId: SUPERVISOR,
  roles: ['supervisor'],
  scopes: [{ type: 'project', id: projectId }],
  permissions: new Set([
    'reports.project_cost.read',
    'reports.stock.read',
    'reports.purchasing.read',
    'reports.labour.read',
    'reports.dpr.read',
    'reports.pipeline.read',
  ]),
  requestId: null,
});

// The scenario, calculated by hand (see test-support seed):
//  Project A: budget 100 = 100,000 and 200 = 50,000. Cement order of 200 bags at 100 and steel
//  10 at 50 is committed (20,500); 50 bags received (5,000) moves from committed to approved;
//  28,000 posted directly plus 40 bags issued from stock at 50 (2,000) is 30,000 posted on 100;
//  labour approved on 200 is 1,000 (W1) + 250 + 375 overtime (W2's share) = 1,625; 700 posted on 500.
//  Project B: budget 100 = 10,000; 12,000 posted; labour approved on 200 is 250.
describe('project cost status (BR-1, T-1, T-2; AC-1)', () => {
  const line = (
    project: string,
    code: string,
    name: string,
    f: [string, string, string, string, string, string, string | null],
  ) => ({
    projectCode: project,
    costCode: code,
    costCodeName: name,
    budget: f[0],
    committed: f[1],
    approved: f[2],
    posted: f[3],
    used: f[4],
    variance: f[5],
    percentUsed: f[6],
  });

  it('matches the hand-calculated figures, most overspent first', async () => {
    const page = await run('project-cost');
    expect(page.total).toBe(5);
    expect(
      page.items.map((row) => ({
        projectCode: row.projectCode,
        costCode: row.costCode,
        costCodeName: row.costCodeName,
        budget: row.budget,
        committed: row.committed,
        approved: row.approved,
        posted: row.posted,
        used: row.used,
        variance: row.variance,
        percentUsed: row.percentUsed,
      })),
    ).toEqual([
      line(ids.projectB_code, '100', 'Materials', [
        '10000.00',
        '0.00',
        '0.00',
        '12000.00',
        '12000.00',
        '-2000.00',
        '120.00',
      ]),
      // No budget on this code, so there is no percent, only the overspend.
      line(ids.projectA_code, '500', 'Site expenses', [
        '0.00',
        '0.00',
        '0.00',
        '700.00',
        '700.00',
        '-700.00',
        null,
      ]),
      line(ids.projectB_code, '200', 'Labour', [
        '0.00',
        '0.00',
        '250.00',
        '0.00',
        '250.00',
        '-250.00',
        null,
      ]),
      line(ids.projectA_code, '200', 'Labour', [
        '50000.00',
        '0.00',
        '1625.00',
        '0.00',
        '1625.00',
        '48375.00',
        '3.25',
      ]),
      line(ids.projectA_code, '100', 'Materials', [
        '100000.00',
        '15500.00',
        '5000.00',
        '30000.00',
        '50500.00',
        '49500.00',
        '50.50',
      ]),
    ]);
    expect(page.totals).toEqual({
      budget: '160000.00',
      committed: '15500.00',
      approved: '6875.00',
      posted: '42700.00',
      used: '65075.00',
      variance: '94925.00',
      percentUsed: '40.67',
    });
  });

  it('adds totals per project, most overspent project first', async () => {
    const page = await run('project-cost');
    const projects = page.extras.find((section) => section.key === 'projects');
    expect(projects?.rows).toEqual([
      {
        projectCode: ids.projectB_code,
        projectName: 'Beta site office',
        budget: '10000.00',
        committed: '0.00',
        approved: '250.00',
        posted: '12000.00',
        used: '12250.00',
        variance: '-2250.00',
        percentUsed: '122.50',
      },
      {
        projectCode: ids.projectA_code,
        projectName: 'Alpha boundary wall',
        budget: '150000.00',
        committed: '15500.00',
        approved: '6625.00',
        posted: '30700.00',
        used: '52825.00',
        variance: '97175.00',
        percentUsed: '35.22',
      },
    ]);
  });

  it('filters by project and leaves out a project with no cost or budget', async () => {
    const a = await run('project-cost', { projectId: ids.projectA });
    expect(a.items.map((row) => row.costCode)).toEqual(['500', '200', '100']);
    expect(a.totals).toMatchObject({ budget: '150000.00', used: '52825.00', percentUsed: '35.22' });
    expect(a.filters).toEqual({ projectId: ids.projectA });
    const idle = await run('project-cost', { projectId: ids.projectC });
    expect(idle.items).toEqual([]);
    expect(idle.totals).toBeNull();
    expect(idle.extras[0]?.rows).toEqual([]);
  });

  it('sorts on the server by any column of the list', async () => {
    const byUsed = await run('project-cost', {}, kit.actorFor(MANAGEMENT), {
      sort: 'used',
      direction: 'desc',
    });
    expect(byUsed.items.map((row) => row.used)).toEqual([
      '50500.00',
      '12000.00',
      '1625.00',
      '700.00',
      '250.00',
    ]);
    const byName = await run('project-cost', {}, kit.actorFor(MANAGEMENT), { sort: 'costCode' });
    expect(byName.items.map((row) => row.costCode)).toEqual(['100', '100', '200', '200', '500']);
    // Empty percents stay last whichever way the list is sorted.
    for (const direction of ['asc', 'desc'] as const) {
      const byPercent = await run('project-cost', {}, kit.actorFor(MANAGEMENT), {
        sort: 'percentUsed',
        direction,
      });
      expect(byPercent.items.slice(-2).map((row) => row.percentUsed)).toEqual([null, null]);
    }
    expect(await codeOf(run('project-cost', {}, kit.actorFor(MANAGEMENT), { sort: 'nope' }))).toBe(
      'invalid_sort',
    );
  });

  it('pages the list while the totals still cover the whole filtered set (T-4)', async () => {
    const actor = kit.actorFor(MANAGEMENT);
    const first = await run('project-cost', {}, actor, { limit: 2, offset: 0 });
    const last = await run('project-cost', {}, actor, { limit: 2, offset: 4 });
    expect(first.items).toHaveLength(2);
    expect(last.items).toHaveLength(1);
    expect(first.total).toBe(5);
    expect(last.total).toBe(5);
    expect(first.limit).toBe(2);
    expect(last.offset).toBe(4);
    expect(first.totals).toEqual(last.totals);
    expect(first.totals).toMatchObject({ used: '65075.00' });
    expect(first.extras[0]?.rows).toHaveLength(2);
    // The default page is 50 rows and the largest is 200.
    expect((await run('project-cost')).limit).toBe(50);
    expect(await codeOf(run('project-cost', {}, actor, { limit: 201 }))).toBe('page_invalid');
    expect(await codeOf(run('project-cost', {}, actor, { offset: -1 }))).toBe('page_invalid');
  });
});

describe('stock (BR-2, T-1; AC-1)', () => {
  // Cement: 100 received at 50, 40 issued, 60 left worth 3,000. Steel: 10 at 200 = 2,000.
  // The client's tiles: 20 received, 8 used, 2 returned, 10 left, valued at nothing.
  it('lists quantity and value per store and item and totals the company value', async () => {
    const page = await run('stock');
    expect(page.items.map((r) => [r.itemCode, r.ownership, r.owner, r.quantity, r.value])).toEqual([
      ['RPT-CEMENT', 'company', null, '60.0000', '3000.00'],
      ['RPT-STEEL', 'company', null, '10.0000', '2000.00'],
      ['RPT-CLIENT-TILE', 'client', 'Synthetic Client', '10.0000', null],
    ]);
    expect(page.items[0]).toMatchObject({
      storeCode: ids.storeCode,
      storeName: 'Reports warehouse',
    });
    expect(page.totals).toEqual({ value: '5000.00' });
  });

  it('lists the items below their reorder level with the shortfall', async () => {
    const page = await run('stock');
    const below = page.extras.find((section) => section.key === 'below_reorder');
    expect(below?.rows).toEqual([
      {
        storeCode: ids.storeCode,
        storeName: 'Reports warehouse',
        itemCode: 'RPT-CEMENT',
        itemName: 'Synthetic RPT-CEMENT',
        level: '100.0000',
        quantity: '60.0000',
        shortfall: '40.0000',
      },
    ]);
  });

  it('filters by ownership, store, item and below-reorder only', async () => {
    const client = await run('stock', { ownership: 'client' });
    expect(client.items.map((r) => r.itemCode)).toEqual(['RPT-CLIENT-TILE']);
    expect(client.totals).toEqual({ value: '0.00' });
    expect(client.extras[0]?.rows).toEqual([]);
    const company = await run('stock', { ownership: 'company', itemId: ids.item2 });
    expect(company.items.map((r) => r.itemCode)).toEqual(['RPT-STEEL']);
    const onlyBelow = await run('stock', { belowReorderOnly: true });
    expect(onlyBelow.items.map((r) => r.itemCode)).toEqual(['RPT-CEMENT']);
    expect(onlyBelow.totals).toEqual({ value: '3000.00' });
    expect((await run('stock', { storeId: ids.store })).total).toBe(3);
    expect((await run('stock', { storeId: ids.projectA })).total).toBe(0);
    expect((await run('stock', { belowReorderOnly: true, ownership: 'client' })).total).toBe(0);
  });
});

describe('pending purchasing (BR-3, T-1; AC-1)', () => {
  it('shows ordered, received and outstanding quantity and flags overdue lines', async () => {
    const page = await run('purchasing');
    expect(
      page.items.map((r) => [
        r.poNumber,
        r.itemCode,
        r.orderedQty,
        r.receivedQty,
        r.openQty,
        r.expectedDate,
        r.overdue,
        r.project,
      ]),
    ).toEqual([
      [
        'PO-2026-0001',
        'RPT-CEMENT',
        '200.0000',
        '50.0000',
        '150.0000',
        '2026-10-20',
        1,
        ids.projectA_code,
      ],
      [
        'PO-2026-0001',
        'RPT-STEEL',
        '10.0000',
        '0.0000',
        '10.0000',
        '2026-10-20',
        1,
        ids.projectA_code,
      ],
      ['PO-2026-0002', 'RPT-STEEL', '10.0000', '0.0000', '10.0000', '2026-11-05', 0, ''],
    ]);
    expect(page.items[2]).toMatchObject({ storeId: ids.store, vendor: 'Synthetic Vendor' });
    expect(page.totals).toEqual({ overdue: 2 });
  });

  it('lists the open requisitions and leaves out a draft', async () => {
    const page = await run('purchasing');
    const requisitions = page.extras.find((section) => section.key === 'requisitions');
    expect(requisitions?.rows).toEqual([
      {
        number: 'REQ-2026-0001',
        project: ids.projectA_code,
        storeId: null,
        requiredBy: null,
        status: 'pending_approval',
        lineCount: 1,
      },
    ]);
  });

  it('filters by overdue, project, store and vendor', async () => {
    expect((await run('purchasing', { overdueOnly: true })).total).toBe(2);
    expect((await run('purchasing', { projectId: ids.projectA })).total).toBe(2);
    const forB = await run('purchasing', { projectId: ids.projectB });
    expect(forB.total).toBe(0);
    expect(forB.extras[0]?.rows).toEqual([]);
    expect((await run('purchasing', { storeId: ids.store })).items.map((r) => r.poNumber)).toEqual([
      'PO-2026-0002',
    ]);
    expect((await run('purchasing', { vendorId: ids.vendor })).total).toBe(3);
    expect((await run('purchasing', { vendorId: ids.clientParty })).total).toBe(0);
  });
});

describe('labour (BR-4, T-1; AC-1)', () => {
  // Friday 23 October: W1 one full day on A (1,000); W2 half a day (500) shared 250 / 250 between
  // A and B with 2 hours overtime (2 x 125 x 1.5 = 375) added to A. A: 1.25 worker-days, 1,625.
  it('totals worker-days and cost per project and month, with the headcount per day', async () => {
    const page = await run('labour', { from: '2026-10-01', to: '2026-10-31' });
    expect(page.items.map((r) => [r.projectCode, r.month, r.workerDays, r.cost])).toEqual([
      [ids.projectA_code, '2026-10', '1.2500', '1625.00'],
      [ids.projectB_code, '2026-10', '0.2500', '250.00'],
    ]);
    expect(page.totals).toEqual({ workerDays: '1.5000', cost: '1875.00' });
    const headcount = page.extras.find((section) => section.key === 'headcount');
    expect(headcount?.rows.map((r) => [r.projectCode, r.date, r.headcount])).toEqual([
      [ids.projectA_code, '2026-10-23', 2],
      [ids.projectB_code, '2026-10-23', 1],
    ]);
    expect(page.filters).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('defaults to the month so far and filters by project', async () => {
    const month = await run('labour');
    expect(month.filters).toEqual({ from: '2026-10-01', to: '2026-10-25' });
    expect(month.total).toBe(2);
    const b = await run('labour', { projectId: ids.projectB });
    expect(b.items.map((r) => r.cost)).toEqual(['250.00']);
    const empty = await run('labour', { from: '2026-09-01', to: '2026-09-30' });
    expect(empty.items).toEqual([]);
    expect(empty.totals).toEqual({ workerDays: '0.0000', cost: '0.00' });
    expect(await codeOf(run('labour', { from: '2026-10-31', to: '2026-10-01' }))).toBe(
      'period_invalid',
    );
  });
});

describe('daily report compliance (BR-5, T-1; AC-1)', () => {
  const week = { from: '2026-10-19', to: '2026-10-23' };

  it('counts submitted against missing days per active project', async () => {
    const page = await run('dpr-compliance', week);
    const byProject: Record<string, unknown> = {};
    for (const r of page.items) byProject[String(r.projectCode)] = r;
    expect(byProject[ids.projectA_code]).toMatchObject({
      expectedDays: 5,
      submittedDays: 4,
      missingDays: 1,
      percentSubmitted: '80.00',
      missingDates: '2026-10-22',
    });
    expect(byProject[ids.projectB_code]).toMatchObject({
      expectedDays: 5,
      submittedDays: 2,
      missingDays: 3,
      percentSubmitted: '40.00',
      missingDates: '2026-10-21, 2026-10-22, 2026-10-23',
    });
    // C starts on Thursday 22 October, so only the 22nd and 23rd were expected of it.
    expect(byProject[ids.projectC_code]).toMatchObject({
      expectedDays: 2,
      submittedDays: 0,
      percentSubmitted: '0.00',
      missingDates: '2026-10-22, 2026-10-23',
    });
    // The paused project D is not expected to report.
    expect(page.items.map((r) => r.projectCode)).not.toContain('PRJ-0004');
    expect(page.items).toHaveLength(3);
    expect(page.totals).toEqual({
      expectedDays: 12,
      submittedDays: 6,
      missingDays: 6,
      percentSubmitted: '50.00',
    });
  });

  it('skips site holidays and weekends and filters by project', async () => {
    const current = await kit.platform.settings.get(kit.db, 'site_holidays');
    await kit.db.transaction((tx) =>
      kit.platform.settings.set(
        { key: 'site_holidays', value: '2026-10-22', expectedVersion: current.version },
        { actorUserId: null, requestId: null },
        tx,
      ),
    );
    try {
      const page = await run('dpr-compliance', { ...week, projectId: ids.projectA });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        expectedDays: 4,
        submittedDays: 4,
        percentSubmitted: '100.00',
        missingDates: '',
      });
      // A weekend alone has no expected day, so there is no percent.
      const weekend = await run('dpr-compliance', {
        from: '2026-10-24',
        to: '2026-10-25',
        projectId: ids.projectA,
      });
      expect(weekend.items[0]).toMatchObject({ expectedDays: 0, percentSubmitted: null });
      expect(weekend.totals).toMatchObject({ expectedDays: 0, percentSubmitted: null });
    } finally {
      const now = await kit.platform.settings.get(kit.db, 'site_holidays');
      await kit.db.transaction((tx) =>
        kit.platform.settings.set(
          { key: 'site_holidays', value: '', expectedVersion: now.version },
          { actorUserId: null, requestId: null },
          tx,
        ),
      );
    }
  });

  it('reads every page of reports when a project has more than 200 in the period', async () => {
    const { createReportsService } = await import('./reports.service.js');
    const seen: number[] = [];
    const reportOf = (status: string, reportDate: string) => ({ status, reportDate });
    const paged = createReportsService({
      platform: kit.platform,
      clock: { now: () => kit.now.current },
      newId: () => 'x',
      projects: kit.projects,
      procurement: kit.procurement,
      inventory: kit.inventory,
      attendance: kit.attendance,
      crm: kit.crm,
      dpr: {
        listDprs: async (_db, query) => {
          seen.push(query.offset);
          const items =
            query.offset === 0
              ? Array.from({ length: 200 }, () => reportOf('draft', '2026-10-19'))
              : [reportOf('submitted', '2026-10-19'), reportOf('reviewed', '2026-10-20')];
          return { items, total: 202, limit: 200, offset: query.offset } as never;
        },
      },
      masterData: kit.masterData,
    });
    const page = await paged.run(
      kit.db,
      'dpr-compliance',
      { filters: { ...week, projectId: ids.projectA } },
      kit.actorFor(MANAGEMENT),
    );
    expect(seen).toEqual([0, 200]);
    expect(page.items[0]).toMatchObject({
      expectedDays: 5,
      submittedDays: 2,
      missingDates: '2026-10-21, 2026-10-22, 2026-10-23',
    });
  });

  it('refuses a backwards or oversized period', async () => {
    expect(await codeOf(run('dpr-compliance', { from: '2026-10-23', to: '2026-10-19' }))).toBe(
      'period_invalid',
    );
    expect(await codeOf(run('dpr-compliance', { from: '2026-01-01', to: '2026-10-19' }))).toBe(
      'period_too_long',
    );
  });
});

describe('lead pipeline (BR-6, T-1; AC-1)', () => {
  it('counts leads and expected value per stage', async () => {
    const page = await run('pipeline');
    expect(page.items.map((r) => [r.stageCode, r.count, r.expectedValue])).toEqual([
      ['new', 1, '1000000.00'],
      ['visited', 1, '500000.00'],
      ['quoted', 0, '0.00'],
      ['negotiation', 0, '0.00'],
      ['won', 1, '250000.00'],
      ['lost', 1, '300000.00'],
    ]);
    expect(page.totals).toEqual({ count: 4, expectedValue: '2050000.00' });
  });

  it('rates conversion as won over won plus lost per month and lists overdue follow-ups', async () => {
    const page = await run('pipeline', { from: '2026-09-01', to: '2026-10-31' });
    const conversion = page.extras.find((section) => section.key === 'conversion');
    expect(conversion?.rows).toEqual([
      { month: '2026-09', won: 0, lost: 0, rate: null },
      { month: '2026-10', won: 1, lost: 1, rate: '50.00' },
    ]);
    expect(conversion?.totals).toEqual({ won: 1, lost: 1, rate: '50.00' });
    const overdue = page.extras.find((section) => section.key === 'overdue_follow_ups');
    // Due 20 October, five days before today; the one due today is not overdue.
    expect(overdue?.rows.map((r) => [r.leadNumber, r.dueDate, r.daysOverdue])).toEqual([
      ['LEAD-0001', '2026-10-20', 5],
    ]);
    expect(page.filters).toEqual({ from: '2026-09-01', to: '2026-10-31' });
  });

  it('defaults the conversion period to this year', async () => {
    const page = await run('pipeline');
    expect(page.filters).toEqual({ from: '2026-01-01', to: '2026-10-25' });
    expect(page.extras[0]?.rows).toHaveLength(10);
    expect(await codeOf(run('pipeline', { from: '2026-10-31', to: '2026-10-01' }))).toBe(
      'period_invalid',
    );
  });
});

describe('client material (BR-7, T-1; AC-1)', () => {
  it('reconciles received, used, returned and balance per project and item', async () => {
    const page = await run('client-material');
    expect(
      page.items.map((r) => [
        r.projectCode,
        r.itemCode,
        r.owner,
        r.received,
        r.used,
        r.returned,
        r.balance,
      ]),
    ).toEqual([
      [
        ids.projectA_code,
        'RPT-CLIENT-TILE',
        'Synthetic Client',
        '20.0000',
        '8.0000',
        '2.0000',
        '10.0000',
      ],
    ]);
    expect(page.totals).toBeNull();
  });

  it('filters by project', async () => {
    expect((await run('client-material', { projectId: ids.projectA })).total).toBe(1);
    expect((await run('client-material', { projectId: ids.projectB })).total).toBe(0);
  });
});

describe('who may see what (BR-8, T-3; AC-3)', () => {
  const all: ReportCode[] = [
    'project-cost',
    'stock',
    'purchasing',
    'labour',
    'dpr-compliance',
    'pipeline',
    'client-material',
  ];

  it('refuses a supervisor and a caller without roles every report', async () => {
    for (const userId of [SUPERVISOR, NOBODY]) {
      for (const code of all) {
        expect(await codeOf(run(code, {}, kit.actorFor(userId))), `${userId} ${code}`).toBe(
          'forbidden',
        );
      }
    }
  });

  it('lets each role open only the reports of the spec', async () => {
    const opens = async (userId: string) => {
      const result: ReportCode[] = [];
      for (const code of all) {
        if ((await codeOf(run(code, {}, kit.actorFor(userId)))) === 'no error') result.push(code);
      }
      return result;
    };
    expect(await opens(MANAGEMENT)).toEqual(all);
    expect(await opens(ACCOUNTANT)).toEqual(['project-cost', 'stock', 'labour', 'client-material']);
    expect(await opens(PM)).toEqual(['project-cost', 'dpr-compliance', 'pipeline']);
    expect(await opens(PROCUREMENT)).toEqual(['stock', 'purchasing', 'client-material']);
    expect(await opens(STOREKEEPER)).toEqual(['stock', 'client-material']);
  });

  it('shows a caller limited to project A only that project, and no store or order of others', async () => {
    const actor = scoped(ids.projectA);
    const cost = await run('project-cost', {}, actor);
    expect([...new Set(cost.items.map((r) => r.projectCode))]).toEqual([ids.projectA_code]);
    expect(cost.totals).toMatchObject({ budget: '150000.00', used: '52825.00' });
    expect(cost.extras[0]?.rows).toHaveLength(1);
    // The warehouse belongs to no project, so a scoped caller sees none of its stock.
    expect((await run('stock', {}, actor)).total).toBe(0);
    const purchasing = await run('purchasing', {}, actor);
    expect(purchasing.items.map((r) => r.poNumber)).toEqual(['PO-2026-0001', 'PO-2026-0001']);
    expect(purchasing.extras[0]?.rows).toHaveLength(1);
    const labour = await run('labour', { from: '2026-10-01', to: '2026-10-31' }, actor);
    expect(labour.items.map((r) => r.projectCode)).toEqual([ids.projectA_code]);
    expect(labour.extras[0]?.rows).toHaveLength(1);
    const dpr = await run('dpr-compliance', { from: '2026-10-19', to: '2026-10-23' }, actor);
    expect(dpr.items.map((r) => r.projectCode)).toEqual([ids.projectA_code]);
    expect((await run('client-material', {}, actor)).total).toBe(1);
    // Asking for a project outside the scope is the same as asking for one that is not there.
    for (const code of ['project-cost', 'purchasing', 'labour', 'client-material'] as const) {
      expect(await codeOf(run(code, { projectId: ids.projectB }, actor))).toBe('project_not_found');
    }
  });

  it('does not limit a caller who holds an unscoped role', async () => {
    const actor: Actor = {
      ...scoped(ids.projectA),
      roles: ['supervisor', 'project_manager'],
    };
    expect((await run('project-cost', {}, actor)).total).toBe(5);
  });
});

describe('exports (BR-10, T-5; AC-2)', () => {
  const download = (
    code: ReportCode,
    format: 'csv' | 'xlsx',
    filters: ReportFilters = {},
    actor: Actor = kit.actorFor(MANAGEMENT),
  ) => kit.reports.service.download(kit.db, code, { filters }, format, actor);

  it('writes a CSV with the header block, every row, the totals and the other tables', async () => {
    const file = await download('project-cost', 'csv');
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    expect(file.fileName).toBe('project-cost-2026-10-25.csv');
    const lines = String(file.body).replace('﻿', '').split('\r\n');
    expect(lines.slice(0, 4)).toEqual([
      'Report,Project cost status',
      'Filters,None',
      'Generated at (Asia/Karachi),25/10/2026 15:00',
      'Generated by,management@example.test',
    ]);
    expect(lines[5]).toBe('Cost codes');
    expect(lines[6]).toBe(
      'Project,Project name,Cost code,Cost code name,Budget,Committed,Approved,Posted,Used,Variance,% used',
    );
    // Five rows ordered by overspend, then the total.
    expect(lines[7]).toBe(
      `${ids.projectB_code},Beta site office,100,Materials,10000.00,0.00,0.00,12000.00,12000.00,-2000.00,120.00`,
    );
    expect(lines[8]).toContain(`${ids.projectA_code},Alpha boundary wall,500,Site expenses,0.00`);
    expect(lines[8]?.endsWith(',-700.00,')).toBe(true);
    expect(lines[12]).toBe('Total,,,,160000.00,15500.00,6875.00,42700.00,65075.00,94925.00,40.67');
    expect(lines.indexOf('Project totals')).toBeGreaterThan(12);
  });

  it('shows the filters in the header block and quotes cells that need it', async () => {
    const file = await download('labour', 'csv', { from: '2026-10-01', to: '2026-10-31' });
    const text = String(file.body);
    expect(text).toContain('Filters,From: 2026-10-01; To: 2026-10-31');
    const withNote = await download('pipeline', 'csv');
    expect(String(withNote.body)).toContain('Overdue follow-ups');
  });

  it('writes an Excel workbook whose numbers are numbers (AC-2)', async () => {
    const file = await download('project-cost', 'xlsx');
    expect(file.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(file.fileName).toBe('project-cost-2026-10-25.xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    expect(sheet.name).toBe('Project cost status');
    expect(sheet.getRow(1).values).toEqual([undefined, 'Report', 'Project cost status']);
    expect(sheet.getRow(3).getCell(2).value).toBe('25/10/2026 15:00');
    expect(sheet.getRow(4).getCell(2).value).toBe('management@example.test');
    const head = sheet.getRow(7);
    expect(head.getCell(1).value).toBe('Project');
    const first = sheet.getRow(8);
    expect(first.getCell(1).value).toBe(ids.projectB_code);
    expect(first.getCell(5).value).toBe(10000);
    expect(first.getCell(6).value).toBe(0);
    expect(first.getCell(10).value).toBe(-2000);
    expect(first.getCell(10).numFmt).toBe('#,##0.00');
    expect(first.getCell(11).value).toBe(120);
    // A missing percent stays empty rather than becoming zero.
    expect(sheet.getRow(9).getCell(11).value).toBeNull();
    const total = sheet.getRow(13);
    expect(total.getCell(1).value).toBe('Total');
    expect(total.getCell(5).value).toBe(160000);
    expect(total.getCell(9).value).toBe(65075);
  });

  it('exports quantities, dates and integers in their own formats', async () => {
    const file = await download('purchasing', 'xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.body as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0] as ExcelJS.Worksheet;
    const row = sheet.getRow(8);
    expect(row.getCell(1).value).toBe('PO-2026-0001');
    expect(row.getCell(5).value).toBe(200);
    expect(row.getCell(5).numFmt).toBe('#,##0.0000');
    expect(row.getCell(8).value).toBe('2026-10-20');
    expect(row.getCell(9).value).toBe(1);
  });

  it('names the user by id in the header block when the caller has no name', async () => {
    const { name: _name, ...nameless } = kit.actorFor(MANAGEMENT);
    void _name;
    const file = await kit.reports.service.download(
      kit.db,
      'pipeline',
      { filters: {} },
      'csv',
      nameless,
    );
    expect(String(file.body)).toContain(`Generated by,${MANAGEMENT}`);
  });

  it('refuses a download for a report the caller may not open', async () => {
    expect(await codeOf(download('labour', 'csv', {}, kit.actorFor(PM)))).toBe('forbidden');
  });

  it('refuses an export above 50,000 rows and asks to narrow the filters', async () => {
    const lines = Array.from({ length: 50_001 }, (_, i) => ({
      poId: 'po',
      poNumber: `PO-${i}`,
      vendorId: ids.vendor,
      lineId: `line-${i}`,
      lineNo: 1,
      itemId: ids.item1,
      orderedQty: '1.0000',
      receivedQty: '0.0000',
      openQty: '1.0000',
      rate: '1.0000',
      expectedDate: null,
      destinationType: 'project' as const,
      projectId: ids.projectA,
      storeId: null,
    }));
    const { createReportsService } = await import('./reports.service.js');
    const big = createReportsService({
      platform: kit.platform,
      clock: { now: () => kit.now.current },
      newId: () => 'x',
      projects: kit.projects,
      procurement: {
        listOpenPoLines: async () => lines,
        listOpenRequisitions: async () => [],
      },
      inventory: kit.inventory,
      attendance: kit.attendance,
      crm: kit.crm,
      dpr: kit.dpr,
      masterData: kit.masterData,
    });
    const query = { filters: {} };
    const actor = kit.actorFor(MANAGEMENT);
    expect(await codeOf(big.download(kit.db, 'purchasing', query, 'csv', actor))).toBe(
      'export_too_large',
    );
    // The same list is fine on screen: it is paged.
    const page = await big.run(kit.db, 'purchasing', query, actor);
    expect(page.total).toBe(50_001);
    expect(page.items).toHaveLength(50);
    // A list of exactly the limit is still exported.
    const exact = createReportsService({
      platform: kit.platform,
      clock: { now: () => kit.now.current },
      newId: () => 'x',
      projects: kit.projects,
      procurement: {
        listOpenPoLines: async () => lines.slice(0, 50_000),
        listOpenRequisitions: async () => [],
      },
      inventory: kit.inventory,
      attendance: kit.attendance,
      crm: kit.crm,
      dpr: kit.dpr,
      masterData: kit.masterData,
    });
    const file = await exact.download(kit.db, 'purchasing', query, 'csv', actor);
    expect(String(file.body).split('\r\n').length).toBeGreaterThan(50_000);
  });
});

describe('saved filters', () => {
  const save = (
    name: string,
    actor: Actor = kit.actorFor(MANAGEMENT),
    code: ReportCode = 'stock',
  ) =>
    kit.db.transaction((tx) =>
      kit.reports.service.saveFilter(
        { reportCode: code, name, filter: { ownership: 'company', belowReorderOnly: true } },
        actor,
        tx,
      ),
    );
  const count = async (sql: string, params: unknown[]) =>
    Number((await kit.db.query<{ n: string }>(sql, params))[0]?.n ?? 0);

  it('saves a filter for the user, audits it and announces it', async () => {
    const saved = await save('Low stock');
    expect(saved).toMatchObject({
      reportCode: 'stock',
      name: 'Low stock',
      filter: { ownership: 'company', belowReorderOnly: true },
      version: 1,
    });
    expect(
      await count(
        `select count(*) as n from sys_audit_log where action = 'reports.filter.save' and entity_id = $1`,
        [saved.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*) as n from sys_outbox where type = 'reports.filter.changed' and payload->>'filterId' = $1`,
        [saved.id],
      ),
    ).toBe(1);
  });

  it('lists only the filters of the caller, of one report or of all', async () => {
    await save('Mine on purchasing', kit.actorFor(MANAGEMENT), 'purchasing');
    await save('Accountant view', kit.actorFor(ACCOUNTANT));
    const mine = await kit.reports.service.listFilters(kit.db, kit.actorFor(MANAGEMENT));
    expect(mine.map((f) => f.name)).toEqual(['Mine on purchasing', 'Low stock']);
    const stock = await kit.reports.service.listFilters(kit.db, kit.actorFor(MANAGEMENT), 'stock');
    expect(stock.map((f) => f.name)).toEqual(['Low stock']);
    const theirs = await kit.reports.service.listFilters(kit.db, kit.actorFor(ACCOUNTANT));
    expect(theirs.map((f) => f.name)).toEqual(['Accountant view']);
  });

  it('refuses a name already used for the report (case aside), an empty name and a report not open to the caller', async () => {
    expect(await codeOf(save('LOW STOCK'))).toBe('saved_filter_exists');
    expect(await codeOf(save('Low stock', kit.actorFor(MANAGEMENT), 'pipeline'))).toBe('no error');
    expect(await codeOf(save('   '))).toBe('name_required');
    expect(await codeOf(save('Not mine', kit.actorFor(PM), 'stock'))).toBe('forbidden');
  });

  it('removes a filter once, only for its owner and only at the right version', async () => {
    const saved = await save('To remove');
    const remove = (id: string, version: number, actor = kit.actorFor(MANAGEMENT)) =>
      kit.db.transaction((tx) => kit.reports.service.removeFilter(id, version, actor, tx));
    expect(await codeOf(remove(saved.id, 1, kit.actorFor(ACCOUNTANT)))).toBe(
      'saved_filter_not_found',
    );
    expect(await codeOf(remove(saved.id, 7))).toBe('version_conflict');
    expect(await codeOf(remove(saved.id, 1))).toBe('no error');
    expect(await codeOf(remove(saved.id, 1))).toBe('saved_filter_not_found');
    expect(
      (await kit.reports.service.listFilters(kit.db, kit.actorFor(MANAGEMENT))).map((f) => f.name),
    ).not.toContain('To remove');
    expect(
      await count(
        `select count(*) as n from sys_audit_log where action = 'reports.filter.remove' and entity_id = $1`,
        [saved.id],
      ),
    ).toBe(1);
    // The name is free again.
    expect(await codeOf(save('To remove'))).toBe('no error');
  });
});

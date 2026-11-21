import { Money } from '@emporium/domain/kernel';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  NOBODY,
  PM,
  PM2,
  SUPERVISOR,
  TODAY,
  createProfitabilityKit,
  scriptedProject,
  uid,
  type ProfitabilityKit,
} from '../test-support.js';

let kit: ProfitabilityKit;
beforeAll(async () => {
  kit = await createProfitabilityKit();
}, 120_000);
afterAll(() => kit.close());

const service = () => kit.profitability.service;
const tx = <T>(run: (db: ProfitabilityKit['db']) => Promise<T>) => kit.db.transaction(run);
const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};
const owner = () => kit.actorFor(MANAGEMENT);

describe('project financials (T-1, AC-1)', () => {
  it('matches the hand-calculated worksheet of the scripted project to the paisa', async () => {
    const project = scriptedProject(kit);
    const result = await service().getProjectFinancials(kit.db, project.id, undefined, owner());
    // Worksheet (PKR). Contract 1,000,000 + variation 100,000 = 1,100,000.
    // Billed: invoices 600,000 + 300,000 base (tax 108,000 + 54,000), less a credit note of 100,000
    //   (tax 18,000) = base 800,000, tax 144,000, gross 944,000.
    // Collected: 354,000 + 236,000 = 590,000 gross (of which 12,000 + 8,000 = 20,000 withheld tax),
    //   500,000 of base. Outstanding receivable = 944,000 - 590,000 = 354,000.
    // Cost: committed 100,000, approved 120,000 + 80,000 = 200,000, posted 300,000; budget 900,000.
    //   To date 600,000 (66.67% of budget); to complete 900,000 - 600,000 = 300,000.
    // Expected margin = 1,100,000 - 600,000 - 300,000 = 200,000 (18.18%).
    // Current margin = 800,000 billed - 300,000 posted - 200,000 approved = 300,000 (37.50%).
    // Paid out: vendors 150,000 + 100,000, wages 120,000, expenses 10,000 = 380,000.
    // Cash position = 590,000 - 380,000 = 210,000.
    expect(result).toMatchObject({
      projectId: project.id,
      asOf: TODAY,
      contractValue: '1100000.00',
      billedBase: '800000.00',
      billedTax: '144000.00',
      billedGross: '944000.00',
      billedPercent: '72.73',
      collectedGross: '590000.00',
      collectedBase: '500000.00',
      withheldTax: '20000.00',
      collectedPercent: '45.45',
      outstandingReceivable: '354000.00',
      committed: '100000.00',
      approved: '200000.00',
      posted: '300000.00',
      costToDate: '600000.00',
      budget: '900000.00',
      costPercentOfBudget: '66.67',
      costToComplete: '300000.00',
      costToCompleteSource: 'budget',
      expectedMargin: '200000.00',
      expectedMarginPercent: '18.18',
      currentMargin: '300000.00',
      currentMarginPercent: '37.50',
      paidOutVendors: '250000.00',
      paidOutWages: '120000.00',
      paidOutExpenses: '10000.00',
      paidOut: '380000.00',
      cashPosition: '210000.00',
      forecast: null,
      thresholds: null,
      alerts: [],
      oldestDueDate: '2026-10-31',
    });
  });

  it('uses a manual forecast over the unused budget, and a later forecast over an earlier one (T-2)', async () => {
    const project = scriptedProject(kit);
    const manager = kit.actorFor(PM);
    const first = await tx((db) =>
      service().setForecast(
        project.id,
        { costToComplete: '100000', note: ' first estimate ', forecastDate: '2026-10-20' },
        manager,
        db,
      ),
    );
    expect(first).toMatchObject({
      projectId: project.id,
      costToComplete: '100000.00',
      note: 'first estimate',
      forecastDate: '2026-10-20',
      setBy: PM,
    });
    const at = (asOf?: string) =>
      service().getProjectFinancials(kit.db, project.id, asOf, kit.actorFor(MANAGEMENT));
    const withForecast = await at();
    expect(withForecast).toMatchObject({
      costToComplete: '100000.00',
      costToCompleteSource: 'forecast',
      expectedMargin: '400000.00', // 1,100,000 - 600,000 - 100,000
      expectedMarginPercent: '36.36',
      currentMargin: '300000.00',
    });
    expect(withForecast.forecast?.id).toBe(first.id);
    // A newer forecast replaces it; one made later than the asked date is ignored.
    await tx((db) =>
      service().setForecast(
        project.id,
        { costToComplete: '0', forecastDate: '2026-10-24' },
        manager,
        db,
      ),
    );
    expect((await at()).costToComplete).toBe('0.00');
    expect((await at('2026-10-23')).costToComplete).toBe('100000.00');
    expect((await at('2026-10-19')).costToCompleteSource).toBe('budget');
    // Default forecast date: today.
    const dated = await tx((db) =>
      service().setForecast(project.id, { costToComplete: '5.5' }, manager, db),
    );
    expect(dated).toMatchObject({ forecastDate: TODAY, note: '', costToComplete: '5.50' });
  });

  it('gives nulls, not errors, for a project with no budget, no billing and no contract', async () => {
    const project = kit.project();
    const result = await service().getProjectFinancials(kit.db, project.id, undefined, owner());
    expect(result).toMatchObject({
      contractValue: '0.00',
      billedPercent: null,
      collectedPercent: null,
      costPercentOfBudget: null,
      expectedMargin: '0.00',
      expectedMarginPercent: null,
      currentMarginPercent: null,
      costToComplete: '0.00',
      cashPosition: '0.00',
      outstandingReceivable: '0.00',
      oldestDueDate: null,
      alerts: [],
    });
  });

  it('shows a negative cash position when the company has funded the project', async () => {
    const project = kit.project({
      receipts: [{ date: '2026-10-01', gross: '1000.00', withheld: '0.00', base: '847.46' }],
      paid: {
        vendors: [{ date: '2026-10-02', amount: '2500.00' }],
        wages: [],
        expenses: [],
      },
    });
    expect(
      (await service().getProjectFinancials(kit.db, project.id, undefined, owner())).cashPosition,
    ).toBe('-1500.00');
  });

  it('refuses a bad date and an unknown project', async () => {
    const project = kit.project();
    expect(
      await codeOf(() => service().getProjectFinancials(kit.db, project.id, '2026-02-30', owner())),
    ).toBe('invalid_date');
    expect(
      await codeOf(() => service().getProjectFinancials(kit.db, uid(9), undefined, owner())),
    ).toBe('project_not_found');
  });
});

describe('as-of reproducibility (T-4, BR-6)', () => {
  it('ignores everything dated after the asked date', async () => {
    const project = scriptedProject(kit);
    const at = (asOf: string) => service().getProjectFinancials(kit.db, project.id, asOf, owner());
    // On 7 October: contract 1,000,000 (the variation is of the 10th); only the first invoice
    // (600,000 + 108,000 tax), nothing collected, committed 100,000, approved 120,000, posted 300,000.
    expect(await at('2026-10-07')).toMatchObject({
      asOf: '2026-10-07',
      contractValue: '1000000.00',
      billedBase: '600000.00',
      billedGross: '708000.00',
      collectedGross: '0.00',
      outstandingReceivable: '708000.00',
      committed: '100000.00',
      approved: '120000.00',
      posted: '300000.00',
      costToDate: '520000.00',
      costToComplete: '380000.00',
      expectedMargin: '100000.00', // 1,000,000 - 520,000 - 380,000
      currentMargin: '180000.00', // 600,000 - 300,000 - 120,000
      paidOut: '0.00',
      cashPosition: '0.00',
    });
    // On 9 October the first receipt (354,000 with 12,000 withheld) and 150,000 to vendors are in.
    expect(await at('2026-10-09')).toMatchObject({
      collectedGross: '354000.00',
      withheldTax: '12000.00',
      paidOutVendors: '150000.00',
      cashPosition: '204000.00',
    });
    // A later query does not change an earlier answer.
    expect(await at('2026-10-07')).toMatchObject({ cashPosition: '0.00', paidOut: '0.00' });
  });
});

describe('the portfolio (BR-5)', () => {
  it('lists the visible projects with the key figures, riskiest first', async () => {
    const db = await createProfitabilityKit();
    try {
      const healthy = scriptedProject(db, { budget: '2000000.00' });
      const risky = scriptedProject(db);
      const inactive = db.project({ status: 'on_hold', name: 'Paused' });
      await db.db.transaction((tx2) =>
        db.profitability.service.createThreshold(
          {
            scope: 'company',
            marginFloorPercent: '25',
            overspendPercent: '50',
            receivableAgeDays: 100,
          },
          db.actorFor(MANAGEMENT),
          tx2,
        ),
      );
      const portfolio = await db.profitability.service.listProjectFinancials(
        db.db,
        {},
        db.actorFor(MANAGEMENT),
      );
      expect(portfolio.asOf).toBe(TODAY);
      // The project with the 900,000 budget has an expected margin of 18.18% (below the floor of 25)
      // and has used 66.67% of its budget (above 50): two alerts, so it comes first. The one with a
      // 2,000,000 budget has used 30% but expects 1,100,000 - 600,000 - 1,400,000 = -900,000: one
      // alert. The paused project has nothing to compare: none.
      expect(portfolio.items.map((item) => item.projectId)).toEqual([
        risky.id,
        healthy.id,
        inactive.id,
      ]);
      expect(portfolio.items[0]?.alerts).toEqual(['margin_below_floor', 'overspend']);
      expect(portfolio.items[1]).toMatchObject({
        code: healthy.code,
        contractValue: '1100000.00',
        billedPercent: '72.73',
        collectedPercent: '45.45',
        costPercentOfBudget: '30.00',
        expectedMargin: '-900000.00',
        cashPosition: '210000.00',
        alerts: ['margin_below_floor'],
      });
      expect(portfolio.items[2]).toMatchObject({ expectedMarginPercent: null, alerts: [] });
      const onHold = await db.profitability.service.listProjectFinancials(
        db.db,
        { status: 'on_hold' },
        db.actorFor(MANAGEMENT),
      );
      expect(onHold.items.map((item) => item.projectId)).toEqual([inactive.id]);
    } finally {
      await db.close();
    }
  });
});

describe('visibility (BR-8, T-6)', () => {
  it('lets management and the accountant see every project and a project manager their own', async () => {
    const mine = kit.project({ projectManagerId: PM });
    const theirs = kit.project({ projectManagerId: PM2 });
    const none = kit.project({ projectManagerId: null });
    const idsFor = async (userId: string) =>
      (await service().listProjectFinancials(kit.db, {}, kit.actorFor(userId))).items.map(
        (item) => item.projectId,
      );
    for (const userId of [MANAGEMENT, ACCOUNTANT]) {
      const ids = await idsFor(userId);
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id, none.id]));
    }
    const pm = await idsFor(PM);
    expect(pm).toContain(mine.id);
    expect(pm).not.toContain(theirs.id);
    expect(pm).not.toContain(none.id);
    expect(
      (await service().getProjectFinancials(kit.db, mine.id, undefined, kit.actorFor(PM)))
        .projectId,
    ).toBe(mine.id);
    // Someone else's project is reported as missing.
    expect(
      await codeOf(() =>
        service().getProjectFinancials(kit.db, theirs.id, undefined, kit.actorFor(PM)),
      ),
    ).toBe('project_not_found');
    expect(
      await codeOf(() =>
        service().getProjectFinancials(kit.db, none.id, undefined, kit.actorFor(PM)),
      ),
    ).toBe('project_not_found');
  });

  it('gives supervisors and users without a role nothing', async () => {
    const project = kit.project();
    for (const userId of [SUPERVISOR, NOBODY]) {
      const actor = kit.actorFor(userId);
      expect(
        await codeOf(() => service().getProjectFinancials(kit.db, project.id, undefined, actor)),
      ).toBe('forbidden');
      expect(await codeOf(() => service().listProjectFinancials(kit.db, {}, actor))).toBe(
        'forbidden',
      );
      expect(await codeOf(() => service().listAlerts(kit.db, {}, actor))).toBe('forbidden');
      expect(await codeOf(() => service().listThresholds(kit.db, actor))).toBe('forbidden');
      expect(await codeOf(() => service().download(kit.db, {}, 'csv', actor))).toBe('forbidden');
    }
  });

  it('keeps the forecast to project managers and management, and the thresholds to management', async () => {
    const project = kit.project({ projectManagerId: PM });
    const set = (userId: string, id = project.id) =>
      tx((db) => service().setForecast(id, { costToComplete: '1' }, kit.actorFor(userId), db));
    expect((await set(MANAGEMENT)).projectId).toBe(project.id);
    expect((await set(PM)).projectId).toBe(project.id);
    expect(await codeOf(() => set(ACCOUNTANT))).toBe('forbidden');
    expect(await codeOf(() => set(SUPERVISOR))).toBe('forbidden');
    // Another manager cannot see this project, so cannot forecast it.
    expect(await codeOf(() => set(PM2))).toBe('project_not_found');
    expect(await codeOf(() => set(MANAGEMENT, uid(8)))).toBe('project_not_found');
    expect(
      await codeOf(() =>
        tx((db) =>
          service().setForecast(project.id, { costToComplete: '-1' }, kit.actorFor(PM), db),
        ),
      ),
    ).toBe('invalid_amount');
    expect(
      await codeOf(() =>
        tx((db) =>
          service().setForecast(project.id, { costToComplete: '1.234' }, kit.actorFor(PM), db),
        ),
      ),
    ).toBe('invalid_amount');
    for (const userId of [PM, ACCOUNTANT]) {
      const actor = kit.actorFor(userId);
      expect(
        await codeOf(() =>
          tx((db) =>
            service().createThreshold(
              {
                scope: 'company',
                marginFloorPercent: '1',
                overspendPercent: '1',
                receivableAgeDays: 1,
              },
              actor,
              db,
            ),
          ),
        ),
      ).toBe('forbidden');
    }
  });
});

describe('property: the figures follow their sources (T-5)', () => {
  it('cash position = collected - paid out, and cost totals equal the cost summary', async () => {
    const amount = fc.integer({ min: 0, max: 5_000_000 }).map((cents) => (cents / 100).toFixed(2));
    const day = fc.integer({ min: 1, max: 28 }).map((d) => `2026-10-${String(d).padStart(2, '0')}`);
    const dated = fc.record({ date: day, amount });
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ date: day, gross: amount, withheld: fc.constant('0.00'), base: amount }),
          { maxLength: 6 },
        ),
        fc.array(dated, { maxLength: 6 }),
        fc.array(dated, { maxLength: 6 }),
        fc.array(dated, { maxLength: 6 }),
        fc.array(
          fc.record({
            date: day,
            status: fc.constantFrom('committed', 'approved', 'posted'),
            amount,
          }),
          { maxLength: 8 },
        ),
        day,
        async (receipts, vendors, wages, expenses, costs, asOf) => {
          const project = kit.project({
            receipts,
            costs,
            paid: { vendors, wages, expenses },
          });
          const result = await service().getProjectFinancials(kit.db, project.id, asOf, owner());
          const collected = receipts
            .filter((r) => r.date <= asOf)
            .reduce((all, r) => all.add(Money.of(r.gross)), Money.zero());
          const paid = [vendors, wages, expenses]
            .flat()
            .filter((p) => p.date <= asOf)
            .reduce((all, p) => all.add(Money.of(p.amount)), Money.zero());
          expect(result.cashPosition).toBe(collected.sub(paid).toString());
          const summary = await kit.profitability.service.getProjectFinancials(
            kit.db,
            project.id,
            asOf,
            owner(),
          );
          const byStatus = (status: string) =>
            costs
              .filter((c) => c.date <= asOf && c.status === status)
              .reduce((all, c) => all.add(Money.of(c.amount)), Money.zero())
              .toString();
          expect([summary.committed, summary.approved, summary.posted]).toEqual([
            byStatus('committed'),
            byStatus('approved'),
            byStatus('posted'),
          ]);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('thresholds', () => {
  it('creates, updates, lists and removes company and project thresholds with audit and events', async () => {
    const project = kit.project();
    const manager = kit.actorFor(MANAGEMENT);
    const created = await tx((db) =>
      service().createThreshold(
        {
          scope: 'project',
          projectId: project.id,
          marginFloorPercent: '12.5',
          overspendPercent: '110',
          receivableAgeDays: 45,
        },
        manager,
        db,
      ),
    );
    expect(created).toMatchObject({
      scope: 'project',
      projectId: project.id,
      marginFloorPercent: '12.5000',
      overspendPercent: '110.0000',
      receivableAgeDays: 45,
      active: true,
      version: 1,
    });
    const updated = await tx((db) =>
      service().updateThreshold(
        created.id,
        {
          marginFloorPercent: '15',
          overspendPercent: '120',
          receivableAgeDays: 30,
          active: false,
          version: 1,
        },
        manager,
        db,
      ),
    );
    expect(updated).toMatchObject({ marginFloorPercent: '15.0000', active: false, version: 2 });
    // `active` is kept when the update does not name it.
    const kept = await tx((db) =>
      service().updateThreshold(
        created.id,
        { marginFloorPercent: '15', overspendPercent: '120', receivableAgeDays: 30, version: 2 },
        manager,
        db,
      ),
    );
    expect(kept.active).toBe(false);
    expect(
      await codeOf(() =>
        tx((db) =>
          service().updateThreshold(
            created.id,
            { marginFloorPercent: '1', overspendPercent: '1', receivableAgeDays: 1, version: 1 },
            manager,
            db,
          ),
        ),
      ),
    ).toBe('version_conflict');
    expect(
      (await service().listThresholds(kit.db, kit.actorFor(ACCOUNTANT))).map((t) => t.id),
    ).toContain(created.id);
    const audits = await kit.db.query<{ action: string }>(
      `select action from sys_audit_log where entity_type = 'pft_threshold' and entity_id = $1 order by id`,
      [created.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'profitability.threshold.create',
      'profitability.threshold.update',
      'profitability.threshold.update',
    ]);
    await tx((db) => service().removeThreshold(created.id, 3, manager, db));
    expect((await service().listThresholds(kit.db, manager)).map((t) => t.id)).not.toContain(
      created.id,
    );
    const events = await kit.db.query<{ n: string }>(
      `select count(*)::text as n from sys_outbox where type = 'profitability.threshold.changed'`,
    );
    // create, two updates and the removal
    expect(Number(events[0]?.n)).toBe(4);
  });

  it('refuses a duplicate scope, a mismatched scope, bad numbers, a missing project and a stale delete', async () => {
    const manager = kit.actorFor(MANAGEMENT);
    const create = (input: Parameters<ReturnType<typeof service>['createThreshold']>[0]) =>
      tx((db) => service().createThreshold(input, manager, db));
    const base = { marginFloorPercent: '10', overspendPercent: '100', receivableAgeDays: 30 };
    const company = await create({ scope: 'company', ...base });
    expect(await codeOf(() => create({ scope: 'company', ...base }))).toBe('threshold_exists');
    expect(await codeOf(() => create({ scope: 'company', projectId: uid(1), ...base }))).toBe(
      'invalid_scope',
    );
    expect(await codeOf(() => create({ scope: 'project', ...base }))).toBe('invalid_scope');
    expect(await codeOf(() => create({ scope: 'project', projectId: uid(8), ...base }))).toBe(
      'project_not_found',
    );
    expect(
      await codeOf(() =>
        create({
          scope: 'project',
          projectId: kit.project().id,
          ...base,
          marginFloorPercent: '150',
        }),
      ),
    ).toBe('invalid_threshold');
    expect(
      await codeOf(() => tx((db) => service().removeThreshold(company.id, 9, manager, db))),
    ).toBe('version_conflict');
    expect(await codeOf(() => tx((db) => service().removeThreshold(uid(7), 1, manager, db)))).toBe(
      'threshold_not_found',
    );
    expect(
      await codeOf(() =>
        tx((db) => service().updateThreshold(uid(7), { ...base, version: 1 }, manager, db)),
      ),
    ).toBe('threshold_not_found');
    await tx((db) => service().removeThreshold(company.id, 1, manager, db));
  });
});

describe('alerts (BR-4, T-3, AC-2)', () => {
  it('raises once, tells the manager and management, and clears when the condition is gone', async () => {
    const own = await createProfitabilityKit();
    try {
      const s = own.profitability.service;
      const manager = own.actorFor(MANAGEMENT);
      const run = () => own.db.transaction((db) => s.evaluateAlerts(db));
      const project = scriptedProject(own);
      const noManager = scriptedProject(own, { projectManagerId: null });
      const planning = scriptedProject(own, { status: 'planning' });
      // Without thresholds nothing is raised.
      expect(await run()).toEqual({ raised: 0, cleared: 0 });
      await own.db.transaction((db) =>
        s.createThreshold(
          {
            scope: 'company',
            marginFloorPercent: '25',
            overspendPercent: '50',
            receivableAgeDays: 30,
          },
          manager,
          db,
        ),
      );
      // On 31 December: margin 18.18% < 25, cost 66.67% > 50, and the invoice due 31 October is
      // 61 days old. Two active projects raise three alerts each; the planning one is skipped.
      own.now.current = new Date('2026-12-31T10:00:00Z');
      expect(await run()).toEqual({ raised: 6, cleared: 0 });
      const alerts = await s.listAlerts(own.db, { onlyOpen: true }, manager);
      expect(alerts.map((a) => [a.projectId, a.alertCode]).sort()).toEqual(
        [project.id, noManager.id]
          .flatMap((id) =>
            ['margin_below_floor', 'overspend', 'receivable_overdue'].map((c) => [id, c]),
          )
          .sort(),
      );
      expect(alerts.some((a) => a.projectId === planning.id)).toBe(false);
      expect(alerts[0]?.clearedAt).toBeNull();
      expect(alerts[0]?.projectCode).toMatch(/^P-\d{4}$/);
      // Three alerts of the first project tell its manager and management; the other only management.
      const forPm = own.notified.filter((n) => n.kind === 'user');
      expect(forPm).toHaveLength(3);
      expect(forPm.every((n) => (n.to as string[])[0] === PM)).toBe(true);
      expect(own.notified.filter((n) => n.kind === 'role' && n.to === 'management')).toHaveLength(
        6,
      );
      expect(forPm[0]?.template).toBe('profitability.alert.raised');
      expect(String(forPm[0]?.data.project)).toContain(project.code);
      // Running again raises nothing new: no duplicates.
      expect(await run()).toEqual({ raised: 0, cleared: 0 });
      expect(await s.listAlerts(own.db, { onlyOpen: true }, manager)).toHaveLength(6);
      // A project threshold replaces the company one for that project: the margin floor drops, so that
      // alert clears; the others stay.
      await own.db.transaction((db) =>
        s.createThreshold(
          {
            scope: 'project',
            projectId: project.id,
            marginFloorPercent: '10',
            overspendPercent: '50',
            receivableAgeDays: 30,
          },
          manager,
          db,
        ),
      );
      expect(await run()).toEqual({ raised: 0, cleared: 1 });
      const open = await s.listAlerts(own.db, { onlyOpen: true }, manager);
      expect(
        open
          .filter((a) => a.projectId === project.id)
          .map((a) => a.alertCode)
          .sort(),
      ).toEqual(['overspend', 'receivable_overdue']);
      // The cleared alert stays in the full list, after the open ones, with its clear time.
      const all = await s.listAlerts(own.db, {}, manager);
      // Five open and the cleared one are the same six rows: a cleared alert is not a new row.
      expect(all).toHaveLength(6);
      expect(all.at(-1)).toMatchObject({
        projectId: project.id,
        alertCode: 'margin_below_floor',
        clearedAt: '2026-12-31T10:00:00Z',
      });
      // The money comes in: the receivable alert clears too, and the margin one can come back later.
      project.receipts.push({
        date: '2026-12-01',
        gross: '500000.00',
        withheld: '0.00',
        base: '338983.05',
      });
      expect(await run()).toEqual({ raised: 0, cleared: 1 });
      // A raised alert is audited and published.
      const events = await own.db.query<{ n: string }>(
        `select count(*)::text as n from sys_outbox where type = 'profitability.alert.raised'`,
      );
      expect(events[0]?.n).toBe('6');
      const cleared = await own.db.query<{ n: string }>(
        `select count(*)::text as n from sys_outbox where type = 'profitability.alert.cleared'`,
      );
      expect(cleared[0]?.n).toBe('2');
      // Margin below the floor raises again after it was cleared: a new alert, not a revived one.
      const projectThreshold = (await s.listThresholds(own.db, manager)).find(
        (t) => t.projectId === project.id,
      );
      await own.db.transaction((db) =>
        s.updateThreshold(
          projectThreshold?.id as string,
          { marginFloorPercent: '30', overspendPercent: '50', receivableAgeDays: 30, version: 1 },
          manager,
          db,
        ),
      );
      expect(await run()).toEqual({ raised: 1, cleared: 0 });
    } finally {
      await own.close();
    }
  });

  it('lists only the alerts of projects the caller may see', async () => {
    const own = await createProfitabilityKit();
    try {
      const s = own.profitability.service;
      const mine = scriptedProject(own, { projectManagerId: PM });
      scriptedProject(own, { projectManagerId: PM2 });
      await own.db.transaction((db) =>
        s.createThreshold(
          {
            scope: 'company',
            marginFloorPercent: '25',
            overspendPercent: '50',
            receivableAgeDays: 30,
          },
          own.actorFor(MANAGEMENT),
          db,
        ),
      );
      await own.db.transaction((db) => s.evaluateAlerts(db));
      // The portfolio export names the alerts that hold, in words.
      const exported = await s.exportTables(own.db, {}, own.actorFor(MANAGEMENT));
      expect(exported.main.rows[0]?.alerts).toBe(
        'Expected margin is below the floor; Cost used is above the overspend limit',
      );
      expect((await s.listAlerts(own.db, {}, own.actorFor(MANAGEMENT))).length).toBe(4);
      const seen = await s.listAlerts(own.db, {}, own.actorFor(PM));
      expect(seen.length).toBe(2);
      expect(new Set(seen.map((a) => a.projectId))).toEqual(new Set([mine.id]));
    } finally {
      await own.close();
    }
  });
});

describe('exports (BR-9)', () => {
  it('builds the project and portfolio tables with percent columns and the alert names', async () => {
    const project = scriptedProject(kit);
    const tables = await service().exportTables(kit.db, { projectId: project.id }, owner());
    expect(tables.fileStem).toBe(`profitability-${project.code}`);
    expect(tables.filters).toEqual({ project: `${project.code} ${project.name}`, asOf: TODAY });
    const row = (figure: string) => tables.main.rows.find((r) => r.figure === figure);
    expect(row('Expected margin')).toEqual({
      figure: 'Expected margin',
      amount: '200000.00',
      percent: '18.18',
    });
    expect(row('Cost to complete (from the budget)')?.amount).toBe('300000.00');
    expect(row('Cash position (collected less paid out)')?.amount).toBe('210000.00');
    // With a forecast the label says so.
    await tx((db) =>
      service().setForecast(project.id, { costToComplete: '1000' }, kit.actorFor(MANAGEMENT), db),
    );
    const forecasted = await service().exportTables(kit.db, { projectId: project.id }, owner());
    expect(
      forecasted.main.rows.some((r) => r.figure === 'Cost to complete (manual forecast)'),
    ).toBe(true);
    const portfolio = await service().exportTables(kit.db, {}, owner());
    expect(portfolio.fileStem).toBe('profitability-portfolio');
    expect(portfolio.main.columns.map((c) => c.key)).toContain('cashPosition');
    expect(portfolio.main.rows.length).toBeGreaterThan(0);
  });

  it('downloads CSV and Excel with the header block and a dated file name', async () => {
    const project = scriptedProject(kit);
    const csv = await service().download(kit.db, { projectId: project.id }, 'csv', owner());
    expect(csv).toMatchObject({
      contentType: 'text/csv; charset=utf-8',
      fileName: `profitability-${project.code}-${TODAY}.csv`,
    });
    const text = csv.body as string;
    expect(text).toContain('Project profitability');
    expect(text).toContain('Generated by');
    expect(text).toContain('Expected margin,200000.00,18.18');
    const xlsx = await service().download(kit.db, {}, 'xlsx', owner());
    expect(xlsx.fileName).toBe(`profitability-portfolio-${TODAY}.xlsx`);
    expect(xlsx.contentType).toContain('spreadsheetml');
    expect(Buffer.isBuffer(xlsx.body)).toBe(true);
    // The caller's name stands in the header when it is known, else their id.
    const anonymous = { ...kit.actorFor(MANAGEMENT), name: undefined };
    const anon = await service().download(kit.db, { projectId: project.id }, 'csv', anonymous);
    expect(anon.body as string).toContain(MANAGEMENT);
  });
});

describe('module interfaces', () => {
  it('exposes the financials and the alert job to other modules', async () => {
    const project = scriptedProject(kit);
    const viaModule = await kit.profitability.getProjectFinancials(
      kit.db,
      project.id,
      undefined,
      owner(),
    );
    expect(viaModule.contractValue).toBe('1100000.00');
    expect(
      (await kit.profitability.listProjectFinancials(kit.db, {}, owner())).items.length,
    ).toBeGreaterThan(0);
    const job = await tx((db) => kit.profitability.evaluateAlerts(db));
    expect(Object.keys(job)).toEqual(['raised', 'cleared']);
  });
});

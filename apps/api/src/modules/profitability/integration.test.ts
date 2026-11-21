import { projectsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../../acceptance/harness.js';
import type { AlertDto, PortfolioDto, ProjectFinancialsDto } from './types.js';

vi.setConfig({ testTimeout: 120_000 });

/**
 * The real modules wired as in production (the acceptance harness): every query interface that
 * profitability composes runs against the real schema, so a mistake in one of the owning modules'
 * SQL or in the wiring shows up here and not only against the fakes of the unit tests.
 */
let h: Harness;
let projectId: string;
beforeAll(async () => {
  h = await createHarness();
  const { runtime } = h;
  const admin = { userId: h.userId('admin'), requestId: null };
  const pm = {
    userId: h.userId('pm'),
    roles: ['project_manager'],
    scopes: [],
    permissions: new Set<string>(Object.values(projectsPermissions)),
    requestId: null,
  };
  const party = await h.db.transaction((tx) =>
    runtime.masterData.parties.create({ name: 'Synthetic Client', roles: ['client'] }, admin, tx),
  );
  const codes = Object.fromEntries(
    (await runtime.masterData.costing.listCostCodes(h.db)).map((code) => [code.code, code.id]),
  ) as Record<string, string>;
  const created = await h.db.transaction((tx) =>
    runtime.projects.service.create(
      {
        name: 'Profitability smoke',
        partyId: party.id,
        sector: 'private',
        originalContractValue: '1000000',
        startDate: null,
      },
      pm,
      tx,
    ),
  );
  await h.db.transaction((tx) =>
    runtime.projects.service.replaceBudget(
      created.id,
      [{ costCodeId: codes['100'] as string, budgetAmount: '400000' }],
      created.version,
      pm,
      tx,
    ),
  );
  const current = await runtime.projects.getProject(h.db, created.id);
  const active = await h.db.transaction((tx) =>
    runtime.projects.service.transition(created.id, 'active', current.version, pm, tx),
  );
  projectId = active.id;
  await h.db.transaction((tx) =>
    runtime.projects.postCost(
      {
        costObject: { type: 'project', id: projectId },
        costCodeId: codes['100'] as string,
        amount: '150000.00',
        status: 'posted',
        sourceModule: 'smoke',
        sourceDocType: 'scenario',
        sourceDocId: '018f9000-0000-7000-8000-000000000501',
        sourceLineId: '018f9000-0000-7000-8000-000000000501',
        entryDate: '2026-10-20',
        description: 'Smoke cost',
        idempotencyKey: 'profitability-smoke-1',
      },
      tx,
    ),
  );
}, 180_000);
afterAll(() => h.close());

describe('profitability on the real modules', () => {
  it('composes the figures of a project from the owning modules (AC-1)', async () => {
    const response = await h.call<ProjectFinancialsDto>(
      'owner',
      'GET',
      `/profitability/projects/${projectId}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      projectId,
      asOf: '2026-10-26',
      contractValue: '1000000.00',
      billedBase: '0.00',
      billedGross: '0.00',
      collectedGross: '0.00',
      outstandingReceivable: '0.00',
      committed: '0.00',
      approved: '0.00',
      posted: '150000.00',
      costToDate: '150000.00',
      budget: '400000.00',
      costPercentOfBudget: '37.50',
      costToComplete: '250000.00',
      costToCompleteSource: 'budget',
      expectedMargin: '600000.00',
      expectedMarginPercent: '60.00',
      currentMargin: '-150000.00',
      currentMarginPercent: null,
      paidOut: '0.00',
      cashPosition: '0.00',
      oldestDueDate: null,
      alerts: [],
    });
  });

  it('reproduces an earlier date: the cost entered on 20 October is not there on the 19th', async () => {
    const before = await h.call<ProjectFinancialsDto>(
      'owner',
      'GET',
      `/profitability/projects/${projectId}?asOf=2026-10-19`,
    );
    expect(before.body).toMatchObject({
      asOf: '2026-10-19',
      posted: '0.00',
      costToDate: '0.00',
      costToComplete: '400000.00',
      expectedMargin: '600000.00',
    });
  });

  it('lists the project in the portfolio and exports it', async () => {
    const list = await h.call<PortfolioDto>('accountant', 'GET', '/profitability/projects');
    expect(list.status).toBe(200);
    expect(list.body.items.find((item) => item.projectId === projectId)).toMatchObject({
      contractValue: '1000000.00',
      costPercentOfBudget: '37.50',
      cashPosition: '0.00',
    });
    const csv = await h.app.inject({
      method: 'GET',
      url: '/profitability/projects?format=csv',
      headers: { authorization: `Bearer ${await h.tokenFor('owner')}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('Profitability smoke');
    const xlsx = await h.app.inject({
      method: 'GET',
      url: `/profitability/projects/${projectId}?format=xlsx`,
      headers: { authorization: `Bearer ${await h.tokenFor('owner')}` },
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.length).toBeGreaterThan(1000);
  });

  it('raises an alert once the thresholds are set and the scheduler job runs, and clears it again', async () => {
    const none = await h.call<AlertDto[]>('owner', 'GET', '/profitability/alerts');
    expect(none.body).toEqual([]);
    const created = await h.call<{ id: string; version: number }>(
      'owner',
      'POST',
      '/profitability/thresholds',
      {
        scope: 'company',
        marginFloorPercent: '70',
        overspendPercent: '100',
        receivableAgeDays: 30,
      },
    );
    expect(created.status).toBe(201);
    // The expected margin is 60%, below the floor of 70.
    expect(await h.runtime.profitability.evaluateAlerts(h.db)).toEqual({ raised: 1, cleared: 0 });
    const raised = await h.call<AlertDto[]>('owner', 'GET', '/profitability/alerts?onlyOpen=true');
    expect(raised.body).toHaveLength(1);
    expect(raised.body[0]).toMatchObject({ projectId, alertCode: 'margin_below_floor' });
    // The owner is told through the notification module (management role).
    const notes = await h.db.query<{ n: string }>(
      `select count(*)::text as n from ntf_notifications where template = 'profitability.alert.raised'`,
    );
    expect(Number(notes[0]?.n)).toBeGreaterThanOrEqual(1);
    // Raising again changes nothing; lowering the floor clears it.
    expect(await h.runtime.profitability.evaluateAlerts(h.db)).toEqual({ raised: 0, cleared: 0 });
    const lowered = await h.call('owner', 'PUT', `/profitability/thresholds/${created.body.id}`, {
      marginFloorPercent: '50',
      overspendPercent: '100',
      receivableAgeDays: 30,
      version: created.body.version,
    });
    expect(lowered.status).toBe(200);
    expect(await h.runtime.profitability.evaluateAlerts(h.db)).toEqual({ raised: 0, cleared: 1 });
    const open = await h.call<AlertDto[]>('owner', 'GET', '/profitability/alerts?onlyOpen=true');
    expect(open.body).toEqual([]);
  });

  it('saves a forecast through the API and uses it in the figures', async () => {
    const saved = await h.call('pm', 'PUT', `/profitability/projects/${projectId}/forecast`, {
      costToComplete: '100000',
      note: 'Roof done',
    });
    // The project manager of this project is not set, so a project manager cannot see it.
    expect(saved.status).toBe(404);
    const byOwner = await h.call('owner', 'PUT', `/profitability/projects/${projectId}/forecast`, {
      costToComplete: '100000',
      note: 'Roof done',
    });
    expect(byOwner.status).toBe(200);
    const figures = await h.call<ProjectFinancialsDto>(
      'owner',
      'GET',
      `/profitability/projects/${projectId}`,
    );
    expect(figures.body).toMatchObject({
      costToComplete: '100000.00',
      costToCompleteSource: 'forecast',
      expectedMargin: '750000.00',
    });
  });
});

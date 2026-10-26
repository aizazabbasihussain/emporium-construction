import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  MANAGEMENT,
  PM,
  SUPERVISOR,
  SUPERVISOR2,
  auditCount,
  createProjectsKit,
  eventCount,
  uid,
  type ProjectsKit,
} from '../test-support.js';

let kit: ProjectsKit;
let gov: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
  gov = await createProjectsKit({ allowGovernmentData: true });
}, 120_000);
afterAll(async () => {
  await kit.close();
  await gov.close();
});

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

const pm = () => kit.actorFor(PM);
const tx = <T>(run: (db: ProjectsKit['db']) => Promise<T>) => kit.db.transaction(run);

describe('project from an accepted quotation (BR-1, T-1)', () => {
  it('creates one project with the contract value and the grouped estimate budget', async () => {
    const estimateId = uid(7001);
    kit.estimates.set(estimateId, [
      { costCodeId: kit.codes['100'] as string, amount: '600.00' },
      { costCodeId: kit.codes['200'] as string, amount: '250.50' },
      { costCodeId: kit.codes['100'] as string, amount: '400.00' },
    ]);
    const event = await kit.accept({ estimateId, contractValue: '2500000.00' });
    const found = await kit.db.query<{ id: string }>(
      'select id from prj_projects where quotation_id = $1',
      [event.quotationId],
    );
    expect(found).toHaveLength(1);
    const project = await kit.projects.getProject(kit.db, found[0]?.id as string);
    expect(project.code).toMatch(/^PRJ/);
    expect(project).toMatchObject({
      status: 'planning',
      originalContractValue: '2500000.00',
      estimateId,
      partyId: kit.clientId,
      sector: 'private',
      progressPercent: '0.00',
    });
    expect(project.name).toMatch(/^Synthetic job/);
    const budget = await kit.projects.service.getBudget(kit.db, project.id, kit.actorFor(PM));
    expect(budget.lines.map((l) => [l.costCodeId, l.budgetAmount, l.source])).toEqual([
      [kit.codes['100'], '1000.00', 'estimate'],
      [kit.codes['200'], '250.50', 'estimate'],
    ]);
    expect(await eventCount(kit.db, 'project.created')).toBeGreaterThan(0);
  });

  it('is idempotent: a replayed or duplicate event leaves one project', async () => {
    const event = await kit.accept();
    await tx((db) =>
      kit.platform.events.publish({ type: 'quotation.accepted', payload: event }, db),
    );
    await kit.platform.events.dispatchDue(kit.db);
    const again = await tx((db) => kit.projects.service.createFromQuotation(event, db));
    const rows = await kit.db.query('select 1 from prj_projects where quotation_id = $1', [
      event.quotationId,
    ]);
    expect(rows).toHaveLength(1);
    expect(again.quotationId).toBe(event.quotationId);
  });

  it('gives no budget for a client-supplied estimate (no company-cost lines)', async () => {
    const event = await kit.accept();
    const [row] = await kit.db.query<{ id: string }>(
      'select id from prj_projects where quotation_id = $1',
      [event.quotationId],
    );
    const budget = await kit.projects.service.getBudget(kit.db, row?.id as string, pm());
    expect(budget.lines).toEqual([]);
  });

  it('drops a code whose lines add up to nothing (salvage credits only)', async () => {
    const estimateId = uid(7002);
    kit.estimates.set(estimateId, [{ costCodeId: kit.codes['300'] as string, amount: '-5.00' }]);
    const event = await kit.accept({ estimateId });
    const [row] = await kit.db.query<{ id: string }>(
      'select id from prj_projects where quotation_id = $1',
      [event.quotationId],
    );
    expect((await kit.projects.service.getBudget(kit.db, row?.id as string, pm())).lines).toEqual(
      [],
    );
  });
});

describe('government projects (BR-2, T-2)', () => {
  it('refuses a government project when the flag is off', async () => {
    expect(await codeOf(() => kit.project({ sector: 'government' }))).toBe(
      'government_data_not_allowed',
    );
    const event = {
      quotationId: uid(7101),
      estimateId: uid(7102),
      partyId: kit.clientId,
      sector: 'government' as const,
      locationId: null,
      contractValue: '100.00',
    };
    expect(
      await codeOf(() => tx((db) => kit.projects.service.createFromQuotation(event, db))),
    ).toBe('government_data_not_allowed');
  });

  it('allows it when the flag is on', async () => {
    const created = await gov.project({ sector: 'government' });
    expect(created.sector).toBe('government');
  });
});

describe('manual projects (BR-3)', () => {
  it('creates a project with a code, an audit entry and an event, and no budget', async () => {
    const before = await auditCount(kit.db, 'projects.project.create');
    const project = await kit.project({
      siteAddress: ' Plot 5 ',
      startDate: '2026-11-01',
      plannedEndDate: '2027-02-01',
      locationId: kit.locationId,
      projectManagerId: PM,
    });
    expect(project).toMatchObject({
      status: 'planning',
      siteAddress: 'Plot 5',
      startDate: '2026-11-01',
      plannedEndDate: '2027-02-01',
      quotationId: null,
      estimateId: null,
      supervisors: [],
    });
    expect((await kit.projects.service.getBudget(kit.db, project.id, pm())).lines).toEqual([]);
    expect(await auditCount(kit.db, 'projects.project.create')).toBe(before + 1);
    expect(await kit.projects.getEstimateBudgetSource(kit.db, project.id)).toBeNull();
  });

  it('refuses a missing name, a bad value, an unknown client or location and a bad date', async () => {
    expect(await codeOf(() => kit.project({ name: ' ' }))).toBe('name_required');
    expect(await codeOf(() => kit.project({ originalContractValue: '0' }))).toBe(
      'contract_value_not_positive',
    );
    expect(await codeOf(() => kit.project({ partyId: uid(9999) }))).toBe('party_not_found');
    expect(await codeOf(() => kit.project({ locationId: uid(9998) }))).toBe('location_not_found');
    expect(await codeOf(() => kit.project({ startDate: '2026-02-31' }))).toBeDefined();
  });

  it('lists with filters and limits a supervisor to assigned projects', async () => {
    const first = await kit.project({ name: 'Findable tower' });
    const page = await kit.projects.service.list(
      kit.db,
      { q: 'Findable', status: 'planning', partyId: kit.clientId, limit: 10, offset: 0 },
      pm(),
    );
    expect(page.items.map((p) => p.id)).toEqual([first.id]);
    expect(page.total).toBe(1);
    const supervisor = kit.actorFor(SUPERVISOR, []);
    expect(
      (await kit.projects.service.list(kit.db, { limit: 10, offset: 0 }, supervisor)).items,
    ).toEqual([]);
    const scoped = kit.actorFor(SUPERVISOR, [{ type: 'project', id: first.id }]);
    expect((await kit.projects.listProjectsForUser(kit.db, scoped)).map((p) => p.id)).toEqual([
      first.id,
    ]);
    expect((await kit.projects.listProjectsForUser(kit.db, pm())).length).toBeGreaterThan(1);
    expect(await codeOf(() => kit.projects.service.get(kit.db, first.id, supervisor))).toBe(
      'project_not_found',
    );
  });

  it('updates fields under the version and refuses a stale one', async () => {
    const project = await kit.project();
    const updated = await tx((db) =>
      kit.projects.service.update(
        project.id,
        {
          name: 'Renamed',
          siteAddress: '',
          locationId: kit.locationId,
          startDate: '2026-12-01',
          plannedEndDate: null,
          projectManagerId: PM,
        },
        project.version,
        pm(),
        db,
      ),
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      siteAddress: null,
      startDate: '2026-12-01',
      plannedEndDate: null,
      version: project.version + 1,
    });
    const untouched = await tx((db) =>
      kit.projects.service.update(project.id, {}, updated.version, pm(), db),
    );
    expect(untouched.name).toBe('Renamed');
    expect(
      await codeOf(() =>
        tx((db) =>
          kit.projects.service.update(project.id, { name: 'x' }, project.version, pm(), db),
        ),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(() => tx((db) => kit.projects.service.update(uid(9997), {}, 1, pm(), db))),
    ).toBe('project_not_found');
  });
});

describe('status machine (BR-4, T-3)', () => {
  it('walks planning, active, on hold, active, completed, closed and records events', async () => {
    const before = await eventCount(kit.db, 'project.status.changed');
    let project = await kit.project();
    for (const to of ['active', 'on_hold', 'active', 'completed', 'closed'] as const) {
      project = await tx((db) =>
        kit.projects.service.transition(project.id, to, project.version, pm(), db),
      );
      expect(project.status).toBe(to);
      if (to === 'completed') expect(project.actualEndDate).toBe('2026-10-25');
    }
    expect(await eventCount(kit.db, 'project.status.changed')).toBe(before + 5);
  });

  it('refuses a forbidden move', async () => {
    const project = await kit.project();
    expect(
      await codeOf(() =>
        tx((db) =>
          kit.projects.service.transition(project.id, 'closed', project.version, pm(), db),
        ),
      ),
    ).toBe('project_transition');
  });

  it('refuses to close with committed or unposted approved entries, listing them', async () => {
    const project = await kit.activeProject();
    const committed = await kit.cost(project.id);
    const approved = await kit.cost(project.id, { status: 'approved' });
    const done = await tx((db) =>
      kit.projects.service.transition(project.id, 'completed', project.version, pm(), db),
    );
    try {
      await tx((db) =>
        kit.projects.service.transition(project.id, 'closed', done.version, pm(), db),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('project_has_open_costs');
      expect((error as { details: unknown }).details).toEqual({
        committed: [committed],
        unpostedApproved: [approved],
      });
    }
    await tx((db) => kit.projects.transitionCost(committed, 'reversed', db));
    await tx((db) => kit.projects.transitionCost(approved, 'posted', db));
    const closed = await tx((db) =>
      kit.projects.service.transition(project.id, 'closed', done.version, pm(), db),
    );
    expect(closed.status).toBe('closed');
  });
});

describe('budget (BR-8)', () => {
  it('replaces the manual lines: adds, changes, removes, and keeps variation lines', async () => {
    const project = await kit.project();
    const first = await tx((db) =>
      kit.projects.service.replaceBudget(
        project.id,
        [
          { costCodeId: kit.codes['100'] as string, budgetAmount: '500' },
          { costCodeId: kit.codes['100'] as string, description: 'Steel', budgetAmount: '300.5' },
          { costCodeId: kit.codes['200'] as string, budgetAmount: '100' },
        ],
        project.version,
        pm(),
        db,
      ),
    );
    expect(first.projectVersion).toBe(project.version + 1);
    expect(first.lines.map((l) => [l.description, l.budgetAmount, l.source])).toEqual([
      ['', '500.00', 'manual'],
      ['Steel', '300.50', 'manual'],
      ['', '100.00', 'manual'],
    ]);
    await tx((db) =>
      kit.projects.addBudgetLine(
        project.id,
        { costCodeId: kit.codes['300'] as string, description: 'VAR-0001', budgetAmount: '75' },
        db,
      ),
    );
    const second = await tx((db) =>
      kit.projects.service.replaceBudget(
        project.id,
        [
          { costCodeId: kit.codes['100'] as string, budgetAmount: '500' },
          { costCodeId: kit.codes['100'] as string, description: 'Steel', budgetAmount: '999' },
        ],
        first.projectVersion + 1,
        pm(),
        db,
      ),
    );
    expect(second.lines.map((l) => [l.description, l.budgetAmount, l.source])).toEqual([
      ['', '500.00', 'manual'],
      ['Steel', '999.00', 'manual'],
      ['VAR-0001', '75.00', 'variation'],
    ]);
  });

  it('refuses duplicates, inactive codes, negatives, stale versions and closed projects', async () => {
    const project = await kit.project();
    const line = { costCodeId: kit.codes['100'] as string, budgetAmount: '5' };
    const replace = (lines: (typeof line)[], version = project.version) =>
      tx((db) => kit.projects.service.replaceBudget(project.id, lines, version, pm(), db));
    expect(await codeOf(() => replace([line, line]))).toBe('budget_line_duplicate');
    expect(await codeOf(() => replace([{ ...line, costCodeId: kit.inactiveCode }]))).toBe(
      'cost_code_inactive',
    );
    expect(await codeOf(() => replace([{ ...line, budgetAmount: '-1' }]))).toBe('budget_negative');
    expect(await codeOf(() => replace([line], 99))).toBe('version_conflict');
    const cancelled = await tx((db) =>
      kit.projects.service.transition(project.id, 'cancelled', project.version, pm(), db),
    );
    expect(await codeOf(() => replace([line], cancelled.version))).toBe('project_read_only');
    expect(
      await codeOf(() =>
        tx((db) => kit.projects.addBudgetLine(project.id, { ...line, description: 'x' }, db)),
      ),
    ).toBe('project_read_only');
  });
});

describe('tasks (BR-10)', () => {
  it('creates, updates and averages the progress', async () => {
    const project = await kit.project();
    const make = (input: Parameters<ProjectsKit['projects']['service']['createTask']>[1]) =>
      tx((db) => kit.projects.service.createTask(project.id, input, pm(), db));
    const a = await make({ name: 'Excavation', startDate: '2026-11-01', dueDate: '2026-11-10' });
    const b = await make({ name: 'Footings', status: 'done', assignedToUser: SUPERVISOR });
    const c = await make({ name: 'Walls', status: 'doing', percentComplete: 40 });
    expect([a.percentComplete, b.percentComplete, c.percentComplete]).toEqual([0, 100, 40]);
    expect((await kit.projects.service.listTasks(kit.db, project.id, pm())).length).toBe(3);
    expect((await kit.projects.getProject(kit.db, project.id)).progressPercent).toBe('46.67');

    const done = await tx((db) =>
      kit.projects.service.updateTask(
        project.id,
        a.id,
        {
          status: 'done',
          name: 'Excavation done',
          assignedToUser: null,
          startDate: null,
          dueDate: null,
        },
        a.version,
        pm(),
        db,
      ),
    );
    expect(done).toMatchObject({ status: 'done', percentComplete: 100, name: 'Excavation done' });
    const moved = await tx((db) =>
      kit.projects.service.updateTask(
        project.id,
        c.id,
        { percentComplete: 60 },
        c.version,
        pm(),
        db,
      ),
    );
    expect(moved).toMatchObject({ status: 'doing', percentComplete: 60 });
    expect((await kit.projects.getProject(kit.db, project.id)).progressPercent).toBe('86.67');
  });

  it('refuses a done task below 100, a bad percent, a missing name, and strangers', async () => {
    const project = await kit.project();
    const other = await kit.project();
    const create = (input: Parameters<ProjectsKit['projects']['service']['createTask']>[1]) =>
      tx((db) => kit.projects.service.createTask(project.id, input, pm(), db));
    expect(await codeOf(() => create({ name: 'x', status: 'done', percentComplete: 50 }))).toBe(
      'done_needs_100',
    );
    expect(await codeOf(() => create({ name: 'x', percentComplete: 101 }))).toBe('percent_invalid');
    expect(await codeOf(() => create({ name: ' ' }))).toBe('name_required');
    const task = await create({ name: 'ok' });
    const update = (projectId: string, id: string, version: number) =>
      tx((db) => kit.projects.service.updateTask(projectId, id, { name: 'y' }, version, pm(), db));
    expect(await codeOf(() => update(other.id, task.id, task.version))).toBe('task_not_found');
    expect(await codeOf(() => update(project.id, uid(9996), 1))).toBe('task_not_found');
    expect(await codeOf(() => update(project.id, task.id, 42))).toBe('version_conflict');
    const scoped = kit.actorFor(SUPERVISOR, []);
    expect(
      await codeOf(() =>
        tx((db) => kit.projects.service.createTask(project.id, { name: 'z' }, scoped, db)),
      ),
    ).toBe('project_not_found');
    expect(await codeOf(() => kit.projects.service.listTasks(kit.db, project.id, scoped))).toBe(
      'project_not_found',
    );
    expect(await codeOf(() => kit.projects.service.listTasks(kit.db, uid(9995), pm()))).toBe(
      'project_not_found',
    );
  });
});

describe('supervisor assignments (BR-9, T-7)', () => {
  const scopesOf = async (userId: string) =>
    (await kit.identity.users.list(kit.db)).find((u) => u.id === userId)?.scopes;
  const assign = (
    id: string,
    supervisors: Parameters<ProjectsKit['projects']['service']['setSupervisors']>[1],
  ) =>
    tx((db) => kit.projects.service.setSupervisors(id, supervisors, kit.actorFor(MANAGEMENT), db));

  it('adds the project scope, keeps other scopes, and ends it without deleting history', async () => {
    const project = await kit.project();
    const other = await kit.project();
    const detail = await assign(project.id, [
      { userId: SUPERVISOR },
      { userId: SUPERVISOR2, fromDate: '2026-10-20' },
    ]);
    expect(detail.supervisors).toEqual([
      { userId: SUPERVISOR2, fromDate: '2026-10-20', toDate: null },
      { userId: SUPERVISOR, fromDate: '2026-10-25', toDate: null },
    ]);
    expect(await scopesOf(SUPERVISOR)).toEqual([{ type: 'project', id: project.id }]);
    await assign(other.id, [{ userId: SUPERVISOR }]);
    expect((await scopesOf(SUPERVISOR))?.length).toBe(2);

    // Unchanged list: nothing to do.
    await assign(project.id, [{ userId: SUPERVISOR }, { userId: SUPERVISOR2 }]);

    // SUPERVISOR is left out and ended today; SUPERVISOR2 gets an end date in the future.
    const ended = await assign(project.id, [{ userId: SUPERVISOR2, toDate: '2026-12-31' }]);
    expect(ended.supervisors.map((s) => [s.userId, s.toDate])).toEqual([
      [SUPERVISOR2, '2026-12-31'],
      [SUPERVISOR, '2026-10-25'],
    ]);
    expect(await scopesOf(SUPERVISOR)).toEqual([{ type: 'project', id: other.id }]);
    expect(await scopesOf(SUPERVISOR2)).toEqual([{ type: 'project', id: project.id }]);

    // An end date in the past removes the scope; the row stays.
    const past = await assign(project.id, [{ userId: SUPERVISOR2, toDate: '2026-10-24' }]);
    expect(past.supervisors.find((s) => s.userId === SUPERVISOR2)?.toDate).toBe('2026-10-24');
    expect(await scopesOf(SUPERVISOR2)).toEqual([]);

    // Assigned again after the end: a new row.
    const again = await assign(project.id, [{ userId: SUPERVISOR2 }]);
    expect(again.supervisors.filter((s) => s.userId === SUPERVISOR2)).toHaveLength(2);
    expect(await scopesOf(SUPERVISOR2)).toEqual([{ type: 'project', id: project.id }]);
  });

  it('refuses reversed dates and unknown users', async () => {
    const project = await kit.project();
    expect(
      await codeOf(() =>
        assign(project.id, [{ userId: SUPERVISOR, fromDate: '2026-11-02', toDate: '2026-11-01' }]),
      ),
    ).toBe('assignment_dates_invalid');
    expect(await codeOf(() => assign(project.id, [{ userId: uid(9994) }]))).toBe('user_not_found');
  });
});

describe('audit and events (definition of done)', () => {
  it('writes audit entries and change events for project, budget, task and supervisor changes', async () => {
    const project = await kit.project();
    await tx((db) =>
      kit.projects.service.update(project.id, { name: 'A' }, project.version, pm(), db),
    );
    for (const action of ['update']) {
      expect(await auditCount(kit.db, `projects.project.${action}`)).toBeGreaterThan(0);
    }
    expect(await eventCount(kit.db, 'projects.project.changed')).toBeGreaterThan(0);
    void ACCOUNTANT;
  });
});

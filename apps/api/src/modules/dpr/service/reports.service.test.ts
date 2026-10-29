import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  NOBODY,
  PM,
  PM2,
  SUPERVISOR,
  SUPERVISOR2,
  auditCount,
  createDprKit,
  eventCount,
  uid,
  type DprKit,
} from '../test-support.js';

let kit: DprKit;
beforeAll(async () => {
  kit = await createDprKit();
}, 120_000);
afterAll(() => kit.close());

const tx = <T>(run: (db: DprKit['db']) => Promise<T>) => kit.db.transaction(run);

const codeOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

const scoped = (projectId: string, userId = SUPERVISOR) =>
  kit.actorFor(userId, [{ type: 'project', id: projectId }]);

describe('creating a report (BR-1, BR-2, T-1)', () => {
  it('saves a draft with every field, writes an audit entry and an event', async () => {
    const project = await kit.project();
    const task = await kit.task(project.id, 'Slab', 20);
    const before = await auditCount(kit.db, 'dpr.report.create');
    const report = await kit.draft(
      project.id,
      {
        weather: 'rain',
        workDone: '  Shuttering of the slab done  ',
        manpowerManual: [{ trade: ' Carpenter ', count: 6 }],
        taskUpdates: [{ taskId: task.id, percentComplete: 40, note: ' on track ' }],
        materialNotes: [
          { description: ' Cement ', quantity: '12.5', unitCode: ' bag ' },
          { description: 'Sand' },
        ],
      },
      SUPERVISOR,
      [{ type: 'project', id: project.id }],
    );
    expect(report).toMatchObject({
      projectId: project.id,
      reportDate: '2026-10-24',
      authorId: SUPERVISOR,
      weather: 'rain',
      status: 'draft',
      workDone: 'Shuttering of the slab done',
      manpowerManual: [{ trade: 'Carpenter', count: 6 }],
      submittedAt: null,
      reviewedAt: null,
      photoCount: 0,
      version: 1,
    });
    expect(report.taskUpdates).toEqual([
      { taskId: task.id, percentComplete: 40, note: 'on track' },
    ]);
    expect(report.materialNotes).toEqual([
      { description: 'Cement', quantity: '12.5000', unitCode: 'bag' },
      { description: 'Sand', quantity: null, unitCode: null },
    ]);
    expect(await auditCount(kit.db, 'dpr.report.create')).toBe(before + 1);
    expect(await eventCount(kit.db, 'dpr.report.changed')).toBeGreaterThan(0);
    // The project task is untouched until the report is submitted.
    expect((await kit.projects.getTask(kit.db, project.id, task.id)).percentComplete).toBe(20);
  });

  it('uses defaults when only the project and the date are given', async () => {
    const project = await kit.project();
    const report = await tx((db) =>
      kit.dpr.reports.create(
        { projectId: project.id, reportDate: '2026-10-25' },
        scoped(project.id),
        db,
      ),
    );
    expect(report).toMatchObject({
      weather: 'clear',
      workDone: '',
      issues: '',
      safetyNotes: '',
      manpowerManual: [],
      taskUpdates: [],
      materialNotes: [],
    });
  });

  it('follows the backdating rule: no future date, none older than the allowance', async () => {
    const project = await kit.project();
    const create = (reportDate: string) => kit.draft(project.id, { reportDate });
    await kit.assign(project.id, SUPERVISOR);
    expect(await codeOf(() => create('2026-10-26'))).toBe('date_in_future');
    expect(await codeOf(() => create('2026-10-21'))).toBe('backdating_not_allowed');
    expect((await create('2026-10-22')).reportDate).toBe('2026-10-22');
    expect(await codeOf(() => create('2026-02-31'))).toBe('invalid_date');
  });

  it('allows one report per author per project per date', async () => {
    const project = await kit.project();
    await kit.draft(project.id);
    expect(await codeOf(() => kit.draft(project.id))).toBe('report_exists');
    expect((await kit.draft(project.id, { reportDate: '2026-10-23' })).reportDate).toBe(
      '2026-10-23',
    );
    const other = await tx((db) =>
      kit.dpr.reports.create(kit.input(project.id), kit.actorFor(PM), db),
    );
    expect(other.authorId).toBe(PM);
  });

  it('limits supervisors to assigned projects; office roles reach any active project', async () => {
    const project = await kit.project();
    const idle = await kit.project({}, false);
    const create = (id: string, actor = kit.actorFor(SUPERVISOR)) =>
      tx((db) => kit.dpr.reports.create(kit.input(id), actor, db));
    expect(await codeOf(() => create(project.id))).toBe('project_not_found');
    expect(await codeOf(() => create(uid(9999), kit.actorFor(PM)))).toBe('project_not_found');
    expect((await create(project.id, kit.actorFor(PM))).projectId).toBe(project.id);
    expect(await codeOf(() => create(idle.id, kit.actorFor(PM)))).toBe('project_not_active');
  });

  it('checks task updates, manpower and materials', async () => {
    const project = await kit.project();
    const other = await kit.project();
    const task = await kit.task(project.id, 'Walls', 50);
    const foreign = await kit.task(other.id, 'Other walls');
    const attempt = (over: Parameters<DprKit['draft']>[1]) => kit.draft(project.id, over);
    await kit.assign(project.id, SUPERVISOR);
    const update = (percentComplete: number, note?: string) => ({
      taskId: task.id,
      percentComplete,
      note,
    });
    expect(await codeOf(() => attempt({ taskUpdates: [update(60), update(70)] }))).toBe(
      'task_duplicate',
    );
    expect(
      await codeOf(() =>
        attempt({ taskUpdates: [{ taskId: foreign.id, percentComplete: 10, note: null }] }),
      ),
    ).toBe('task_not_found');
    expect(await codeOf(() => attempt({ taskUpdates: [update(40)] }))).toBe(
      'task_percent_decrease',
    );
    expect(await codeOf(() => attempt({ taskUpdates: [update(101)] }))).toBe(
      'task_percent_invalid',
    );
    expect(await codeOf(() => attempt({ manpowerManual: [{ trade: ' ', count: 1 }] }))).toBe(
      'manpower_invalid',
    );
    expect(await codeOf(() => attempt({ materialNotes: [{ description: ' ' }] }))).toBe(
      'material_description_required',
    );
    const lowered = await attempt({ taskUpdates: [update(40, 'Rework after rain')] });
    expect(lowered.taskUpdates[0]?.note).toBe('Rework after rain');
  });
});

describe('editing a draft (BR-5)', () => {
  it('changes every field and both lists, and records the change', async () => {
    const project = await kit.project();
    const task = await kit.task(project.id, 'Plaster');
    const report = await kit.draft(project.id);
    const actor = scoped(project.id);
    const updated = await tx((db) =>
      kit.dpr.reports.update(
        report.id,
        {
          weather: 'cloudy',
          workDone: ' Plastering of the east wall ',
          issues: ' Water shortage ',
          safetyNotes: ' Helmets checked ',
          manpowerManual: [{ trade: 'Plasterer', count: 3 }],
          taskUpdates: [{ taskId: task.id, percentComplete: 30 }],
          materialNotes: [{ description: 'Plaster mix', quantity: '5', unitCode: 'bag' }],
        },
        report.version,
        actor,
        db,
      ),
    );
    expect(updated).toMatchObject({
      weather: 'cloudy',
      workDone: 'Plastering of the east wall',
      issues: 'Water shortage',
      safetyNotes: 'Helmets checked',
      manpowerManual: [{ trade: 'Plasterer', count: 3 }],
      version: report.version + 1,
    });
    expect(updated.taskUpdates).toHaveLength(1);
    expect(updated.materialNotes).toHaveLength(1);
    expect(await auditCount(kit.db, 'dpr.report.update')).toBeGreaterThan(0);
    // An empty patch keeps everything and still counts as a new version.
    const same = await tx((db) =>
      kit.dpr.reports.update(report.id, {}, updated.version, actor, db),
    );
    expect(same).toMatchObject({ workDone: 'Plastering of the east wall', version: 3 });
    expect(same.taskUpdates).toHaveLength(1);
  });

  it('refuses other people, stale versions, missing reports and read-only reports', async () => {
    const project = await kit.project();
    const report = await kit.draft(project.id);
    const edit = (id: string, version: number, actor = scoped(project.id)) =>
      tx((db) => kit.dpr.reports.update(id, { issues: 'x' }, version, actor, db));
    expect(await codeOf(() => edit(report.id, report.version, kit.actorFor(PM)))).toBe(
      'not_your_report',
    );
    expect(
      await codeOf(() => edit(report.id, report.version, scoped(uid(7777), SUPERVISOR2))),
    ).toBe('report_not_found');
    expect(await codeOf(() => edit(report.id, 99))).toBe('version_conflict');
    expect(await codeOf(() => edit(uid(8888), 1))).toBe('report_not_found');
    const filed = await kit.submitted(project.id, { reportDate: '2026-10-23' });
    expect(await codeOf(() => edit(filed.id, filed.version))).toBe('report_read_only');
  });
});

describe('submitting (BR-3, BR-4, T-2, T-4)', () => {
  it('moves the task percents on the project and records the submission', async () => {
    const project = await kit.project();
    const slab = await kit.task(project.id, 'Slab', 20);
    const wall = await kit.task(project.id, 'Wall', 90);
    const report = await kit.submitted(project.id, {
      taskUpdates: [
        { taskId: slab.id, percentComplete: 60 },
        { taskId: wall.id, percentComplete: 100, note: null },
      ],
    });
    expect(report).toMatchObject({ status: 'submitted', photoCount: 1 });
    expect(report.submittedAt).toBe('2026-10-25T10:00:00.000Z');
    const tasks = await kit.projects.service.listTasks(kit.db, project.id, kit.actorFor(PM));
    expect(tasks.map((t) => [t.name, t.percentComplete, t.status])).toEqual([
      ['Slab', 60, 'doing'],
      ['Wall', 100, 'done'],
    ]);
    expect(await eventCount(kit.db, 'dpr.submitted')).toBeGreaterThan(0);
    expect(await auditCount(kit.db, 'dpr.report.submit')).toBeGreaterThan(0);
  });

  it('needs ten characters of work done and, by default, a photo', async () => {
    const project = await kit.project();
    const actor = scoped(project.id);
    const submit = (id: string, version: number) =>
      tx((db) => kit.dpr.reports.submit(id, version, actor, db));
    const short = await kit.draft(project.id, { workDone: 'Too short' });
    expect(await codeOf(() => submit(short.id, short.version))).toBe('work_done_short');
    const bare = await kit.draft(project.id, { reportDate: '2026-10-23' });
    expect(await codeOf(() => submit(bare.id, bare.version))).toBe('photo_required');
    await kit.setSetting('dpr_photo_required', false);
    expect((await submit(bare.id, bare.version)).status).toBe('submitted');
    await kit.setSetting('dpr_photo_required', true);
  });

  it('refuses a percent that fell below the task since the report was saved', async () => {
    const project = await kit.project();
    const task = await kit.task(project.id, 'Floor', 10);
    const actor = scoped(project.id);
    const report = await kit.draft(project.id, {
      taskUpdates: [{ taskId: task.id, percentComplete: 20 }],
    });
    await kit.photo(report.id, SUPERVISOR, actor.scopes);
    await tx((db) =>
      kit.projects.updateTaskProgress(project.id, task.id, 70, { userId: PM, requestId: null }, db),
    );
    expect(
      await codeOf(() => tx((db) => kit.dpr.reports.submit(report.id, report.version, actor, db))),
    ).toBe('task_percent_decrease');
  });

  it('is the author only, once, with the current version', async () => {
    const project = await kit.project();
    const actor = scoped(project.id);
    const report = await kit.draft(project.id);
    await kit.photo(report.id, SUPERVISOR, actor.scopes);
    const submit = (version: number, who = actor) =>
      tx((db) => kit.dpr.reports.submit(report.id, version, who, db));
    expect(await codeOf(() => submit(report.version, kit.actorFor(PM)))).toBe('not_your_report');
    expect(await codeOf(() => submit(99))).toBe('version_conflict');
    await submit(report.version);
    expect(await codeOf(() => submit(report.version + 1))).toBe('report_transition');
  });
});

describe('review and reopen (BR-5, T-3)', () => {
  it('lets the manager review a submitted report; a reviewed report is final', async () => {
    const project = await kit.project();
    const report = await kit.submitted(project.id);
    const manager = kit.actorFor(PM);
    const reviewed = await tx((db) =>
      kit.dpr.reports.review(report.id, ' Looks good ', report.version, manager, db),
    );
    expect(reviewed).toMatchObject({
      status: 'reviewed',
      reviewedBy: PM,
      reviewNote: 'Looks good',
      reviewedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(await eventCount(kit.db, 'dpr.reviewed')).toBeGreaterThan(0);
    expect(await auditCount(kit.db, 'dpr.report.reviewed')).toBeGreaterThan(0);
    const again = (run: (version: number) => Promise<unknown>) =>
      codeOf(() => run(reviewed.version));
    expect(
      await again((v) => tx((db) => kit.dpr.reports.review(report.id, undefined, v, manager, db))),
    ).toBe('report_transition');
    expect(
      await again((v) => tx((db) => kit.dpr.reports.reopen(report.id, undefined, v, manager, db))),
    ).toBe('report_transition');
  });

  it('walks the reopen cycle: reopen, correct, submit again, review', async () => {
    const project = await kit.project();
    const actor = scoped(project.id);
    const manager = kit.actorFor(PM);
    const report = await kit.submitted(project.id);
    const reopened = await tx((db) =>
      kit.dpr.reports.reopen(report.id, 'Add the slab photo', report.version, manager, db),
    );
    expect(reopened).toMatchObject({ status: 'reopened', reviewNote: 'Add the slab photo' });
    const fixed = await tx((db) =>
      kit.dpr.reports.update(reopened.id, { issues: 'None' }, reopened.version, actor, db),
    );
    const resubmitted = await tx((db) =>
      kit.dpr.reports.submit(fixed.id, fixed.version, actor, db),
    );
    expect(resubmitted.status).toBe('submitted');
    const done = await tx((db) =>
      kit.dpr.reports.review(resubmitted.id, undefined, resubmitted.version, manager, db),
    );
    expect(done).toMatchObject({ status: 'reviewed', reviewNote: null });
    expect(await auditCount(kit.db, 'dpr.report.reopened')).toBeGreaterThan(0);
  });

  it('refuses a draft, a stale version and someone who cannot see the project', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, { reportDate: '2026-10-22' });
    const manager = kit.actorFor(PM);
    const review = (id: string, version: number, who = manager) =>
      tx((db) => kit.dpr.reports.review(id, undefined, version, who, db));
    expect(await codeOf(() => review(draft.id, draft.version))).toBe('report_transition');
    const filed = await kit.submitted(project.id);
    expect(await codeOf(() => review(filed.id, 99))).toBe('version_conflict');
    expect(
      await codeOf(() => review(filed.id, filed.version, scoped(uid(7777), SUPERVISOR2))),
    ).toBe('report_not_found');
  });
});

describe('reading and listing (BR-2, T-1)', () => {
  it('shows a supervisor only the projects assigned to them', async () => {
    const mine = await kit.project();
    const theirs = await kit.project();
    const own = await kit.submitted(mine.id);
    const foreign = await kit.submitted(theirs.id, {}, SUPERVISOR2);
    const actor = scoped(mine.id);
    expect((await kit.dpr.getDpr(kit.db, own.id, actor)).id).toBe(own.id);
    expect(await codeOf(() => kit.dpr.getDpr(kit.db, foreign.id, actor))).toBe('report_not_found');
    expect(await codeOf(() => kit.dpr.getDpr(kit.db, uid(8888), actor))).toBe('report_not_found');
    expect(await codeOf(() => kit.dpr.getDpr(kit.db, own.id, kit.actorFor(NOBODY)))).toBe(
      'report_not_found',
    );
    expect((await kit.dpr.getDpr(kit.db, foreign.id, kit.actorFor(ACCOUNTANT))).id).toBe(
      foreign.id,
    );

    const page = { limit: 50, offset: 0 };
    const seen = await kit.dpr.listDprs(kit.db, page, actor);
    expect(seen.items.map((r) => r.projectId)).toEqual(Array(seen.items.length).fill(mine.id));
    const all = await kit.dpr.listDprs(kit.db, page, kit.actorFor(PM));
    expect(all.items.map((r) => r.id)).toEqual(expect.arrayContaining([own.id, foreign.id]));
    expect(all.total).toBe(all.items.length);
    // Asking a supervisor for a project outside the scope finds nothing.
    expect(
      (await kit.dpr.listDprs(kit.db, { ...page, projectId: theirs.id }, actor)).items,
    ).toEqual([]);
  });

  it('filters by project, dates, status and author, newest first, and pages', async () => {
    const project = await kit.project();
    const older = await kit.submitted(project.id, { reportDate: '2026-10-22' });
    const newer = await kit.draft(project.id, { reportDate: '2026-10-24' });
    const manager = kit.actorFor(PM);
    const page = { projectId: project.id, limit: 50, offset: 0 };
    const list = (over: object) => kit.dpr.listDprs(kit.db, { ...page, ...over }, manager);
    expect((await list({})).items.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect((await list({ from: '2026-10-23' })).items.map((r) => r.id)).toEqual([newer.id]);
    expect((await list({ to: '2026-10-23' })).items.map((r) => r.id)).toEqual([older.id]);
    expect((await list({ status: 'submitted' })).items.map((r) => r.id)).toEqual([older.id]);
    expect((await list({ mine: true })).items).toEqual([]);
    expect((await list({ mine: false })).items).toHaveLength(2);
    const second = await list({ limit: 1, offset: 1 });
    expect(second).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(second.items.map((r) => r.id)).toEqual([older.id]);
    const mineOnly = await kit.dpr.listDprs(kit.db, { ...page, mine: true }, scoped(project.id));
    expect(mineOnly.total).toBe(2);
  });
});

describe('photo access (BR-5, BR-7, T-6)', () => {
  it('lets the author add and remove photos of an editable report, and readers read them', async () => {
    const project = await kit.project();
    const actor = scoped(project.id);
    const report = await kit.draft(project.id);
    const photoId = await kit.photo(report.id, SUPERVISOR, actor.scopes);
    expect((await kit.files.list(kit.db, kit.actorFor(PM), 'dpr_report', report.id)).length).toBe(
      1,
    );
    expect(
      await codeOf(() => kit.files.list(kit.db, kit.actorFor(NOBODY), 'dpr_report', report.id)),
    ).toBeDefined();
    // The manager is not the author, so cannot add or remove photos.
    expect(await codeOf(() => kit.photo(report.id, PM2))).toBeDefined();
    expect(
      await codeOf(() => tx((db) => kit.files.remove(photoId, kit.actorFor(PM), db))),
    ).toBeDefined();
    await tx((db) => kit.files.remove(photoId, actor, db));
    expect(await kit.files.list(kit.db, actor, 'dpr_report', report.id)).toEqual([]);
  });

  it('refuses photos on a submitted report and on a report that does not exist', async () => {
    const project = await kit.project();
    const filed = await kit.submitted(project.id);
    expect(
      await codeOf(() => kit.photo(filed.id, SUPERVISOR, scoped(project.id).scopes)),
    ).toBeDefined();
    expect(await codeOf(() => kit.photo(uid(8888)))).toBeDefined();
  });

  it('accepts at most twenty photos', async () => {
    const project = await kit.project();
    const scopes = scoped(project.id).scopes;
    const report = await kit.draft(project.id);
    for (let i = 0; i < 20; i += 1) await kit.photo(report.id, SUPERVISOR, scopes);
    expect(await codeOf(() => kit.photo(report.id, SUPERVISOR, scopes))).toBe('photo_limit');
    expect((await kit.dpr.getDpr(kit.db, report.id, scoped(project.id))).photoCount).toBe(20);
  });
});

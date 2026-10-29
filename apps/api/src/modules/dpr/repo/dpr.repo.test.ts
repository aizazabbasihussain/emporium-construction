import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PM, SUPERVISOR, createDprKit, uid, type DprKit } from '../test-support.js';
import {
  claimMissingRun,
  findReport,
  findReportOfAuthorDay,
  insertReport,
  listFiledProjectIds,
  listMaterialNotes,
  listTaskUpdates,
  replaceMaterialNotes,
  replaceTaskUpdates,
  searchReports,
  updateReport,
} from './dpr.repo.js';

let kit: DprKit;
beforeAll(async () => {
  kit = await createDprKit();
}, 60_000);
afterAll(() => kit.close());

const AT = new Date('2026-10-25T10:00:00Z');
let n = 100;
const newReport = (over: Record<string, unknown> = {}) =>
  insertReport(
    kit.db,
    {
      id: uid(n++),
      project_id: uid(1),
      report_date: '2026-10-24',
      author_id: SUPERVISOR,
      work_done: 'Poured the slab',
      manpower_manual: JSON.stringify([{ trade: 'Mason', count: 2 }]),
      ...over,
    },
    SUPERVISOR,
    AT,
  );

describe('dpr repository', () => {
  it('inserts, finds, locks and updates a report with optimistic versions', async () => {
    const row = await newReport();
    expect(row).toMatchObject({
      report_date: '2026-10-24',
      weather: 'clear',
      status: 'draft',
      manpower_manual: [{ trade: 'Mason', count: 2 }],
      submitted_at: null,
      version: 1,
    });
    expect(await findReport(kit.db, row.id)).toEqual(row);
    expect(await findReport(kit.db, row.id, true)).toEqual(row);
    expect(await findReport(kit.db, uid(99999))).toBeUndefined();
    const next = await updateReport(
      kit.db,
      row.id,
      1,
      { status: 'submitted', submitted_at: AT.toISOString() },
      PM,
      AT,
    );
    expect(next).toMatchObject({ status: 'submitted', version: 2 });
    expect(next?.submitted_at?.toISOString()).toBe(AT.toISOString());
    expect(await updateReport(kit.db, row.id, 1, { issues: 'x' }, PM, AT)).toBeUndefined();
  });

  it('finds the report of an author for a project and date', async () => {
    const project = uid(2);
    const row = await newReport({ project_id: project });
    expect((await findReportOfAuthorDay(kit.db, project, '2026-10-24', SUPERVISOR))?.id).toBe(
      row.id,
    );
    expect(await findReportOfAuthorDay(kit.db, project, '2026-10-23', SUPERVISOR)).toBeUndefined();
    expect(await findReportOfAuthorDay(kit.db, project, '2026-10-24', PM)).toBeUndefined();
  });

  it('refuses a second live report for the same author, project and date', async () => {
    const project = uid(3);
    await newReport({ project_id: project });
    await expect(newReport({ project_id: project })).rejects.toThrow();
  });

  it('searches with every filter and pages newest first', async () => {
    const project = uid(4);
    const other = uid(5);
    const a = await newReport({ project_id: project, report_date: '2026-10-20' });
    const b = await newReport({
      project_id: project,
      report_date: '2026-10-22',
      author_id: PM,
      status: 'submitted',
    });
    const c = await newReport({ project_id: other, report_date: '2026-10-23' });
    const ids = async (over: object) =>
      (await searchReports(kit.db, { limit: 50, offset: 0, ...over })).rows.map((r) => r.id);
    expect(await ids({ projectId: project })).toEqual([b.id, a.id]);
    expect(await ids({ projectIds: [project, other] })).toEqual([c.id, b.id, a.id]);
    expect(await ids({ projectIds: [] })).toEqual([]);
    expect(await ids({ projectId: project, from: '2026-10-21' })).toEqual([b.id]);
    expect(await ids({ projectId: project, to: '2026-10-21' })).toEqual([a.id]);
    expect(await ids({ projectId: project, status: 'submitted' })).toEqual([b.id]);
    expect(await ids({ projectId: project, authorId: PM })).toEqual([b.id]);
    const page = await searchReports(kit.db, { projectId: project, limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.id)).toEqual([a.id]);
  });

  it('replaces the task updates and the material notes as whole lists', async () => {
    const row = await newReport({ project_id: uid(6) });
    await replaceTaskUpdates(kit.db, row.id, [
      { taskId: uid(11), percentComplete: 30, note: null },
      { taskId: uid(12), percentComplete: 60, note: 'ahead' },
    ]);
    expect(await listTaskUpdates(kit.db, row.id)).toEqual([
      { task_id: uid(11), percent_complete: 30, note: null },
      { task_id: uid(12), percent_complete: 60, note: 'ahead' },
    ]);
    await replaceTaskUpdates(kit.db, row.id, [
      { taskId: uid(11), percentComplete: 35, note: null },
    ]);
    expect(await listTaskUpdates(kit.db, row.id)).toHaveLength(1);

    await replaceMaterialNotes(kit.db, row.id, [
      { id: uid(21), description: 'Cement', quantity: '10', unitCode: 'bag' },
      { id: uid(22), description: 'Sand', quantity: null, unitCode: null },
    ]);
    expect(await listMaterialNotes(kit.db, row.id)).toEqual([
      { description: 'Cement', quantity: '10.0000', unit_code: 'bag' },
      { description: 'Sand', quantity: null, unit_code: null },
    ]);
    await replaceMaterialNotes(kit.db, row.id, []);
    expect(await listMaterialNotes(kit.db, row.id)).toEqual([]);
  });

  it('lists the projects with a filed report in the submission status view', async () => {
    const filed = uid(7);
    const draft = uid(8);
    await newReport({ project_id: filed, report_date: '2026-09-01', status: 'reviewed' });
    await newReport({ project_id: draft, report_date: '2026-09-01' });
    expect(await listFiledProjectIds(kit.db, '2026-09-01')).toEqual([filed]);
    expect(await listFiledProjectIds(kit.db, '2026-09-02')).toEqual([]);
  });

  it('claims the missing-report run of a day once', async () => {
    expect(await claimMissingRun(kit.db, '2026-09-10', 3)).toBe(true);
    expect(await claimMissingRun(kit.db, '2026-09-10', 5)).toBe(false);
    const rows = await kit.db.query<{ missing_count: number }>(
      `select missing_count from dpr_missing_runs where report_date = '2026-09-10'`,
    );
    expect(rows).toEqual([{ missing_count: 3 }]);
  });
});

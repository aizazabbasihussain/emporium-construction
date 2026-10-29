import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOBODY,
  PM,
  PM2,
  SUPERVISOR,
  SUPERVISOR2,
  createDprKit,
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

const DAY = '2026-10-25';
// 18:00 Asia/Karachi is 13:00 UTC.
const AT_DEADLINE = new Date('2026-10-25T13:00:00Z');

const ids = (rows: { projectId: string }[]) => rows.map((r) => r.projectId).sort();
const projectIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

const inbox = async (userId: string) =>
  (await kit.notifications.service.list(kit.db, userId)).items.filter(
    (n) => n.template === 'dpr.missing',
  );

describe('missing reports (BR-6, T-5)', () => {
  it('lists supervised active projects without a filed report for the date', async () => {
    const filed = await kit.project();
    const waiting = await kit.project();
    const drafted = await kit.project();
    const reopened = await kit.project();
    const unsupervised = await kit.project();
    for (const project of [filed, waiting, drafted, reopened]) {
      await kit.assign(project.id, SUPERVISOR);
    }
    await kit.assign(waiting.id, SUPERVISOR2);
    await kit.submitted(filed.id, { reportDate: DAY });
    await kit.draft(drafted.id, { reportDate: DAY });
    const back = await kit.submitted(reopened.id, { reportDate: DAY });
    await tx((db) => kit.dpr.reports.reopen(back.id, 'Fix', back.version, kit.actorFor(PM), db));

    const missing = await kit.dpr.getMissingDprs(kit.db, DAY);
    expect(ids(missing)).toEqual(projectIds([waiting, drafted, reopened]));
    expect(missing.find((m) => m.projectId === waiting.id)).toMatchObject({
      code: waiting.code,
      date: DAY,
      projectManagerId: PM,
      supervisorIds: [SUPERVISOR, SUPERVISOR2].sort(),
    });
    expect(ids(missing)).not.toContain(unsupervised.id);
    expect(ids(missing)).not.toContain(filed.id);
    // Another day has no reports at all; before the assignments began nobody was expected to report.
    expect(await kit.dpr.getMissingDprs(kit.db, '2026-10-24')).toEqual([]);
    expect(ids(await kit.dpr.getMissingDprs(kit.db, '2026-10-26'))).toEqual(
      projectIds([filed, waiting, drafted, reopened]),
    );
    expect(await codeOf(() => kit.dpr.getMissingDprs(kit.db, '2026-13-40'))).toBe('invalid_date');
  });
});

describe('the 18:00 job (BR-6, T-5)', () => {
  it('does nothing before 18:00 Karachi', async () => {
    const before = await tx((db) =>
      kit.dpr.notifyMissingDprs(db, new Date('2026-10-25T12:59:00Z')),
    );
    expect(before).toBe(0);
    const runs = await kit.db.query('select 1 from dpr_missing_runs');
    expect(runs).toEqual([]);
  });

  it('tells each project manager once, and the project managers when a project has none', async () => {
    const owned = await kit.project();
    const other = await kit.project({ projectManagerId: PM2 });
    const unmanaged = await kit.project({ projectManagerId: null });
    for (const project of [owned, other, unmanaged]) await kit.assign(project.id, SUPERVISOR);

    kit.now.current = AT_DEADLINE;
    const count = await tx((db) => kit.dpr.notifyMissingDprs(db, AT_DEADLINE));
    expect(count).toBeGreaterThanOrEqual(3);

    const first = await inbox(PM);
    const second = await inbox(PM2);
    // PM manages the earlier projects and also hears about the unmanaged one (role broadcast).
    expect(first).toHaveLength(2);
    expect(JSON.stringify(first)).toContain(owned.code);
    expect(JSON.stringify(first)).toContain(unmanaged.code);
    expect(second).toHaveLength(2);
    expect(JSON.stringify(second)).toContain(other.code);
    expect((first[0]?.data as { date: string }).date).toBe(DAY);

    // A later tick the same evening sends nothing more.
    const again = await tx((db) => kit.dpr.notifyMissingDprs(db, new Date('2026-10-25T14:30:00Z')));
    expect(again).toBe(0);
    expect(await inbox(PM)).toHaveLength(2);
    const runs = await kit.db.query<{ report_date: string }>(
      `select to_char(report_date, 'YYYY-MM-DD') as report_date from dpr_missing_runs`,
    );
    expect(runs).toEqual([{ report_date: DAY }]);
  });

  it('stays quiet on a site holiday and on a day when every report is in', async () => {
    const nextDay = new Date('2026-10-26T13:00:00Z');
    await kit.setSetting('site_holidays', ' 2026-10-26 ,2026-10-30');
    expect(await tx((db) => kit.dpr.notifyMissingDprs(db, nextDay))).toBe(0);
    expect(await inbox(PM)).toHaveLength(2);
    const holiday = await kit.db.query<{ missing_count: number }>(
      `select missing_count from dpr_missing_runs where report_date = '2026-10-26'`,
    );
    expect(holiday).toEqual([{ missing_count: 0 }]);

    // On a working day with nothing missing the job records the run and notifies nobody.
    const quiet = await createDprKit();
    try {
      const project = await quiet.project();
      await quiet.assign(project.id, SUPERVISOR);
      await quiet.submitted(project.id, { reportDate: '2026-10-25' });
      const sent = await quiet.db.transaction((db) => quiet.dpr.notifyMissingDprs(db, AT_DEADLINE));
      expect(sent).toBe(0);
      const rows = await quiet.db.query('select 1 from dpr_missing_runs');
      expect(rows).toHaveLength(1);
      expect(await quiet.notifications.service.list(quiet.db, NOBODY)).toMatchObject({ items: [] });
    } finally {
      await quiet.close();
    }
  });
});

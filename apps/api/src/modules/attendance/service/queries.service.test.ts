import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNTANT,
  FRIDAY,
  MANAGEMENT,
  SUPERVISOR,
  SUPERVISOR2,
  THURSDAY,
  createAttendanceKit,
  type AttendanceKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: AttendanceKit;
beforeAll(async () => {
  kit = await createAttendanceKit();
}, 120_000);
afterAll(() => kit.close());

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

const present = (workerId: string, projectId: string, over = {}) => ({
  workerId,
  status: 'present' as const,
  allocations: [{ projectId, fraction: '1' }],
  ...over,
});

describe('getApprovedAttendance (module interface for wages)', () => {
  it('returns the approved days of a worker with their allocations and nothing else', async () => {
    const setup = await kit.setup();
    await kit.approved(setup, FRIDAY, {
      entries: [
        {
          workerId: setup.workerA.id,
          status: 'half_day' as const,
          overtimeHours: '2',
          allocations: [
            { projectId: setup.projectA, fraction: '0.25' },
            { projectId: setup.projectB, fraction: '0.75' },
          ],
        },
        present(setup.workerB.id, setup.projectA),
      ],
    });
    // A draft sheet of another day is not attendance yet.
    await kit.save(setup, THURSDAY, kit.body(setup));
    const days = await kit.attendance.getApprovedAttendance(
      kit.db,
      setup.workerA.id,
      '2026-10-01',
      '2026-10-31',
    );
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      teamId: setup.teamId,
      date: FRIDAY,
      workerId: setup.workerA.id,
      status: 'half_day',
      overtimeHours: '2.00',
      dayValue: '500.00',
      overtimeValue: '375.00',
    });
    // 500 split 125 / 375, overtime (375) joins the first allocation.
    expect(days[0]?.allocations).toEqual([
      { projectId: setup.projectA, fraction: '0.2500', amount: '500.00' },
      { projectId: setup.projectB, fraction: '0.7500', amount: '375.00' },
    ]);
    expect(
      await kit.attendance.getApprovedAttendance(
        kit.db,
        setup.workerA.id,
        '2026-09-01',
        '2026-09-30',
      ),
    ).toEqual([]);
    expect(
      await codeOf(
        kit.attendance.getApprovedAttendance(kit.db, setup.workerA.id, 'x', '2026-09-30'),
      ),
    ).toBe('invalid_date');
  });
});

describe('getAttendanceHeadcount (module interface for daily reports)', () => {
  it('counts workers present or on a half day on submitted and approved sheets', async () => {
    const setup = await kit.setup();
    const third = await kit.worker();
    const fourth = await kit.worker();
    await kit.members(setup.teamId, [setup.workerA.id, setup.workerB.id, third.id, fourth.id]);
    const saved = await kit.save(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA),
        present(setup.workerB.id, setup.projectA, { status: 'half_day' }),
        present(third.id, setup.projectB),
        { workerId: fourth.id, status: 'absent' as const },
      ],
    });
    const count = (projectId: string, date = FRIDAY) =>
      kit.attendance.getAttendanceHeadcount(kit.db, projectId, date);
    // A draft is not counted yet.
    expect(await count(setup.projectA)).toBe(0);
    await kit.submit(saved.id);
    expect(await count(setup.projectA)).toBe(2);
    expect(await count(setup.projectB)).toBe(1);
    await kit.decide(saved.id, 'approve');
    expect(await count(setup.projectA)).toBe(2);
    expect(await count(setup.projectA, THURSDAY)).toBe(0);
    expect(await codeOf(count(setup.projectA, 'later'))).toBe('invalid_date');
  });
});

describe('listUnapprovedSheets (used by workforce before a worker leaves)', () => {
  it('lists the sheets the worker is on that are not approved, up to the date', async () => {
    const setup = await kit.setup();
    const draft = await kit.save(setup, THURSDAY, kit.body(setup));
    const list = (upTo: string) =>
      kit.attendance.listUnapprovedSheets(kit.db, setup.workerA.id, upTo);
    expect(await list(FRIDAY)).toEqual([{ id: draft.id, date: THURSDAY }]);
    expect(await list('2026-10-21')).toEqual([]);
    await kit.submit(draft.id);
    expect(await list(FRIDAY)).toHaveLength(1);
    await kit.decide(draft.id, 'approve');
    expect(await list(FRIDAY)).toEqual([]);
    expect(await codeOf(list('later'))).toBe('invalid_date');
  });

  it('is what blocks a worker with unapproved attendance from being deactivated', async () => {
    const setup = await kit.setup();
    await kit.save(setup, FRIDAY, kit.body(setup));
    const actor = await kit.actorFor(MANAGEMENT);
    const worker = await kit.workforce.getWorker(kit.db, setup.workerA.id, actor);
    const run = kit.db.transaction((tx) =>
      kit.workforce.workers.deactivate(
        setup.workerA.id,
        { leftOn: FRIDAY },
        worker.version,
        actor,
        tx,
      ),
    );
    expect(await codeOf(run)).toBe('unapproved_attendance');
  });
});

describe('getLabourSummary and getHeadcountSeries (P1-19 BR-4)', () => {
  const unknownProject = '00000000-0000-0000-0000-000000000000';

  it('sums worker-days and cost per project and month from approved sheets only', async () => {
    const setup = await kit.setup();
    // Approved Friday: A is half a day with 2 hours overtime split 25 / 75, B is a full day.
    await kit.approved(setup, FRIDAY, {
      entries: [
        {
          workerId: setup.workerA.id,
          status: 'half_day' as const,
          overtimeHours: '2',
          allocations: [
            { projectId: setup.projectA, fraction: '0.25' },
            { projectId: setup.projectB, fraction: '0.75' },
          ],
        },
        present(setup.workerB.id, setup.projectA),
      ],
    });
    // A draft sheet is not approved attendance.
    await kit.save(setup, THURSDAY, kit.body(setup));

    const all = await kit.attendance.getLabourSummary(kit.db, '2026-10-01', '2026-10-31');
    expect(all).toContainEqual({
      projectId: setup.projectA,
      month: '2026-10',
      workerDays: '1.1250',
      cost: '1500.00',
    });
    expect(all).toContainEqual({
      projectId: setup.projectB,
      month: '2026-10',
      workerDays: '0.3750',
      cost: '375.00',
    });
    expect(
      await kit.attendance.getLabourSummary(kit.db, '2026-10-01', '2026-10-31', setup.projectB),
    ).toEqual([
      { projectId: setup.projectB, month: '2026-10', workerDays: '0.3750', cost: '375.00' },
    ]);
    expect(
      await kit.attendance.getLabourSummary(kit.db, '2026-09-01', '2026-09-30', setup.projectB),
    ).toEqual([]);
  });

  it('counts overtime with its own project as cost there, with no worker-days', async () => {
    const setup = await kit.setup();
    await kit.approved(setup, FRIDAY, {
      entries: [
        {
          workerId: setup.workerA.id,
          status: 'present' as const,
          overtimeHours: '2',
          overtimeProjectId: setup.projectB,
          allocations: [{ projectId: setup.projectA, fraction: '1' }],
        },
      ],
    });
    const rows = await kit.attendance.getLabourSummary(kit.db, FRIDAY, FRIDAY);
    expect(rows.filter((r) => r.projectId === setup.projectA)).toEqual([
      { projectId: setup.projectA, month: '2026-10', workerDays: '1.0000', cost: '1000.00' },
    ]);
    expect(rows.filter((r) => r.projectId === setup.projectB)).toEqual([
      { projectId: setup.projectB, month: '2026-10', workerDays: '0.0000', cost: '375.00' },
    ]);
  });

  it('refuses a bad or oversized period', async () => {
    expect(await codeOf(kit.attendance.getLabourSummary(kit.db, 'x', FRIDAY))).toBe('invalid_date');
    expect(await codeOf(kit.attendance.getLabourSummary(kit.db, FRIDAY, THURSDAY))).toBe(
      'period_invalid',
    );
    expect(await codeOf(kit.attendance.getLabourSummary(kit.db, '2025-01-01', FRIDAY))).toBe(
      'period_too_long',
    );
    expect(
      await codeOf(kit.attendance.getHeadcountSeries(kit.db, unknownProject, FRIDAY, THURSDAY)),
    ).toBe('period_invalid');
  });

  it('lists the headcount of each approved day, leaving out days without attendance', async () => {
    const setup = await kit.setup();
    const third = await kit.worker();
    await kit.members(setup.teamId, [setup.workerA.id, setup.workerB.id, third.id]);
    await kit.approved(setup, FRIDAY, {
      entries: [
        present(setup.workerA.id, setup.projectA),
        present(setup.workerB.id, setup.projectA, { status: 'half_day' }),
        { workerId: third.id, status: 'absent' as const },
      ],
    });
    // Submitted but not approved: not part of the series.
    const pending = await kit.save(setup, THURSDAY, kit.body(setup));
    await kit.submit(pending.id);
    expect(
      await kit.attendance.getHeadcountSeries(kit.db, setup.projectA, THURSDAY, FRIDAY),
    ).toEqual([{ date: FRIDAY, headcount: 2 }]);
    expect(
      await kit.attendance.getHeadcountSeries(kit.db, setup.projectB, THURSDAY, FRIDAY),
    ).toEqual([]);
  });
});

describe('missing and unapproved sheets (BR-9, T-6)', () => {
  it('reports weekdays without a sheet, skipping weekends, holidays and teams without members', async () => {
    const setup = await kit.setup();
    // Monday 19 to Sunday 25 October 2026. Tuesday 20 is a site holiday.
    await kit.setSetting('site_holidays', '2026-10-20');
    try {
      const approvedSheet = await kit.save(setup, THURSDAY, kit.body(setup));
      await kit.submit(approvedSheet.id);
      await kit.decide(approvedSheet.id, 'approve');
      await kit.save(setup, FRIDAY, kit.body(setup));

      // A team that only starts on Thursday is expected from then on; an empty team never.
      const late = await kit.team(SUPERVISOR2);
      const lateWorker = await kit.worker();
      await kit.members(late.id, [lateWorker.id], THURSDAY);
      const empty = await kit.team(SUPERVISOR2);
      // A team that was switched off is not expected at all.
      const retired = await kit.team(SUPERVISOR2);
      const retiredWorker = await kit.worker();
      await kit.members(retired.id, [retiredWorker.id]);
      const actor = await kit.actorFor(MANAGEMENT);
      const retiredTeam = await kit.workforce.getTeam(kit.db, retired.id, actor);
      await kit.db.transaction((tx) =>
        kit.workforce.teams.update(retired.id, { active: false }, retiredTeam.version, actor, tx),
      );

      const result = await kit.attendance.getUnapprovedSheets(kit.db, {
        from: '2026-10-19',
        to: '2026-10-25',
      });
      const missingOf = (teamId: string) =>
        result.missing.filter((m) => m.teamId === teamId).map((m) => m.date);
      expect(missingOf(setup.teamId)).toEqual(['2026-10-19', '2026-10-21']);
      expect(missingOf(late.id)).toEqual([THURSDAY, FRIDAY]);
      expect(missingOf(empty.id)).toEqual([]);
      expect(missingOf(retired.id)).toEqual([]);
      expect(
        result.sheets
          .filter((s) => s.teamId === setup.teamId)
          .map((s) => [s.teamId, s.date, s.status]),
      ).toEqual([[setup.teamId, FRIDAY, 'draft']]);
    } finally {
      await kit.setSetting('site_holidays', '');
    }
  });

  it('shows a supervisor only the missing sheets of their own teams', async () => {
    const setup = await kit.setup();
    const other = await kit.team(SUPERVISOR2);
    const worker = await kit.worker();
    await kit.members(other.id, [worker.id]);
    const mine = await kit.attendance.queries.listMissing(
      kit.db,
      FRIDAY,
      FRIDAY,
      await kit.actorFor(SUPERVISOR),
    );
    const found = mine.find((m) => m.teamId === setup.teamId);
    expect(found?.teamName).toContain('Synthetic team');
    expect(found?.date).toBe(FRIDAY);
    expect(mine.some((m) => m.teamId === other.id)).toBe(false);
    const all = await kit.attendance.queries.listMissing(
      kit.db,
      FRIDAY,
      FRIDAY,
      await kit.actorFor(ACCOUNTANT),
    );
    expect(all.some((m) => m.teamId === other.id)).toBe(true);
  });

  it('never reports the future, and refuses a backwards or oversized period', async () => {
    const actor = await kit.actorFor(ACCOUNTANT);
    const tomorrow = await kit.attendance.queries.listMissing(
      kit.db,
      '2026-10-26',
      '2026-10-30',
      actor,
    );
    expect(tomorrow).toEqual([]);
    expect(await codeOf(kit.attendance.queries.listMissing(kit.db, FRIDAY, THURSDAY, actor))).toBe(
      'period_invalid',
    );
    expect(
      await codeOf(kit.attendance.queries.listMissing(kit.db, '2026-01-01', '2026-10-30', actor)),
    ).toBe('period_too_long');
  });
});

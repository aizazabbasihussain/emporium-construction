import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttendanceKit, uid, type AttendanceKit } from '../test-support.js';
import {
  countWorkersOnProject,
  findSheet,
  findSheetOfTeamDay,
  freezeAllocation,
  freezeEntry,
  insertSheet,
  listAllocations,
  listAllocationsOfEntries,
  listApprovedDays,
  listEntries,
  listSheetsInPeriod,
  listUnapprovedSheetsOfWorker,
  listWorkerDayConflicts,
  replaceEntries,
  searchSheets,
  setAllocationEntry,
  setOvertimeEntry,
  updateSheet,
  type NewEntry,
} from './attendance.repo.js';

let kit: AttendanceKit;
beforeAll(async () => {
  kit = await createAttendanceKit();
}, 60_000);
afterAll(() => kit.close());

const at = new Date('2026-10-25T10:00:00Z');
const by = uid(900);
const team = uid(901);
const worker1 = uid(902);
const worker2 = uid(903);
const project = uid(904);
const code = uid(905);

const entry = (n: number, worker: string, status = 'present', hours = '0'): NewEntry => ({
  id: uid(910 + n),
  lineNo: n,
  workerId: worker,
  workerCode: `WK${n}`,
  workerName: `Worker ${n}`,
  status,
  overtimeHours: hours,
  overtimeProjectId: null,
  remarks: null,
  dailyRate: null,
  dayValue: null,
  overtimeValue: null,
  allocations:
    status === 'present'
      ? [
          {
            id: uid(930 + n),
            projectId: project,
            fraction: '1.0000',
            costCodeId: code,
            amount: null,
          },
        ]
      : [],
});

describe('attendance repository', () => {
  it('inserts, finds, updates and locks sheets with optimistic versions', async () => {
    const id = uid(950);
    const row = await insertSheet(
      kit.db,
      { id, team_id: team, sheet_date: '2026-10-20', status: 'draft' },
      by,
      at,
    );
    expect(row).toMatchObject({ id, sheet_date: '2026-10-20', status: 'draft', total: '0.00' });
    expect(await findSheet(kit.db, id)).toMatchObject({ id, version: 1 });
    expect(await findSheet(kit.db, uid(999))).toBeUndefined();
    expect(await findSheetOfTeamDay(kit.db, team, '2026-10-20')).toMatchObject({ id });
    expect(await findSheetOfTeamDay(kit.db, team, '2026-10-21', true)).toBeUndefined();
    await kit.db.transaction(async (tx) => {
      expect(await findSheet(tx, id, true)).toMatchObject({ id });
      expect(await findSheetOfTeamDay(tx, team, '2026-10-20', true)).toMatchObject({ id });
    });
    const updated = await updateSheet(
      kit.db,
      id,
      1,
      { status: 'submitted', total: '12.50' },
      by,
      at,
    );
    expect(updated).toMatchObject({ status: 'submitted', total: '12.50', version: 2 });
    expect(await updateSheet(kit.db, id, 1, { status: 'draft' }, by, at)).toBeUndefined();
  });

  it('searches sheets by team, date, period and status with a total', async () => {
    const other = uid(951);
    await insertSheet(
      kit.db,
      { id: uid(952), team_id: other, sheet_date: '2026-10-22', status: 'draft' },
      by,
      at,
    );
    const base = { limit: 50, offset: 0 };
    const all = await searchSheets(kit.db, base);
    expect(all.total).toBeGreaterThanOrEqual(2);
    const byTeam = await searchSheets(kit.db, { ...base, teamId: other });
    expect(byTeam.rows.map((r) => r.id)).toEqual([uid(952)]);
    const limited = await searchSheets(kit.db, { ...base, teamIds: [team] });
    expect(limited.rows.every((r) => r.team_id === team)).toBe(true);
    expect((await searchSheets(kit.db, { ...base, teamIds: [] })).total).toBe(0);
    expect((await searchSheets(kit.db, { ...base, date: '2026-10-22', teamId: other })).total).toBe(
      1,
    );
    expect(
      (await searchSheets(kit.db, { ...base, from: '2026-10-21', to: '2026-10-22' })).total,
    ).toBe(1);
    expect(
      (await searchSheets(kit.db, { ...base, status: 'submitted' })).total,
    ).toBeGreaterThanOrEqual(1);
    const page = await searchSheets(kit.db, { limit: 1, offset: 1 });
    expect(page.rows).toHaveLength(1);
  });

  it('replaces the entries of a sheet, with their allocations and worker-day claims', async () => {
    const id = uid(960);
    await insertSheet(
      kit.db,
      { id, team_id: team, sheet_date: '2026-10-19', status: 'draft' },
      by,
      at,
    );
    await replaceEntries(kit.db, id, '2026-10-19', [
      entry(1, worker1),
      entry(2, worker2, 'absent'),
    ]);
    const entries = await listEntries(kit.db, id);
    expect(entries.map((e) => [e.line_no, e.worker_code, e.status])).toEqual([
      [1, 'WK1', 'present'],
      [2, 'WK2', 'absent'],
    ]);
    expect(entries[0]).toMatchObject({ overtime_hours: '0.00', daily_rate: null });
    const allocations = await listAllocations(kit.db, id);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      fraction: '1.0000',
      cost_object_id: project,
      amount: null,
    });
    expect(await listAllocationsOfEntries(kit.db, [entries[0]?.id as string])).toHaveLength(1);
    expect(await listAllocationsOfEntries(kit.db, [])).toEqual([]);

    // Replacing again drops the old lines and their claims.
    await replaceEntries(kit.db, id, '2026-10-19', [entry(3, worker1)]);
    expect((await listEntries(kit.db, id)).map((e) => e.worker_code)).toEqual(['WK3']);
    expect(await listAllocations(kit.db, id)).toHaveLength(1);
  });

  it('freezes pay, records ledger entries and finds worker-day conflicts', async () => {
    const id = uid(960);
    const [first] = await listEntries(kit.db, id);
    const [allocation] = await listAllocations(kit.db, id);
    await freezeEntry(kit.db, first?.id as string, {
      dailyRate: '1000.0000',
      dayValue: '1000.00',
      overtimeValue: '125.00',
    });
    await freezeAllocation(kit.db, allocation?.id as string, '1125.00');
    await setAllocationEntry(kit.db, allocation?.id as string, uid(970));
    await setOvertimeEntry(kit.db, first?.id as string, uid(971));
    const [frozen] = await listEntries(kit.db, id);
    expect(frozen).toMatchObject({
      daily_rate: '1000.0000',
      day_value: '1000.00',
      overtime_value: '125.00',
      overtime_cost_entry_id: uid(971),
    });
    expect((await listAllocations(kit.db, id))[0]).toMatchObject({
      amount: '1125.00',
      cost_entry_id: uid(970),
    });

    expect(await listWorkerDayConflicts(kit.db, [worker1, worker2], '2026-10-19', null)).toEqual([
      { worker_id: worker1 },
    ]);
    expect(await listWorkerDayConflicts(kit.db, [worker1], '2026-10-19', id)).toEqual([]);
    expect(await listWorkerDayConflicts(kit.db, [worker1], '2026-10-18', null)).toEqual([]);
  });

  it('answers the queries other modules use', async () => {
    const id = uid(960);
    expect(await listApprovedDays(kit.db, worker1, '2026-10-01', '2026-10-31')).toEqual([]);
    expect(await countWorkersOnProject(kit.db, project, '2026-10-19')).toBe(0);
    expect(await listUnapprovedSheetsOfWorker(kit.db, worker1, '2026-10-31')).toEqual([
      { id, date: '2026-10-19' },
    ]);
    expect(await listUnapprovedSheetsOfWorker(kit.db, worker1, '2026-10-18')).toEqual([]);

    await updateSheet(kit.db, id, 1, { status: 'approved', total: '1125.00' }, by, at);
    const days = await listApprovedDays(kit.db, worker1, '2026-10-01', '2026-10-31');
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      sheet_id: id,
      sheet_date: '2026-10-19',
      day_value: '1000.00',
      overtime_value: '125.00',
    });
    expect(await countWorkersOnProject(kit.db, project, '2026-10-19')).toBe(1);
    expect(await listUnapprovedSheetsOfWorker(kit.db, worker1, '2026-10-31')).toEqual([]);

    const period = await listSheetsInPeriod(kit.db, '2026-10-19', '2026-10-20');
    expect(period.map((s) => [s.date, s.status])).toEqual([
      ['2026-10-19', 'approved'],
      ['2026-10-20', 'submitted'],
    ]);
  });
});

import { workingDates } from '@emporium/domain/attendance';
import { BusinessDate } from '@emporium/domain/kernel';
import { dprSettingKeys } from '@emporium/shared';
import {
  countWorkersOnProject,
  listAllocationsOfEntries,
  listApprovedDays,
  listSheetsInPeriod,
  listUnapprovedSheetsOfWorker,
} from '../repo/attendance.repo.js';
import type {
  Actor,
  ApprovedDayDto,
  Db,
  EntryStatus,
  MissingSheetDto,
  SheetStatus,
  UnapprovedSheetsDto,
} from '../types.js';
import type { AttendanceDeps } from './sheets.service.js';

/** Reads that other modules and the missing-sheets screen use. */
export type QueriesService = ReturnType<typeof createQueriesService>;

/** The system reads every team: it holds no role, so no scope limits it. */
const SYSTEM: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  roles: [],
  scopes: [],
  permissions: new Set(),
  requestId: null,
};

export function createQueriesService(
  deps: Pick<AttendanceDeps, 'platform' | 'clock' | 'workforce'>,
) {
  const { platform, clock, workforce } = deps;

  /**
   * BR-9: the active team-dates (weekdays that are not site holidays, up to today) with no sheet
   * at all, for the teams the actor reaches. A team is expected only on dates when it has members.
   */
  async function missing(db: Db, from: string, to: string, actor: Actor) {
    const holidays = String((await platform.settings.get(db, dprSettingKeys.siteHolidays)).value);
    const dates = workingDates(from, to, BusinessDate.today(clock).toString(), holidays);
    const sheets = await listSheetsInPeriod(db, from, to);
    const have = new Set(sheets.map((sheet) => `${sheet.team_id}|${sheet.date}`));
    const result: MissingSheetDto[] = [];
    for (const team of (await workforce.listTeams(db, actor)).filter((t) => t.active)) {
      for (const date of dates) {
        if (have.has(`${team.id}|${date}`)) continue;
        if ((await workforce.getTeamMembers(db, team.id, date)).length === 0) continue;
        result.push({ teamId: team.id, teamCode: team.code, teamName: team.name, date });
      }
    }
    return { sheets, result };
  }

  return {
    /** `GET /attendance/missing`. */
    async listMissing(db: Db, from: string, to: string, actor: Actor): Promise<MissingSheetDto[]> {
      return (await missing(db, from, to, actor)).result;
    },

    /** Module interface `getUnapprovedSheets(period)` for wages (BR-9). */
    async getUnapprovedSheets(
      db: Db,
      period: { from: string; to: string },
    ): Promise<UnapprovedSheetsDto> {
      const { sheets, result } = await missing(db, period.from, period.to, SYSTEM);
      return {
        sheets: sheets
          .filter((sheet) => sheet.status !== 'approved')
          .map((sheet) => ({
            id: sheet.id,
            teamId: sheet.team_id,
            date: sheet.date,
            status: sheet.status as SheetStatus,
          })),
        missing: result.map((item) => ({ teamId: item.teamId, date: item.date })),
      };
    },

    /** Module interface `getApprovedAttendance(workerId, from, to)` for wages. */
    async getApprovedAttendance(
      db: Db,
      workerId: string,
      from: string,
      to: string,
    ): Promise<ApprovedDayDto[]> {
      const days = await listApprovedDays(
        db,
        workerId,
        BusinessDate.parse(from).toString(),
        BusinessDate.parse(to).toString(),
      );
      const allocations = await listAllocationsOfEntries(
        db,
        days.map((day) => day.entry_id),
      );
      return days.map((day) => ({
        sheetId: day.sheet_id,
        teamId: day.team_id,
        date: day.sheet_date,
        workerId: day.worker_id,
        status: day.status as EntryStatus,
        overtimeHours: day.overtime_hours,
        dayValue: day.day_value,
        overtimeValue: day.overtime_value,
        allocations: allocations
          .filter((a) => a.entry_id === day.entry_id)
          .map((a) => ({
            projectId: a.cost_object_id,
            fraction: a.fraction,
            amount: a.amount as string,
          })),
      }));
    },

    /** Module interface `getAttendanceHeadcount(projectId, date)` for daily reports. */
    async getAttendanceHeadcount(db: Db, projectId: string, date: string): Promise<number> {
      return countWorkersOnProject(db, projectId, BusinessDate.parse(date).toString());
    },

    /** The interface workforce uses before it marks a worker as left (workforce BR-6). */
    async listUnapprovedSheets(db: Db, workerId: string, upTo: string) {
      return listUnapprovedSheetsOfWorker(db, workerId, BusinessDate.parse(upTo).toString());
    },
  };
}

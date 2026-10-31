import { NotFoundError } from '@emporium/domain';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Attendance } from '../../attendance/index.js';
import type { Wages } from '../../wages/index.js';
import type { Workforce } from '../../workforce/index.js';
import {
  assertLinked,
  assertPortalAccess,
  monthsBack,
  parseMonth,
} from '../policy/workerportal.policy.js';
import { findAccountOfUser } from '../repo/workerportal.repo.js';
import type { Actor, Db, OwnAdvancesDto, OwnAttendanceDto, OwnWagesDto } from '../types.js';

export interface SelfDeps {
  clock: Clock;
  workforce: Pick<Workforce, 'getWorker'>;
  attendance: Pick<Attendance, 'getApprovedAttendance'>;
  wages: Pick<Wages, 'getApprovedWageSheet' | 'getWorkerAdvanceBalance'>;
}

export type SelfService = ReturnType<typeof createSelfService>;

/** How many months of advance recoveries the worker sees. */
export const RECOVERY_MONTHS = 12;

export function createSelfService(deps: SelfDeps) {
  const { clock, workforce, attendance, wages } = deps;

  /**
   * BR-2, BR-4: the worker is the one linked to the authenticated user, never one named by the
   * request; a login with no link, or of a worker who has left, is refused.
   */
  const workerIdOf = async (db: Db, actor: Actor): Promise<string> => {
    const link = assertLinked(await findAccountOfUser(db, actor.userId));
    const worker = await workforce.getWorker(db, link.worker_id, actor);
    assertPortalAccess(worker.leftOn, BusinessDate.today(clock).toString());
    return worker.id;
  };

  /** The approved wage line of the worker in a month, or null (BR-3). */
  const approvedLine = async (
    db: Db,
    workerId: string,
    period: { year: number; month: number },
  ) => {
    try {
      const sheet = await wages.getApprovedWageSheet(db, period);
      return sheet.lines.find((line) => line.workerId === workerId) ?? null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  };

  return {
    /** `GET /me/worker/attendance?month=` */
    async attendance(db: Db, actor: Actor, month: string): Promise<OwnAttendanceDto> {
      const range = parseMonth(month);
      const workerId = await workerIdOf(db, actor);
      const days = await attendance.getApprovedAttendance(db, workerId, range.from, range.to);
      return {
        month: range.key,
        days: days
          .map((day) => ({ date: day.date, status: day.status, overtimeHours: day.overtimeHours }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };
    },

    /** `GET /me/worker/advances` */
    async advances(db: Db, actor: Actor): Promise<OwnAdvancesDto> {
      const workerId = await workerIdOf(db, actor);
      const today = BusinessDate.today(clock).toString();
      const recoveries: OwnAdvancesDto['recoveries'] = [];
      for (const period of monthsBack(
        { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
        RECOVERY_MONTHS,
      )) {
        const line = await approvedLine(db, workerId, period);
        if (line !== null && Number(line.advanceRecovery) > 0) {
          recoveries.push({
            month: `${period.year}-${String(period.month).padStart(2, '0')}`,
            amount: line.advanceRecovery,
          });
        }
      }
      return { balance: await wages.getWorkerAdvanceBalance(db, workerId), recoveries };
    },

    /** `GET /me/worker/wages?month=` */
    async wages(db: Db, actor: Actor, month: string): Promise<OwnWagesDto> {
      const range = parseMonth(month);
      const workerId = await workerIdOf(db, actor);
      const line = await approvedLine(db, workerId, range);
      return {
        month: range.key,
        line:
          line === null
            ? null
            : {
                presentDays: line.presentDays,
                halfDays: line.halfDays,
                paidLeaveDays: line.paidLeaveDays,
                offDays: line.offDays,
                absentDays: line.absentDays,
                overtimeHours: line.overtimeHours,
                basicPay: line.basicPay,
                overtimePay: line.overtimePay,
                allowances: line.allowances,
                deductions: line.deductions,
                advanceRecovery: line.advanceRecovery,
                grossPay: line.grossPay,
                netPay: line.netPay,
              },
      };
    },
  };
}

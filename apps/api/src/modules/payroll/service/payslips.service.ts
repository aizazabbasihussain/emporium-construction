import { buildPayslip, type PayslipSource } from '@emporium/domain/payroll';
import { assertFound, assertRunFinalized } from '../policy/payroll.policy.js';
import { findLine, findRun, listLines, type LineRow, type RunRow } from '../repo/payroll.repo.js';
import type { Db, PayslipDto } from '../types.js';
import type { Context } from './context.js';
import { sheetOf } from './views.js';

export interface PayslipsService {
  /**
   * BR-3: one worker's payslip. The rate is shown only when `viewerWorkerId` is that worker; the
   * payroll screens pass null, so an accountant never sees a rate there.
   */
  get(db: Db, lineId: string, viewerWorkerId: string | null): Promise<PayslipDto>;
  /** BR-3: the payslips of every worker of a finalized run (the PDF set is built from these). */
  ofRun(db: Db, runId: string): Promise<PayslipDto[]>;
}

type SheetLine = Awaited<ReturnType<Context['wages']['getApprovedWageSheet']>>['lines'][number];

const sourceOf = (run: RunRow, line: LineRow, wage: SheetLine): PayslipSource => ({
  number: line.payslip_number as string,
  workerId: line.worker_id,
  workerCode: wage.workerCode,
  workerName: wage.workerName,
  period: `${run.year}-${String(run.month).padStart(2, '0')}`,
  payBasis: wage.payBasis,
  rate: wage.rate,
  presentDays: wage.presentDays,
  halfDays: wage.halfDays,
  paidLeaveDays: wage.paidLeaveDays,
  offDays: wage.offDays,
  absentDays: wage.absentDays,
  overtimeHours: wage.overtimeHours,
  basicPay: wage.basicPay,
  overtimePay: wage.overtimePay,
  allowances: wage.allowances,
  deductions: wage.deductions,
  advanceRecovery: wage.advanceRecovery,
  netPay: line.net_pay,
});

export function createPayslipsService(ctx: Context): PayslipsService {
  const build = async (db: Db, run: RunRow, lines: readonly LineRow[], viewer: string | null) => {
    assertRunFinalized(run.status);
    const sheet = await sheetOf(ctx, db, run);
    return lines.map((line): PayslipDto => {
      const wage = sheet.lines.find((candidate) => candidate.workerId === line.worker_id);
      return {
        ...buildPayslip(sourceOf(run, line, wage as SheetLine), viewer),
        lineId: line.id,
        runId: run.id,
      };
    });
  };

  return {
    async get(db, lineId, viewerWorkerId) {
      const line = assertFound(await findLine(db, lineId), 'payslip');
      const run = assertFound(await findRun(db, line.run_id), 'run');
      const [payslip] = await build(db, run, [line], viewerWorkerId);
      return payslip as PayslipDto;
    },

    async ofRun(db, runId) {
      const run = assertFound(await findRun(db, runId), 'run');
      return build(db, run, await listLines(db, runId), null);
    },
  };
}

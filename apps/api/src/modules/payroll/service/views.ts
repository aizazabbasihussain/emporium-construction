import { moneyDifference } from '@emporium/domain/payroll';
import type { CostDifferenceTreatment, PayrollPaymentMethod } from '@emporium/shared';
import type { LineRow, PaymentRow, RunRow } from '../repo/payroll.repo.js';
import type { Db, LineDto, PaymentDto, RunDto, RunStatus } from '../types.js';
import type { Context } from './context.js';

export const runDto = (row: RunRow): RunDto => ({
  id: row.id,
  periodId: row.period_id,
  year: row.year,
  month: row.month,
  status: row.status as RunStatus,
  revision: row.revision,
  finalizedAt: row.finalized_at,
  finalizedBy: row.finalized_by,
  totalNet: row.total_net,
  totalPaid: row.total_paid,
  totalUnpaid: moneyDifference(row.total_net, row.total_paid),
  costDifferenceTreatment: row.cost_difference_treatment as CostDifferenceTreatment,
  version: row.version,
});

export interface WorkerName {
  code: string;
  name: string;
}

/** The wage sheet of the run's month is the source of worker names and payslip figures. */
export async function sheetOf(ctx: Context, db: Db, run: Pick<RunRow, 'year' | 'month'>) {
  return ctx.wages.getApprovedWageSheet(db, { year: run.year, month: run.month });
}

export async function namesOf(
  ctx: Context,
  db: Db,
  run: Pick<RunRow, 'year' | 'month'>,
): Promise<Map<string, WorkerName>> {
  const sheet = await sheetOf(ctx, db, run);
  return new Map(
    sheet.lines.map((line) => [line.workerId, { code: line.workerCode, name: line.workerName }]),
  );
}

export const lineDto = (row: LineRow, names: ReadonlyMap<string, WorkerName>): LineDto => {
  const worker = names.get(row.worker_id) as WorkerName;
  return {
    id: row.id,
    runId: row.run_id,
    workerId: row.worker_id,
    workerCode: worker.code,
    workerName: worker.name,
    netPay: row.net_pay,
    paymentMethod: row.payment_method as PayrollPaymentMethod | null,
    paymentStatus: row.payment_status as LineDto['paymentStatus'],
    paidOn: row.paid_on,
    paymentId: row.payment_id,
    cashbookTxnId: row.cashbook_txn_id,
    payslipNumber: row.payslip_number,
  };
};

export const paymentDto = (row: PaymentRow, lines: readonly LineRow[]): PaymentDto => ({
  id: row.id,
  runId: row.run_id,
  paymentDate: row.payment_date,
  method: row.method as PayrollPaymentMethod,
  accountId: row.account_id,
  amount: row.amount,
  status: row.status as PaymentDto['status'],
  approvalDocId: row.approval_doc_id,
  reversedOn: row.reversed_on,
  reversalReason: row.reversal_reason,
  lineIds: lines.map((line) => line.id),
  cashbookTxnIds: [...new Set(lines.map((line) => line.cashbook_txn_id as string))],
  version: row.version,
});

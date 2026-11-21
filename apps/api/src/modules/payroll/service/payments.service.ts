import { BusinessDate } from '@emporium/domain/kernel';
import {
  assertApproverIsNotFinalizer,
  assertLinesPayable,
  assertStatusFollowsLines,
  needsPaymentApproval,
  planCashTransactions,
  runStatusFromLines,
  sumMoney,
} from '@emporium/domain/payroll';
import { cashbookSettingKeys, paymentDocType, payrollSettingKeys } from '@emporium/shared';
import {
  assertApprovalNamed,
  assertFound,
  assertPaymentReversible,
  assertRequestOfRun,
  assertReversalReason,
  assertRunPayable,
  assertUpdated,
} from '../policy/payroll.policy.js';
import {
  findPayment,
  findRun,
  insertPayment,
  listLines,
  listLinesOfPayment,
  listPayments,
  listUnpaid,
  markLinePaid,
  markPaymentLinesUnpaid,
  paidTotal,
  paidWagesForProject,
  updatePayment,
  updateRun,
  type LineRow,
  type RunRow,
} from '../repo/payroll.repo.js';
import type {
  Actor,
  Db,
  PaymentDto,
  PaymentRequestDto,
  PayrollPaymentMethod,
  RunStatus,
  UnpaidWagesDto,
} from '../types.js';
import type { Context } from './context.js';
import { namesOf, paymentDto, type WorkerName } from './views.js';

export interface PayInput {
  /** Omit to pay every unpaid line of the run. */
  lineIds?: string[] | undefined;
  paymentDate: string;
  method: PayrollPaymentMethod;
  accountId: string;
  /** The approved request from `requestPayment`; needed above the cash book's approval band. */
  approvalDocId?: string | undefined;
  version: number;
}

export interface PaymentsService {
  /** BR-4: asks the owner to approve a payment of the selected lines when it needs approval. */
  requestPayment(
    runId: string,
    input: { lineIds?: string[] | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<PaymentRequestDto>;
  /** BR-4: pays the selected lines, recording the cash book payment(s). */
  pay(runId: string, input: PayInput, actor: Actor, tx: Db): Promise<PaymentDto>;
  /** BR-5: reverses a payment in the cash book; its lines are unpaid again. */
  reverse(
    paymentId: string,
    input: { reason: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PaymentDto>;
  listPayments(db: Db, runId: string): Promise<PaymentDto[]>;
  /** BR-6: the unpaid lines of finalized runs, with their age. */
  unpaid(db: Db): Promise<UnpaidWagesDto>;
  /** Spec P2-08: wages paid for a project as of a date, by the project's share of each run. */
  getPaidWagesForProject(db: Db, projectId: string, asOf: string): Promise<string>;
}

export function createPaymentsService(ctx: Context): PaymentsService {
  const { clock, newId, record, cashbook, approvals } = ctx;

  const band = async (db: Db): Promise<string> =>
    String(await ctx.setting(db, cashbookSettingKeys.paymentApprovalThreshold));

  async function lockedRun(tx: Db, id: string, version: number | undefined): Promise<RunRow> {
    const row = assertFound(await findRun(tx, id, true), 'run');
    return version === undefined ? row : assertUpdated(row.version === version ? row : undefined);
  }

  /** The unpaid lines chosen by the caller, or all of them. */
  async function selection(tx: Db, runId: string, lineIds: string[] | undefined) {
    const unpaid = (await listLines(tx, runId)).filter((line) => line.payment_status === 'unpaid');
    const chosen = lineIds ?? unpaid.map((line) => line.id);
    assertLinesPayable(chosen, unpaid);
    return unpaid.filter((line) => chosen.includes(line.id));
  }

  /** BR-6: the run status follows the lines; totals are rebuilt from them. */
  async function refreshRun(tx: Db, run: RunRow, actor: Actor): Promise<RunRow> {
    const lines = await listLines(tx, run.id);
    const to = runStatusFromLines(
      lines.map((line) => ({ status: line.payment_status as 'paid' | 'unpaid' })),
    );
    assertStatusFollowsLines(run.status as RunStatus, to);
    return assertUpdated(
      await updateRun(
        tx,
        run.id,
        run.version,
        { status: to, total_paid: await paidTotal(tx, run.id) },
        actor.userId,
        clock.now(),
      ),
    );
  }

  const reference = (lines: readonly LineRow[]): string =>
    lines.map((line) => line.payslip_number as string).join(', ');

  const service: PaymentsService = {
    async requestPayment(runId, input, actor, tx) {
      const run = await lockedRun(tx, runId, undefined);
      assertRunPayable(run.status);
      const lines = await selection(tx, runId, input.lineIds);
      const amount = sumMoney(lines.map((line) => line.net_pay));
      const lineIds = lines.map((line) => line.id);
      if (!needsPaymentApproval(amount, await band(tx))) {
        return { approvalDocId: null, amount, lineIds };
      }
      // The cash book honours only requests of its own document type, so the request is a `payment`
      // whose context says it is wages of this run.
      const docId = newId();
      await approvals.requestApproval(
        {
          docType: paymentDocType,
          docId,
          amount,
          requesterId: actor.userId,
          context: { kind: 'payroll', runId, year: run.year, month: run.month, lineIds },
          requestId: actor.requestId,
        },
        tx,
      );
      return { approvalDocId: docId, amount, lineIds };
    },

    async pay(runId, input, actor, tx) {
      const run = await lockedRun(tx, runId, input.version);
      assertRunPayable(run.status);
      const lines = await selection(tx, runId, input.lineIds);
      const total = sumMoney(lines.map((line) => line.net_pay));
      const needed = needsPaymentApproval(total, await band(tx));
      assertApprovalNamed(needed, input.approvalDocId);
      if (needed) {
        const state = await approvals.getApprovalState(
          tx,
          paymentDocType,
          input.approvalDocId as string,
        );
        assertRequestOfRun(state, runId);
        assertApproverIsNotFinalizer(
          state.actions.filter((a) => a.action === 'approve').map((a) => a.actorId),
          run.finalized_by,
        );
      }
      const payment = await insertPayment(
        tx,
        {
          id: newId(),
          run_id: runId,
          payment_date: input.paymentDate,
          method: input.method,
          account_id: input.accountId,
          amount: total,
          approval_doc_id: needed ? input.approvalDocId : null,
          paid_by: actor.userId,
        },
        actor.userId,
        clock.now(),
      );
      const perLine = (await ctx.setting(tx, payrollSettingKeys.cashTxnPerLine)) === true;
      const names = `Wages ${run.year}-${String(run.month).padStart(2, '0')}`;
      for (const [index, plan] of planCashTransactions(
        lines.map((line) => ({ id: line.id, netPay: line.net_pay })),
        perLine,
      ).entries()) {
        const planned = lines.filter((line) => plan.lineIds.includes(line.id));
        const txn = await cashbook.recordPayment(
          {
            accountId: input.accountId,
            txnDate: input.paymentDate,
            amount: plan.amount,
            method: input.method,
            sourceModule: 'payroll',
            sourceDocType: 'payroll_payment',
            sourceDocId: payment.id,
            reference: reference(planned),
            description: names,
            idempotencyKey: `payroll:pay:${payment.id}:${index}`,
            ...(needed ? { approvalDocId: input.approvalDocId } : {}),
          },
          actor,
          tx,
        );
        for (const line of planned) {
          await markLinePaid(
            tx,
            line.id,
            {
              paymentId: payment.id,
              method: input.method,
              paidOn: input.paymentDate,
              cashbookTxnId: txn.id,
            },
            clock.now(),
            actor.userId,
          );
        }
      }
      const next = await refreshRun(tx, run, actor);
      await record(tx, actor, {
        action: 'payroll.payment.create',
        entityType: 'pyr_payment',
        entityId: payment.id,
        after: { runId, amount: total, lines: lines.length, method: input.method },
        event: {
          type: 'payroll.paid',
          payload: {
            runId,
            paymentId: payment.id,
            amount: total,
            method: input.method,
            runStatus: next.status,
          },
        },
      });
      return paymentDto(payment, await listLinesOfPayment(tx, payment.id));
    },

    async reverse(paymentId, input, actor, tx) {
      const payment = assertFound(await findPayment(tx, paymentId, true), 'payment');
      assertUpdated(payment.version === input.version ? payment : undefined);
      assertPaymentReversible(payment.status);
      const reason = assertReversalReason(input.reason);
      const run = await lockedRun(tx, payment.run_id, undefined);
      const lines = await listLinesOfPayment(tx, paymentId);
      for (const txnId of new Set(lines.map((line) => line.cashbook_txn_id as string))) {
        await cashbook.transactions.reverse(txnId, { reason }, actor, tx);
      }
      await markPaymentLinesUnpaid(tx, paymentId, clock.now(), actor.userId);
      const next = assertUpdated(
        await updatePayment(
          tx,
          paymentId,
          payment.version,
          {
            status: 'reversed',
            reversed_by: actor.userId,
            reversed_on: ctx.today(),
            reversal_reason: reason,
          },
          actor.userId,
          clock.now(),
        ),
      );
      const refreshed = await refreshRun(tx, run, actor);
      await record(tx, actor, {
        action: 'payroll.payment.reverse',
        entityType: 'pyr_payment',
        entityId: paymentId,
        before: { status: payment.status },
        after: { status: next.status, reason },
        event: {
          type: 'payroll.payment.reversed',
          payload: {
            runId: run.id,
            paymentId,
            amount: payment.amount,
            runStatus: refreshed.status,
          },
        },
      });
      return paymentDto(next, []);
    },

    async listPayments(db, runId) {
      assertFound(await findRun(db, runId), 'run');
      const payments = await listPayments(db, runId);
      return Promise.all(
        payments.map(async (row) => paymentDto(row, await listLinesOfPayment(db, row.id))),
      );
    },

    async getPaidWagesForProject(db, projectId, asOf) {
      return sumMoney([
        await paidWagesForProject(db, projectId, BusinessDate.parse(asOf).toString()),
      ]);
    },

    async unpaid(db) {
      const rows = await listUnpaid(db, ctx.today());
      const names = new Map<string, Map<string, WorkerName>>();
      const items = [];
      for (const row of rows) {
        if (!names.has(row.run_id)) names.set(row.run_id, await namesOf(ctx, db, row));
        const worker = (names.get(row.run_id) as Map<string, WorkerName>).get(
          row.worker_id,
        ) as WorkerName;
        items.push({
          runId: row.run_id,
          year: row.year,
          month: row.month,
          lineId: row.line_id,
          workerId: row.worker_id,
          workerCode: worker.code,
          workerName: worker.name,
          netPay: row.net_pay,
          ageDays: row.age_days,
        });
      }
      const byRun = new Map<string, UnpaidWagesDto['byRun'][number]>();
      for (const item of items) {
        const seen = byRun.get(item.runId);
        byRun.set(item.runId, {
          runId: item.runId,
          year: item.year,
          month: item.month,
          unpaidCount: (seen?.unpaidCount ?? 0) + 1,
          unpaidAmount: sumMoney([seen?.unpaidAmount ?? '0', item.netPay]),
          oldestAgeDays: Math.max(seen?.oldestAgeDays ?? 0, item.ageDays),
        });
      }
      return {
        rows: items,
        byRun: [...byRun.values()],
        total: sumMoney(items.map((item) => item.netPay)),
      };
    },
  };
  return service;
}

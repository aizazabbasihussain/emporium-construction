import { assertReopenable, assertRunTransition, isPositiveMoney } from '@emporium/domain/payroll';
import { payslipSeries, type CostDifferenceTreatment } from '@emporium/shared';
import {
  assertFound,
  assertNoRunYet,
  assertPeriodApproved,
  assertReversalReason,
  assertSheetUnchanged,
  assertUpdated,
} from '../policy/payroll.policy.js';
import {
  findRun,
  findRunOfPeriod,
  insertLine,
  insertRun,
  listAdjustments,
  listLines,
  listRuns,
  runLocksPeriod,
  setPayslipNumber,
  updateRun,
  type RunRow,
} from '../repo/payroll.repo.js';
import type { Actor, Db, LineDto, PageResult, RunDetailDto, RunDto, RunStatus } from '../types.js';
import type { Context } from './context.js';
import type { CostService } from './cost.service.js';
import { lineDto, namesOf, runDto, sheetOf } from './views.js';

export interface RunsService {
  /** BR-1: a run for an approved wage period; its lines copy the net pay of the wage sheet. */
  create(
    input: { periodId: string; costDifferenceTreatment?: CostDifferenceTreatment | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<RunDetailDto>;
  get(db: Db, id: string): Promise<RunDetailDto>;
  list(db: Db, page: { limit: number; offset: number }): Promise<PageResult<RunDto>>;
  lines(db: Db, id: string): Promise<LineDto[]>;
  /** BR-1, BR-2, BR-3: locks the run, posts the labour cost and numbers the payslips. */
  finalize(
    id: string,
    input: { version: number; costDifferenceTreatment?: CostDifferenceTreatment | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<RunDetailDto>;
  /** BR-7: reopens an unpaid finalized run and reverses the cost finalization. */
  reopen(
    id: string,
    input: { reason: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<RunDetailDto>;
  /** Module interface `getPayrollRun(periodId)`. */
  getPayrollRun(db: Db, periodId: string): Promise<RunDetailDto>;
  /** What wages asks before it reopens a period: a run that is no longer a draft locks it. */
  hasPaidLines(db: Db, periodId: string): Promise<boolean>;
}

export function createRunsService(ctx: Context, costs: CostService): RunsService {
  const { clock, newId, platform, record } = ctx;

  async function detail(db: Db, row: RunRow): Promise<RunDetailDto> {
    const lines = await listLines(db, row.id);
    const draft = row.status === 'draft';
    const figures = draft
      ? await costs.preview(db, row)
      : {
          grossPay: row.gross_pay as string,
          allocatedCost: row.allocated_cost as string,
          difference: row.cost_difference as string,
        };
    const adjustments = draft ? [] : await listAdjustments(db, row.id, row.revision);
    return {
      ...runDto(row),
      lineCount: lines.length,
      paidLineCount: lines.filter((line) => line.payment_status === 'paid').length,
      cost: {
        ...figures,
        adjustments: adjustments.map((a) => ({
          projectId: a.project_id,
          amount: a.amount,
          ledgerEntryId: a.ledger_entry_id,
        })),
      },
    };
  }

  async function locked(tx: Db, id: string, version: number): Promise<RunRow> {
    const row = assertFound(await findRun(tx, id, true), 'run');
    return assertUpdated(row.version === version ? row : undefined);
  }

  const service: RunsService = {
    async create(input, actor, tx) {
      const period = await ctx.wages.periods.get(tx, input.periodId);
      assertPeriodApproved(period.status);
      assertNoRunYet(await findRunOfPeriod(tx, period.id));
      const sheet = await ctx.wages.getApprovedWageSheet(tx, {
        year: period.year,
        month: period.month,
      });
      const run = await insertRun(
        tx,
        {
          id: newId(),
          period_id: period.id,
          year: period.year,
          month: period.month,
          total_net: sheet.totals.netPay,
          cost_difference_treatment: input.costDifferenceTreatment ?? 'spread_to_projects',
        },
        actor.userId,
        clock.now(),
      );
      // A worker with nothing to pay (the advance recovery took it all) has no line and no payslip.
      for (const line of sheet.lines.filter((l) => isPositiveMoney(l.netPay))) {
        await insertLine(
          tx,
          { id: newId(), run_id: run.id, worker_id: line.workerId, net_pay: line.netPay },
          actor.userId,
          clock.now(),
        );
      }
      const result = await detail(tx, run);
      await record(tx, actor, {
        action: 'payroll.run.create',
        entityType: 'pyr_run',
        entityId: run.id,
        after: { periodId: run.period_id, totalNet: run.total_net, lines: result.lineCount },
        event: {
          type: 'payroll.run.created',
          payload: { runId: run.id, periodId: run.period_id, year: run.year, month: run.month },
        },
      });
      return result;
    },

    async get(db, id) {
      return detail(db, assertFound(await findRun(db, id), 'run'));
    },

    async list(db, page) {
      const { rows, total } = await listRuns(db, page);
      return { items: rows.map(runDto), total, limit: page.limit, offset: page.offset };
    },

    async lines(db, id) {
      const run = assertFound(await findRun(db, id), 'run');
      const names = await namesOf(ctx, db, run);
      return (await listLines(db, id)).map((line) => lineDto(line, names));
    },

    async finalize(id, input, actor, tx) {
      const run = await locked(tx, id, input.version);
      assertRunTransition(run.status as RunStatus, 'finalized');
      const sheet = await sheetOf(ctx, tx, run);
      assertSheetUnchanged(run.total_net, sheet.totals.netPay);
      const treatment = input.costDifferenceTreatment ?? run.cost_difference_treatment;
      const revision = run.revision + 1;
      const cost = await costs.finalize(
        tx,
        run,
        revision,
        treatment as CostDifferenceTreatment,
        sheet.lines.map((line) => line.workerId),
        actor,
      );
      // BR-3: one payslip number per worker per run; a reopened run keeps the numbers it had.
      for (const line of await listLines(tx, run.id)) {
        if (line.payslip_number === null) {
          await setPayslipNumber(
            tx,
            line.id,
            await platform.numbering.next(payslipSeries, tx),
            clock.now(),
            actor.userId,
          );
        }
      }
      const next = assertUpdated(
        await updateRun(
          tx,
          id,
          run.version,
          {
            status: 'finalized',
            revision,
            finalized_at: clock.now().toISOString(),
            finalized_by: actor.userId,
            gross_pay: cost.grossPay,
            allocated_cost: cost.allocatedCost,
            cost_difference: cost.difference,
            cost_difference_treatment: treatment,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'payroll.run.finalize',
        entityType: 'pyr_run',
        entityId: id,
        before: { status: run.status },
        after: { status: next.status, revision, ...cost },
        event: {
          type: 'payroll.finalized',
          payload: {
            runId: id,
            periodId: run.period_id,
            year: run.year,
            month: run.month,
            revision,
            totalNet: run.total_net,
            grossPay: cost.grossPay,
            costDifference: cost.difference,
          },
        },
      });
      return detail(tx, next);
    },

    async reopen(id, input, actor, tx) {
      const run = await locked(tx, id, input.version);
      const lines = await listLines(tx, id);
      assertReopenable(
        run.status as RunStatus,
        lines.filter((line) => line.payment_status === 'paid').length,
      );
      const reason = assertReversalReason(input.reason);
      await costs.reopen(tx, run, reason, actor);
      const next = assertUpdated(
        await updateRun(
          tx,
          id,
          run.version,
          { status: 'draft', finalized_at: null, finalized_by: null },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'payroll.run.reopen',
        entityType: 'pyr_run',
        entityId: id,
        before: { status: run.status },
        after: { status: next.status, reason },
        event: {
          type: 'payroll.reopened',
          payload: { runId: id, periodId: run.period_id, year: run.year, month: run.month, reason },
        },
      });
      return detail(tx, next);
    },

    async getPayrollRun(db, periodId) {
      return detail(db, assertFound(await findRunOfPeriod(db, periodId), 'run'));
    },

    hasPaidLines: (db, periodId) => runLocksPeriod(db, periodId),
  };
  return service;
}

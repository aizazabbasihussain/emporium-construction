import { NotFoundError } from '@emporium/domain';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  assertAdjustable,
  assertAdjustmentAmount,
  assertCalculable,
  assertPeriodTransition,
  assertReason,
  assertSubmissionReady,
  assertWageSettings,
  calculateBasicPay,
  money,
  monthBounds,
  periodTotals,
  reconcile,
  settleLine,
  sumMoney,
  type DayInput,
  type LineAmounts,
  type PayBasis,
  type PeriodStatus,
  type WageSettings,
} from '@emporium/domain/wages';
import { wagePeriodDocType, wagesSettingKeys, type AdjustmentKind } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Attendance } from '../../attendance/index.js';
import type { Platform } from '../../platform/index.js';
import type { Workforce } from '../../workforce/index.js';
import {
  assertFound,
  assertHasLines,
  assertMonthFree,
  assertNotPaid,
  assertUpdated,
  missingRate,
} from '../policy/wages.policy.js';
import {
  countAdjustmentsOfLine,
  deleteLines,
  deleteRecoveriesOfLine,
  deleteRecoveriesOfPeriod,
  findAdvance,
  findApprovedPeriodOfDate,
  findLine,
  findPeriod,
  findPeriodOfMonth,
  insertAdjustment,
  insertPeriod,
  insertRecovery,
  listAdjustmentsOfPeriod,
  listLines,
  listOpenAdvances,
  listRecoveriesOfPeriod,
  searchPeriods,
  setAdvanceStatus,
  setLineSettlement,
  setRecoveriesApplied,
  sumAdjustments,
  updatePeriod,
  upsertLine,
  type AdjustmentRow,
  type LineRow,
  type PeriodRow,
} from '../repo/wages.repo.js';
import type {
  Actor,
  AdjustmentDto,
  ApprovedWageSheetDto,
  Db,
  LineDto,
  LinesDto,
  PageResult,
  PeriodDetailDto,
  PeriodDto,
  ReconciliationDto,
  TotalsDto,
  WarningsDto,
} from '../types.js';
import { createRecorder, lastDecision } from './support.js';

/** What wages needs from payment (P2-07); a stub that reports nothing paid stands in until then. */
export interface WagePayments {
  /** BR-11: whether any line of the period has been paid. */
  hasPaidLines(db: Db, periodId: string): Promise<boolean>;
}

export interface WagesDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
  workforce: Pick<Workforce, 'workers' | 'getWorker' | 'getWorkerRate'>;
  attendance: Pick<Attendance, 'getApprovedAttendance' | 'getUnapprovedSheets'>;
  payments: WagePayments;
}

export interface PeriodQuery {
  year?: number | undefined;
  status?: PeriodStatus | undefined;
  limit: number;
  offset: number;
}

/** The system reads every worker: it holds no role, so no scope limits it. */
const SYSTEM: Actor = {
  userId: '00000000-0000-0000-0000-000000000000',
  roles: [],
  scopes: [],
  permissions: new Set(),
  requestId: null,
};

const PAGE = 200;

const isoOf = (date: Date | null): string | null => date?.toISOString() ?? null;

export type PeriodsService = ReturnType<typeof createPeriodsService>;

export function createPeriodsService(deps: WagesDeps) {
  const { platform, clock, newId, approvals, workforce, attendance, payments } = deps;
  const record = createRecorder(platform);

  const periodOf = (row: PeriodRow): PeriodDto => {
    const { from, to } = monthBounds(row.year, row.month);
    return {
      id: row.id,
      year: row.year,
      month: row.month,
      from,
      to,
      status: row.status as PeriodStatus,
      calculatedAt: isoOf(row.calculated_at),
      totalNet: row.total_net,
      submittedBy: row.submitted_by,
      submittedAt: isoOf(row.submitted_at),
      approvedBy: row.approved_by,
      approvedAt: isoOf(row.approved_at),
      reopenReason: row.reopen_reason,
      version: row.version,
    };
  };

  const lineOf = (row: LineRow): LineDto => ({
    id: row.id,
    periodId: row.period_id,
    workerId: row.worker_id,
    workerCode: row.worker_code,
    workerName: row.worker_name,
    payBasis: row.pay_basis as PayBasis,
    rate: row.rate,
    presentDays: row.present_days,
    halfDays: row.half_days,
    paidLeaveDays: row.paid_leave_days,
    offDays: row.off_days,
    absentDays: row.absent_days,
    overtimeHours: row.overtime_hours,
    basicPay: row.basic_pay,
    overtimePay: row.overtime_pay,
    allowances: row.allowances,
    deductions: row.deductions,
    advanceRecovery: row.advance_recovery,
    grossPay: row.gross_pay,
    netPay: row.net_pay,
    roundingAdjustment: row.rounding_adjustment,
    shortfall: row.shortfall,
    note: row.note,
  });

  const adjustmentOf = (row: AdjustmentRow): AdjustmentDto => ({
    id: row.id,
    lineId: row.line_id,
    kind: row.kind as AdjustmentKind,
    amount: row.amount,
    reason: row.reason,
    addedBy: row.added_by,
    addedAt: row.added_at.toISOString(),
  });

  const amountsOf = (row: LineRow): LineAmounts => ({
    basicPay: row.basic_pay,
    overtimePay: row.overtime_pay,
    allowances: row.allowances,
    deductions: row.deductions,
    advanceRecovery: row.advance_recovery,
    grossPay: row.gross_pay,
    netPay: row.net_pay,
    roundingAdjustment: row.rounding_adjustment,
  });

  const totalsOf = (rows: readonly LineRow[]): TotalsDto => periodTotals(rows.map(amountsOf));

  async function settingsOf(db: Db): Promise<WageSettings> {
    const value = async (key: string) => (await platform.settings.get(db, key)).value;
    return {
      workingDaysBasis: Number(await value(wagesSettingKeys.workingDaysBasis)),
      overtimeMultiplier: String(await value(wagesSettingKeys.overtimeMultiplier)),
      payOffDaysDaily: (await value(wagesSettingKeys.payOffDaysDaily)) === true,
      roundNetToRupee: (await value(wagesSettingKeys.roundNetToRupee)) === true,
    };
  }

  /** The period locked for update; a missing one is reported as not found. */
  async function locked(tx: Db, id: string): Promise<PeriodRow> {
    return assertFound(await findPeriod(tx, id, true), 'period');
  }

  async function moveTo(
    tx: Db,
    existing: PeriodRow,
    to: PeriodStatus,
    values: Record<string, unknown>,
    action: string,
    actor: { userId: string | null; requestId: string | null },
    event?: { type: string; payload: Record<string, unknown> },
  ): Promise<PeriodRow> {
    assertPeriodTransition(existing.status as PeriodStatus, to);
    return stored(tx, existing, { status: to, ...values }, action, actor, event);
  }

  /** Writes the changed values with the expected version, then the audit entry and the event. */
  async function stored(
    tx: Db,
    existing: PeriodRow,
    values: Record<string, unknown>,
    action: string,
    actor: { userId: string | null; requestId: string | null },
    event?: { type: string; payload: Record<string, unknown> },
  ): Promise<PeriodRow> {
    const row = assertUpdated(
      await updatePeriod(tx, existing.id, existing.version, values, actor.userId, clock.now()),
    );
    await record(tx, actor, {
      action: `wages.period.${action}`,
      entityType: 'wag_period',
      entityId: row.id,
      before: { status: existing.status },
      after: { status: row.status, totalNet: row.total_net },
      event: event ?? {
        type: 'wages.period.changed',
        payload: {
          periodId: row.id,
          year: row.year,
          month: row.month,
          status: row.status,
          change: action,
        },
      },
    });
    return row;
  }

  /**
   * BR-5, BR-6, BR-10: totals the manual adjustments of the line and plans the advance recovery
   * from the open balances, then stores the settlement. The recovery rows are replaced; they are
   * applied to the balances only when the period is approved.
   */
  async function resettle(
    tx: Db,
    period: PeriodRow,
    line: LineRow,
    roundNetToRupee: boolean,
  ): Promise<LineRow> {
    const adjustments = await sumAdjustments(tx, line.id);
    const advances = await listOpenAdvances(
      tx,
      monthBounds(period.year, period.month).to,
      line.worker_id,
    );
    const settlement = settleLine({
      basicPay: line.basic_pay,
      overtimePay: line.overtime_pay,
      allowances: adjustments.allowances,
      deductions: adjustments.deductions,
      advances: advances.map((a) => ({
        id: a.id,
        monthlyRecovery: a.monthly_recovery,
        balance: a.balance,
      })),
      roundNetToRupee,
    });
    await deleteRecoveriesOfLine(tx, line.id);
    for (const item of settlement.recoveries) {
      await insertRecovery(tx, {
        advanceId: item.advanceId,
        periodId: period.id,
        lineId: line.id,
        amount: item.amount,
      });
    }
    return setLineSettlement(tx, line.id, {
      allowances: money(adjustments.allowances),
      deductions: settlement.deductions,
      advanceRecovery: settlement.advanceRecovery,
      grossPay: settlement.grossPay,
      netPay: settlement.netPay,
      roundingAdjustment: settlement.roundingAdjustment,
      shortfall: settlement.shortfall,
    });
  }

  /** Every worker, in pages. */
  async function allWorkers(db: Db) {
    const workers = [];
    for (let offset = 0; ;) {
      const page = await workforce.workers.list(db, { limit: PAGE, offset }, SYSTEM);
      workers.push(...page.items);
      offset += page.items.length;
      if (offset >= page.total) return workers;
    }
  }

  /** BR-2: the approved days of the worker with the pay rate in effect on each. */
  async function daysOf(
    tx: Db,
    worker: { id: string; fullName: string },
    from: string,
    to: string,
  ): Promise<DayInput[]> {
    const approved = await attendance.getApprovedAttendance(tx, worker.id, from, to);
    const days: DayInput[] = [];
    for (const day of approved) {
      let rate;
      try {
        rate = await workforce.getWorkerRate(tx, worker.id, day.date);
      } catch (error) {
        if (error instanceof NotFoundError) throw missingRate(worker.fullName, day.date);
        throw error;
      }
      days.push({
        date: day.date,
        status: day.status,
        overtimeHours: day.overtimeHours,
        payBasis: rate.payBasis,
        amount: rate.amount,
        dailyEquivalent: rate.dailyEquivalent,
      });
    }
    return days;
  }

  /** BR-9, BR-5: what blocks submission and what the approver acknowledges. */
  async function warningsOf(
    tx: Db,
    period: PeriodRow,
    lines: readonly LineRow[],
  ): Promise<WarningsDto> {
    const unapproved = await attendance.getUnapprovedSheets(
      tx,
      monthBounds(period.year, period.month),
    );
    return {
      unapprovedSheets: unapproved.sheets.map((sheet) => ({
        id: sheet.id,
        teamId: sheet.teamId,
        date: sheet.date,
        status: sheet.status,
      })),
      missingSheets: unapproved.missing,
      shortfalls: lines
        .filter((line) => Number(line.shortfall) > 0)
        .map((line) => ({
          workerId: line.worker_id,
          workerName: line.worker_name,
          amount: line.shortfall,
        })),
    };
  }

  async function detail(tx: Db, row: PeriodRow): Promise<PeriodDetailDto> {
    const lines = await listLines(tx, row.id);
    const state = await approvals.getApprovalState(tx, wagePeriodDocType, row.id);
    const empty: WarningsDto = { unapprovedSheets: [], missingSheets: [], shortfalls: [] };
    return {
      ...periodOf(row),
      totals: totalsOf(lines),
      lineCount: lines.length,
      warnings: row.status === 'approved' ? empty : await warningsOf(tx, row, lines),
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null, lastComment: null }
          : {
              status: state.status,
              requestId: state.id,
              currentRole: state.currentRole,
              lastComment: lastDecision(state).comment,
            },
    };
  }

  async function linesOf(tx: Db, row: PeriodRow): Promise<LinesDto> {
    const lines = await listLines(tx, row.id);
    return {
      period: periodOf(row),
      lines: lines.map(lineOf),
      adjustments: (await listAdjustmentsOfPeriod(tx, row.id)).map(adjustmentOf),
      totals: totalsOf(lines),
    };
  }

  return {
    /** `POST /wages/periods`: one period per calendar month. */
    async create(input: { year: number; month: number }, actor: Actor, tx: Db): Promise<PeriodDto> {
      monthBounds(input.year, input.month);
      assertMonthFree(await findPeriodOfMonth(tx, input.year, input.month));
      const row = await insertPeriod(
        tx,
        { id: newId(), year: input.year, month: input.month, status: 'draft' },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'wages.period.create',
        entityType: 'wag_period',
        entityId: row.id,
        after: { year: row.year, month: row.month },
        event: {
          type: 'wages.period.changed',
          payload: {
            periodId: row.id,
            year: row.year,
            month: row.month,
            status: row.status,
            change: 'create',
          },
        },
      });
      return periodOf(row);
    },

    async list(db: Db, query: PeriodQuery): Promise<PageResult<PeriodDto>> {
      const { rows, total } = await searchPeriods(db, query);
      return { items: rows.map(periodOf), total, limit: query.limit, offset: query.offset };
    },

    async get(db: Db, id: string): Promise<PeriodDetailDto> {
      return detail(db, assertFound(await findPeriod(db, id), 'period'));
    },

    /** `GET /wages/periods/:id/lines`. */
    async lines(db: Db, id: string): Promise<LinesDto> {
      return linesOf(db, assertFound(await findPeriod(db, id), 'period'));
    },

    /**
     * BR-1 to BR-8: reads the approved attendance of the month for every worker, prices it and
     * stores one line per worker. It replaces the calculated values and keeps the manual
     * adjustments; an approved period is refused.
     */
    async calculate(id: string, actor: Actor, tx: Db): Promise<LinesDto> {
      const existing = await locked(tx, id);
      assertCalculable(existing.status as PeriodStatus);
      const settings = await settingsOf(tx);
      assertWageSettings(settings);
      const { from, to } = monthBounds(existing.year, existing.month);
      await deleteRecoveriesOfPeriod(tx, id);
      const seen = new Set<string>();
      for (const worker of await allWorkers(tx)) {
        const days = await daysOf(tx, worker, from, to);
        if (days.length === 0) continue;
        seen.add(worker.id);
        const basic = calculateBasicPay(days, settings);
        const line = await upsertLine(tx, {
          id: newId(),
          periodId: id,
          workerId: worker.id,
          workerCode: worker.code,
          workerName: worker.fullName,
          ...basic,
          allowances: '0.00',
          deductions: '0.00',
          advanceRecovery: '0.00',
          grossPay: '0.00',
          netPay: '0.00',
          roundingAdjustment: '0.00',
          shortfall: '0.00',
        });
        await resettle(tx, existing, line, settings.roundNetToRupee);
      }
      // A worker whose attendance is gone keeps the line only while it carries adjustments.
      for (const line of await listLines(tx, id)) {
        if (seen.has(line.worker_id)) continue;
        if ((await countAdjustmentsOfLine(tx, line.id)) === 0) {
          await deleteLines(tx, [line.id]);
          continue;
        }
        const cleared = await upsertLine(tx, {
          id: line.id,
          periodId: id,
          workerId: line.worker_id,
          workerCode: line.worker_code,
          workerName: line.worker_name,
          payBasis: line.pay_basis,
          rate: line.rate,
          presentDays: '0.00',
          halfDays: '0.00',
          paidLeaveDays: '0.00',
          offDays: '0.00',
          absentDays: '0.00',
          overtimeHours: '0.00',
          basicPay: '0.00',
          overtimePay: '0.00',
          allowances: '0.00',
          deductions: '0.00',
          advanceRecovery: '0.00',
          grossPay: '0.00',
          netPay: '0.00',
          roundingAdjustment: '0.00',
          shortfall: '0.00',
        });
        await resettle(tx, existing, cleared, settings.roundNetToRupee);
      }
      const row = await stored(
        tx,
        existing,
        {
          status: existing.status === 'draft' ? 'calculated' : existing.status,
          calculated_at: clock.now().toISOString(),
        },
        'calculate',
        actor,
      );
      return linesOf(tx, row);
    },

    /** BR-10: a manual allowance or deduction with a reason; the line is settled again. */
    async addAdjustment(
      lineId: string,
      input: { kind: AdjustmentKind; amount: string; reason: string },
      actor: Actor,
      tx: Db,
    ): Promise<LinesDto> {
      const found = assertFound(await findLine(tx, lineId), 'line');
      const period = await locked(tx, found.period_id);
      assertAdjustable(period.status as PeriodStatus);
      const amount = assertAdjustmentAmount(input.amount);
      const reason = assertReason(input.reason);
      const adjustment = await insertAdjustment(tx, {
        id: newId(),
        lineId,
        kind: input.kind,
        amount,
        reason,
        addedBy: actor.userId,
      });
      const settings = await settingsOf(tx);
      await resettle(tx, period, found, settings.roundNetToRupee);
      await record(tx, actor, {
        action: 'wages.adjustment.add',
        entityType: 'wag_adjustment',
        entityId: adjustment.id,
        after: { lineId, kind: input.kind, amount, reason },
        event: {
          type: 'wages.period.changed',
          payload: {
            periodId: period.id,
            year: period.year,
            month: period.month,
            status: period.status,
            change: 'adjustment',
          },
        },
      });
      return linesOf(tx, period);
    },

    /**
     * BR-9, BR-11: unapproved attendance blocks; missing sheets and shortfalls need acknowledging.
     * The net pay is frozen as the amount of the approval request (doc type `wage_period`).
     */
    async submit(
      id: string,
      input: { version: number; acknowledgeWarnings: boolean },
      actor: Actor,
      tx: Db,
    ): Promise<PeriodDetailDto> {
      const existing = await locked(tx, id);
      assertUpdated(existing.version === input.version ? existing : undefined);
      assertPeriodTransition(existing.status as PeriodStatus, 'submitted');
      const lines = await listLines(tx, id);
      assertHasLines(lines.length);
      const warnings = await warningsOf(tx, existing, lines);
      assertSubmissionReady({
        unapproved: warnings.unapprovedSheets.map((sheet) => ({
          teamId: sheet.teamId,
          date: sheet.date,
        })),
        missing: warnings.missingSheets,
        shortfalls: warnings.shortfalls.map((item) => item.workerName),
        acknowledged: input.acknowledgeWarnings,
      });
      const totals = totalsOf(lines);
      await approvals.requestApproval(
        {
          docType: wagePeriodDocType,
          docId: id,
          amount: totals.netPay,
          requesterId: actor.userId,
          context: {
            year: existing.year,
            month: existing.month,
            totalNet: totals.netPay,
            workers: lines.length,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const acknowledged = warnings.missingSheets.length + warnings.shortfalls.length > 0;
      const row = await moveTo(
        tx,
        existing,
        'submitted',
        {
          total_net: totals.netPay,
          submitted_by: actor.userId,
          submitted_at: clock.now().toISOString(),
          warnings_acknowledged_by: acknowledged ? actor.userId : null,
        },
        'submit',
        actor,
      );
      return detail(tx, row);
    },

    /**
     * BR-6, BR-11: the approval engine decided. Approval locks the period, applies the planned
     * recoveries to the advance balances and emits `wages.period.approved` once; a rejected,
     * returned or withdrawn request sends the period back to calculated. A replayed event finds the
     * period already moved and does nothing.
     */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string },
      tx: Db,
    ): Promise<void> {
      const existing = await findPeriod(tx, payload.docId, true);
      if (existing?.status !== 'submitted') return;
      const system = { userId: null, requestId: null };
      if (outcome !== 'approved') {
        await moveTo(tx, existing, 'calculated', {}, outcome, system);
        return;
      }
      await setRecoveriesApplied(tx, existing.id, true);
      for (const recovery of await listRecoveriesOfPeriod(tx, existing.id)) {
        const advance = assertFound(await findAdvance(tx, recovery.advance_id), 'advance');
        if (Number(advance.balance) <= 0) await setAdvanceStatus(tx, advance.id, 'closed');
      }
      const approver = lastDecision(
        await approvals.getApprovalState(tx, wagePeriodDocType, existing.id),
      );
      const lines = await listLines(tx, existing.id);
      await moveTo(
        tx,
        existing,
        'approved',
        { approved_by: approver.actorId, approved_at: clock.now().toISOString() },
        'approve',
        system,
        {
          type: 'wages.period.approved',
          payload: {
            periodId: existing.id,
            year: existing.year,
            month: existing.month,
            totalNet: existing.total_net,
            workers: lines.length,
          },
        },
      );
    },

    /**
     * BR-11: reopening an approved period needs a reason and is blocked once any line is paid. The
     * recoveries are reversed, so the advance balances return to what they were.
     */
    async reopen(
      id: string,
      input: { reason: string; version: number },
      actor: Actor,
      tx: Db,
    ): Promise<PeriodDetailDto> {
      const existing = await locked(tx, id);
      assertUpdated(existing.version === input.version ? existing : undefined);
      const reason = assertReason(input.reason);
      assertPeriodTransition(existing.status as PeriodStatus, 'reopened');
      assertNotPaid(await payments.hasPaidLines(tx, id));
      await setRecoveriesApplied(tx, id, false);
      for (const recovery of await listRecoveriesOfPeriod(tx, id)) {
        const advance = assertFound(await findAdvance(tx, recovery.advance_id), 'advance');
        if (advance.status === 'closed') await setAdvanceStatus(tx, advance.id, 'open');
      }
      const row = await moveTo(
        tx,
        existing,
        'reopened',
        { reopen_reason: reason, approved_by: null, approved_at: null },
        'reopen',
        actor,
        {
          type: 'wages.period.reopened',
          payload: { periodId: id, year: existing.year, month: existing.month, reason },
        },
      );
      return detail(tx, row);
    },

    /**
     * BR-12: the labour cost that approved attendance allocated to projects (day value plus
     * overtime, as booked in the cost ledger) against the gross pay of the wage sheet.
     */
    async reconciliation(db: Db, id: string): Promise<ReconciliationDto> {
      const period = assertFound(await findPeriod(db, id), 'period');
      const { from, to } = monthBounds(period.year, period.month);
      const lines = await listLines(db, id);
      const allocated = new Map<string, string>();
      for (const line of lines) {
        const days = await attendance.getApprovedAttendance(db, line.worker_id, from, to);
        allocated.set(
          line.worker_id,
          sumMoney(days.flatMap((day) => [day.dayValue, day.overtimeValue])),
        );
      }
      const result = reconcile(
        allocated,
        new Map(lines.map((line) => [line.worker_id, line.gross_pay])),
      );
      const names = new Map(lines.map((line) => [line.worker_id, line]));
      const rows = (list: typeof result.rows) =>
        list.map((row) => {
          const line = names.get(row.workerId) as LineRow;
          return { ...row, workerCode: line.worker_code, workerName: line.worker_name };
        });
      return {
        period: periodOf(period),
        rows: rows(result.rows),
        differences: rows(result.differences),
        totals: result.totals,
      };
    },

    /** Module interface `getApprovedWageSheet(period)`. */
    async getApprovedWageSheet(
      db: Db,
      period: { year: number; month: number },
    ): Promise<ApprovedWageSheetDto> {
      const row = await findPeriodOfMonth(db, period.year, period.month);
      if (row?.status !== 'approved') {
        throw new NotFoundError('wage_sheet_not_found', 'No approved wage sheet for this month');
      }
      const lines = await listLines(db, row.id);
      return { period: periodOf(row), lines: lines.map(lineOf), totals: totalsOf(lines) };
    },

    /** The interface attendance uses (its BR-7): the name of the approved period of the date. */
    async approvedPeriodOf(db: Db, date: string): Promise<string | null> {
      const row = await findApprovedPeriodOfDate(db, BusinessDate.parse(date).toString());
      return row === undefined ? null : `${row.year}-${String(row.month).padStart(2, '0')}`;
    },
  };
}

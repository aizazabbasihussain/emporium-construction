import { moneyDifference, spreadDifference, sumMoney } from '@emporium/domain/payroll';
import {
  attendanceSettingKeys,
  payrollAdjustmentDocType,
  type CostDifferenceTreatment,
} from '@emporium/shared';
import type { CostEntryDto } from '../../projects/index.js';
import { assertAttendanceCostComplete, assertLabourCode } from '../policy/payroll.policy.js';
import {
  deleteAdjustments,
  deleteCostEntries,
  insertAdjustment,
  insertCostEntry,
  listAdjustments,
  listCostEntries,
  type RunRow,
} from '../repo/payroll.repo.js';
import type { Actor, Db } from '../types.js';
import type { Context } from './context.js';

/** More than any project has booked; one call returns the whole ledger of a project. */
const LEDGER_LIMIT = 100_000;

export interface CostFigures {
  grossPay: string;
  allocatedCost: string;
  difference: string;
}

export interface CostService {
  /** The live comparison of the wage sheet gross with the attendance cost (BR-2). */
  preview(db: Db, run: RunRow): Promise<CostFigures>;
  /** BR-2: posts the month's labour cost and the difference; returns the figures it used. */
  finalize(
    tx: Db,
    run: RunRow,
    revision: number,
    treatment: CostDifferenceTreatment,
    workerIds: readonly string[],
    actor: Actor,
  ): Promise<CostFigures>;
  /** BR-7: reverses a finalization and puts the attendance cost back to approved. */
  reopen(tx: Db, run: RunRow, reason: string, actor: Actor): Promise<void>;
}

/** The first and last day of a calendar month. */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

/** BR-2: cost finalization. The wages module stays the only calculator; this only moves cost. */
export function createCostService(ctx: Context): CostService {
  const { projects, attendance, wages, masterData, platform, newId } = ctx;

  /** The approved attendance cost entries of the month, with the project they sit on. */
  async function attendanceEntries(tx: Db, run: RunRow, workerIds: readonly string[]) {
    const { from, to } = monthBounds(run.year, run.month);
    const projectIds = new Set<string>();
    for (const workerId of workerIds) {
      for (const day of await attendance.getApprovedAttendance(tx, workerId, from, to)) {
        for (const allocation of day.allocations) projectIds.add(allocation.projectId);
      }
    }
    const found: { projectId: string; entry: CostEntryDto }[] = [];
    for (const projectId of [...projectIds].sort()) {
      // The ledger lists the newest row first, so the first row of a chain is its current state.
      const latest = new Map<string, CostEntryDto>();
      for (const entry of await listLedger(tx, projectId)) {
        const key = [
          entry.sourceModule,
          entry.sourceDocType,
          entry.sourceDocId,
          entry.sourceLineId, // join renders a missing line as an empty part
        ].join('|');
        if (!latest.has(key)) latest.set(key, entry);
      }
      for (const entry of latest.values()) {
        if (
          entry.sourceModule === 'attendance' &&
          entry.status === 'approved' &&
          entry.entryDate >= from &&
          entry.entryDate <= to
        ) {
          found.push({ projectId, entry });
        }
      }
    }
    return found;
  }

  async function listLedger(tx: Db, projectId: string) {
    const page = await projects.costing.listEntries(
      tx,
      { type: 'project', id: projectId },
      { limit: LEDGER_LIMIT, offset: 0 },
    );
    return page.items;
  }

  async function labourCodeId(tx: Db): Promise<string> {
    const code = String(
      (await platform.settings.get(tx, attendanceSettingKeys.labourCostCode)).value,
    );
    return assertLabourCode(
      (await masterData.costing.listCostCodes(tx)).find((candidate) => candidate.code === code),
    );
  }

  return {
    async preview(db, run) {
      const { totals } = await wages.periods.reconciliation(db, run.period_id);
      return {
        grossPay: totals.gross,
        allocatedCost: totals.allocated,
        difference: totals.difference,
      };
    },

    async finalize(tx, run, revision, treatment, workerIds, actor) {
      const { totals } = await wages.periods.reconciliation(tx, run.period_id);
      const entries = await attendanceEntries(tx, run, workerIds);
      const allocated = sumMoney(entries.map(({ entry }) => entry.amount));
      assertAttendanceCostComplete(allocated, totals.allocated);
      const perProject = new Map<string, string[]>();
      for (const { projectId, entry } of entries) {
        const posted = await projects.transitionCost(entry.id, 'posted', tx, actor.userId);
        await insertCostEntry(tx, {
          id: newId(),
          runId: run.id,
          revision,
          projectId,
          sourceDocType: entry.sourceDocType,
          sourceDocId: entry.sourceDocId,
          sourceLineId: entry.sourceLineId,
          costCodeId: entry.costCodeId,
          amount: entry.amount,
          entryDate: entry.entryDate,
          approvedEntryId: entry.id,
          postedEntryId: posted.id,
        });
        perProject.set(projectId, [...(perProject.get(projectId) ?? []), entry.amount]);
      }
      const difference = moneyDifference(totals.gross, allocated);
      if (difference !== '0.00') {
        // BR-2 and H-29: spread pro rata to the projects of the month, or all to overhead.
        const parts =
          treatment === 'spread_to_projects' && allocated !== '0.00'
            ? spreadDifference(
                difference,
                [...perProject].map(([key, amounts]) => ({ key, weight: sumMoney(amounts) })),
              ).filter((part) => part.amount !== '0.00')
            : [{ key: null, amount: difference }];
        const costCodeId = await labourCodeId(tx);
        for (const part of parts) {
          const posted = await projects.postCost(
            {
              costObject:
                part.key === null
                  ? { type: 'overhead', id: null }
                  : { type: 'project', id: part.key },
              costCodeId,
              amount: part.amount,
              status: 'posted',
              sourceModule: 'payroll',
              sourceDocType: payrollAdjustmentDocType,
              sourceDocId: run.id,
              sourceLineId: part.key,
              entryDate: ctx.today(),
              description: `Payroll ${run.year}-${String(run.month).padStart(2, '0')}: difference to attendance cost`,
              idempotencyKey: `payroll:${run.id}:${revision}:adj:${part.key ?? 'overhead'}`,
              actorUserId: actor.userId,
            },
            tx,
          );
          await insertAdjustment(tx, {
            id: newId(),
            runId: run.id,
            revision,
            projectId: part.key,
            amount: part.amount,
            ledgerEntryId: posted.id,
          });
        }
      }
      return { grossPay: totals.gross, allocatedCost: allocated, difference };
    },

    async reopen(tx, run, reason, actor) {
      for (const row of await listCostEntries(tx, run.id, run.revision)) {
        await projects.reverseCost(row.posted_entry_id, reason, tx, actor.userId);
        await projects.postCost(
          {
            costObject: { type: 'project', id: row.project_id },
            costCodeId: row.cost_code_id,
            amount: row.amount,
            status: 'approved',
            sourceModule: 'attendance',
            sourceDocType: row.source_doc_type,
            sourceDocId: row.source_doc_id,
            sourceLineId: row.source_line_id,
            entryDate: row.entry_date,
            description: 'Attendance cost restored when payroll was reopened',
            idempotencyKey: `payroll:${run.id}:${run.revision}:restore:${row.id}`,
            actorUserId: actor.userId,
          },
          tx,
        );
      }
      for (const row of await listAdjustments(tx, run.id, run.revision)) {
        await projects.reverseCost(row.ledger_entry_id, reason, tx, actor.userId);
      }
      await deleteCostEntries(tx, run.id, run.revision);
      await deleteAdjustments(tx, run.id, run.revision);
    },
  };
}

import { NotFoundError } from '@emporium/domain';
import {
  allocationCostKey,
  assertSheetEditable,
  assertSheetTransition,
  assertSubmittable,
  entryAmounts,
  entryCost,
  isWorked,
  normalizeEntries,
  overtimeCostKey,
  sumAmounts,
  type Entry,
  type EntryInput,
  type SheetStatus,
} from '@emporium/domain/attendance';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { scopeFilter } from '@emporium/domain/identity';
import {
  attendanceSettingKeys,
  attendanceSheetDocType,
  platformPermissions,
} from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Workforce } from '../../workforce/index.js';
import {
  assertCostCodeActive,
  assertFound,
  assertLabourCodeKnown,
  assertMembers,
  assertMultiplier,
  assertProjectActive,
  assertProjectReachable,
  assertReason,
  assertTeamActive,
  assertTeamReachable,
  assertUpdated,
  assertVersionGiven,
  assertWagePeriodOpen,
  assertWorkersFree,
  canSeeCost,
  missingRate,
} from '../policy/attendance.policy.js';
import {
  findSheet,
  findSheetOfTeamDay,
  freezeAllocation,
  freezeEntry,
  insertSheet,
  listAllocations,
  listEntries,
  listWorkerDayConflicts,
  replaceEntries,
  searchSheets,
  setAllocationEntry,
  setOvertimeEntry,
  updateSheet,
  type AllocationRow,
  type EntryRow,
  type NewEntry,
  type SheetRow,
} from '../repo/attendance.repo.js';
import type {
  Actor,
  AllocationDto,
  Db,
  EntryDto,
  EntryStatus,
  GridDto,
  PageResult,
  SheetDto,
  SheetHeaderDto,
} from '../types.js';
import { createRecorder, lastDecision } from './support.js';

/** What attendance needs from wages (P1-18); a stub stands in until that module exists. */
export interface WagePeriods {
  /** BR-7: the name of the approved wage period that contains the date, or null. */
  approvedPeriodOf(db: Db, date: string): Promise<string | null>;
}

export interface AttendanceDeps {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'postCost' | 'reverseCost'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
  masterData: Pick<MasterData, 'getCostCode' | 'costing'>;
  workforce: Pick<Workforce, 'getWorkerRate' | 'getTeamMembers' | 'getTeam' | 'listTeams'>;
  wages: WagePeriods;
}

export interface SheetInput {
  /** Required when the sheet already exists (constitution 5.2). */
  version?: number | undefined;
  entries: EntryInput[];
}

export interface SheetQuery {
  teamId?: string | undefined;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: SheetStatus | undefined;
  limit: number;
  offset: number;
}

const headerOf = (row: SheetRow, showCost: boolean): SheetHeaderDto => ({
  id: row.id,
  teamId: row.team_id,
  sheetDate: row.sheet_date,
  status: row.status as SheetStatus,
  total: showCost ? row.total : null,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at?.toISOString() ?? null,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at?.toISOString() ?? null,
  unlockReason: row.unlock_reason,
  version: row.version,
});

export type SheetsService = ReturnType<typeof createSheetsService>;

export function createSheetsService(deps: AttendanceDeps) {
  const { platform, clock, newId, projects, approvals, masterData, workforce, wages } = deps;
  const record = createRecorder(platform);

  const changed = (row: SheetRow, change: string) => ({
    type: 'attendance.sheet.changed',
    payload: {
      sheetId: row.id,
      teamId: row.team_id,
      date: row.sheet_date,
      status: row.status,
      change,
    },
  });

  async function dtoOf(db: Db, row: SheetRow, actor: Actor): Promise<SheetDto> {
    const showCost = canSeeCost(actor);
    const allocations = await listAllocations(db, row.id);
    const state = await approvals.getApprovalState(db, attendanceSheetDocType, row.id);
    const entries = (await listEntries(db, row.id)).map((entry): EntryDto => ({
      id: entry.id,
      lineNo: entry.line_no,
      workerId: entry.worker_id,
      workerCode: entry.worker_code,
      workerName: entry.worker_name,
      status: entry.status as EntryStatus,
      overtimeHours: entry.overtime_hours,
      overtimeProjectId: entry.overtime_project_id,
      remarks: entry.remarks,
      dayValue: showCost ? entry.day_value : null,
      overtimeValue: showCost ? entry.overtime_value : null,
      allocations: allocations
        .filter((a) => a.entry_id === entry.id)
        .map((a): AllocationDto => ({
          id: a.id,
          projectId: a.cost_object_id,
          fraction: a.fraction,
          costCodeId: a.cost_code_id,
          amount: showCost ? a.amount : null,
        })),
    }));
    return {
      ...headerOf(row, showCost),
      entries,
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

  /** BR-3: the cost code that attendance cost is booked on unless a line names another. */
  async function labourCodeId(tx: Db): Promise<string> {
    const code = String(
      (await platform.settings.get(tx, attendanceSettingKeys.labourCostCode)).value,
    );
    const found = assertLabourCodeKnown(
      (await masterData.costing.listCostCodes(tx)).find((candidate) => candidate.code === code),
    );
    assertCostCodeActive(found.active);
    return found.id;
  }

  /**
   * BR-2, BR-3, BR-5: checks the entries against the team on the date, the other sheets, the
   * supervisor's projects and the cost codes. Returns them with every allocation's cost code set.
   */
  async function prepare(
    tx: Db,
    teamId: string,
    date: string,
    inputs: readonly EntryInput[],
    actor: Actor,
    sheetId: string | null,
  ) {
    const entries = normalizeEntries(inputs);
    const members = new Map(
      (await workforce.getTeamMembers(tx, teamId, date)).map((member) => [member.workerId, member]),
    );
    assertMembers(
      entries.filter((entry) => !members.has(entry.workerId)).map((entry) => entry.workerId),
    );
    const conflicts = await listWorkerDayConflicts(
      tx,
      entries.map((entry) => entry.workerId),
      date,
      sheetId,
    );
    assertWorkersFree(
      conflicts.map((c) => (members.get(c.worker_id) as { fullName: string }).fullName),
    );
    const projectIds = new Set(
      entries.flatMap((entry) => [
        ...entry.allocations.map((a) => a.projectId),
        ...(entry.overtimeProjectId === null ? [] : [entry.overtimeProjectId]),
      ]),
    );
    for (const projectId of projectIds) {
      assertProjectReachable(actor, projectId);
      assertProjectActive((await projects.getProject(tx, projectId)).status);
    }
    const named = new Set(
      entries.flatMap((entry) => entry.allocations.flatMap((a) => a.costCodeId ?? [])),
    );
    for (const costCodeId of named) {
      assertCostCodeActive((await masterData.getCostCode(tx, costCodeId)).active);
    }
    const needsDefault = entries.some((entry) =>
      entry.allocations.some((a) => a.costCodeId === null),
    );
    const fallback = needsDefault ? await labourCodeId(tx) : '';
    const resolved: Entry[] = entries.map((entry) => ({
      ...entry,
      allocations: entry.allocations.map((a) => ({ ...a, costCodeId: a.costCodeId ?? fallback })),
    }));
    return { entries: resolved, members };
  }

  const toInput = (entry: EntryRow, allocations: readonly AllocationRow[]): EntryInput => ({
    workerId: entry.worker_id,
    status: entry.status as EntryStatus,
    overtimeHours: entry.overtime_hours,
    overtimeProjectId: entry.overtime_project_id,
    remarks: entry.remarks,
    allocations: allocations
      .filter((a) => a.entry_id === entry.id)
      .map((a) => ({
        projectId: a.cost_object_id,
        fraction: a.fraction,
        costCodeId: a.cost_code_id,
      })),
  });

  /** BR-4: the worker's daily-equivalent rate on the date; a missing rate names the worker. */
  async function dailyRateOf(tx: Db, workerId: string, name: string, date: string) {
    try {
      return (await workforce.getWorkerRate(tx, workerId, date)).dailyEquivalent;
    } catch (error) {
      if (error instanceof NotFoundError && error.code === 'rate_not_found') {
        throw missingRate(name, date);
      }
      throw error;
    }
  }

  async function locked(tx: Db, id: string, actor: Actor): Promise<SheetRow> {
    const row = assertFound(await findSheet(tx, id, true), 'sheet');
    assertTeamReachable(actor, row.team_id);
    return row;
  }

  /** One status change with its audit row and event. */
  async function moveTo(
    tx: Db,
    existing: SheetRow,
    to: SheetStatus,
    values: Record<string, unknown>,
    action: string,
    actor: { userId: string | null; requestId: string | null },
    event?: { type: string; payload: Record<string, unknown> },
  ): Promise<SheetRow> {
    assertSheetTransition(existing.status as SheetStatus, to);
    const row = assertUpdated(
      await updateSheet(
        tx,
        existing.id,
        existing.version,
        { status: to, ...values },
        actor.userId,
        clock.now(),
      ),
    );
    await record(tx, actor, {
      action: `attendance.sheet.${action}`,
      entityType: 'att_sheet',
      entityId: row.id,
      before: { status: existing.status },
      after: { status: row.status, total: row.total },
      event: event ?? changed(row, action),
    });
    return row;
  }

  return {
    /** The members of a team on a date with the sheet saved for it, for the attendance grid. */
    async grid(db: Db, teamId: string, date: string, actor: Actor): Promise<GridDto> {
      await workforce.getTeam(db, teamId, actor);
      const day = BusinessDate.parse(date).toString();
      const row = await findSheetOfTeamDay(db, teamId, day);
      return {
        teamId,
        date: day,
        members: (await workforce.getTeamMembers(db, teamId, day)).map((member) => ({
          workerId: member.workerId,
          code: member.code,
          fullName: member.fullName,
          tradeCode: member.tradeCode,
        })),
        sheet: row === undefined ? null : await dtoOf(db, row, actor),
      };
    },

    async list(db: Db, query: SheetQuery, actor: Actor): Promise<PageResult<SheetHeaderDto>> {
      const filter = scopeFilter(actor, 'team');
      const { rows, total } = await searchSheets(db, {
        teamIds: filter.all ? undefined : filter.ids,
        teamId: query.teamId,
        date: query.date,
        from: query.from,
        to: query.to,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
      const showCost = canSeeCost(actor);
      return {
        items: rows.map((row) => headerOf(row, showCost)),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async get(db: Db, id: string, actor: Actor): Promise<SheetDto> {
      const row = assertFound(await findSheet(db, id), 'sheet');
      assertTeamReachable(actor, row.team_id);
      return dtoOf(db, row, actor);
    },

    /**
     * BR-1, BR-10: creates or replaces the draft of a team and date with the whole grid at once.
     * Everything is checked first; one bad entry rejects the lot.
     */
    async save(
      teamId: string,
      date: string,
      input: SheetInput,
      actor: Actor,
      tx: Db,
    ): Promise<SheetDto> {
      const team = await workforce.getTeam(tx, teamId, actor);
      assertTeamActive(team.active);
      const day = BusinessDate.parse(date).toString();
      const existing = await findSheetOfTeamDay(tx, teamId, day, true);
      if (existing === undefined) {
        await platform.backdating.check(
          {
            date: BusinessDate.parse(day),
            canOverride: actor.permissions.has(platformPermissions.backdateOverride),
            actorUserId: actor.userId,
            requestId: actor.requestId,
            entityType: 'att_sheet',
          },
          tx,
        );
      } else {
        assertSheetEditable(existing.status as SheetStatus);
        assertVersionGiven(input.version);
      }
      const { entries, members } = await prepare(
        tx,
        teamId,
        day,
        input.entries,
        actor,
        existing?.id ?? null,
      );
      const stored: NewEntry[] = entries.map((entry, index) => {
        const member = members.get(entry.workerId) as { code: string; fullName: string };
        return {
          id: newId(),
          lineNo: index + 1,
          workerId: entry.workerId,
          workerCode: member.code,
          workerName: member.fullName,
          status: entry.status,
          overtimeHours: entry.overtimeHours,
          overtimeProjectId: entry.overtimeProjectId,
          remarks: entry.remarks,
          dailyRate: null,
          dayValue: null,
          overtimeValue: null,
          allocations: entry.allocations.map((a) => ({
            id: newId(),
            projectId: a.projectId,
            fraction: a.fraction,
            costCodeId: a.costCodeId as string,
            amount: null,
          })),
        };
      });
      let row: SheetRow;
      if (existing === undefined) {
        row = await insertSheet(
          tx,
          { id: newId(), team_id: teamId, sheet_date: day, status: 'draft' },
          actor.userId,
          clock.now(),
        );
      } else {
        row = assertUpdated(
          await updateSheet(
            tx,
            existing.id,
            input.version as number,
            {},
            actor.userId,
            clock.now(),
          ),
        );
      }
      await replaceEntries(tx, row.id, day, stored);
      await record(tx, actor, {
        action: 'attendance.sheet.save',
        entityType: 'att_sheet',
        entityId: row.id,
        before: existing === undefined ? undefined : { status: existing.status },
        after: { status: row.status, entries: stored.length },
        event: changed(row, existing === undefined ? 'created' : 'updated'),
      });
      return dtoOf(tx, row, actor);
    },

    /** BR-4, BR-6: freezes the pay and asks the approval engine; the amount is the labour cost. */
    async submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<SheetDto> {
      const existing = await locked(tx, id, actor);
      assertUpdated(existing.version === expectedVersion ? existing : undefined);
      assertSheetTransition(existing.status as SheetStatus, 'submitted');
      const entryRows = await listEntries(tx, id);
      assertSubmittable(entryRows.length);
      const allocationRows = await listAllocations(tx, id);
      const { entries, members } = await prepare(
        tx,
        existing.team_id,
        existing.sheet_date,
        entryRows.map((entry) => toInput(entry, allocationRows)),
        actor,
        id,
      );
      const multiplier = assertMultiplier(
        String((await platform.settings.get(tx, attendanceSettingKeys.overtimeMultiplier)).value),
      );
      const amounts: string[] = [];
      for (const [index, entry] of entries.entries()) {
        const row = entryRows[index] as EntryRow;
        const name = (members.get(entry.workerId) as { fullName: string }).fullName;
        const rate = isWorked(entry.status)
          ? await dailyRateOf(tx, entry.workerId, name, existing.sheet_date)
          : null;
        const cost = entryCost({
          status: entry.status,
          dailyRate: rate ?? '0',
          overtimeHours: entry.overtimeHours,
          multiplier,
        });
        const split = entryAmounts({
          allocations: entry.allocations,
          overtimeProjectId: entry.overtimeProjectId,
          ...cost,
        });
        await freezeEntry(tx, row.id, {
          dailyRate: rate ?? '0',
          dayValue: cost.dayValue,
          overtimeValue: cost.overtimeValue,
        });
        const rowsOfEntry = allocationRows.filter((a) => a.entry_id === row.id);
        for (const [position, allocation] of rowsOfEntry.entries()) {
          await freezeAllocation(tx, allocation.id, split.allocations[position] as string);
        }
        amounts.push(...split.allocations, ...(split.overtime === null ? [] : [split.overtime]));
      }
      const total = sumAmounts(amounts);
      await approvals.requestApproval(
        {
          docType: attendanceSheetDocType,
          docId: id,
          amount: total,
          requesterId: actor.userId,
          context: {
            scope: { type: 'team', id: existing.team_id },
            teamId: existing.team_id,
            date: existing.sheet_date,
            total,
            workers: entries.length,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(
        tx,
        existing,
        'submitted',
        { total, submitted_by: actor.userId, submitted_at: clock.now().toISOString() },
        'submit',
        actor,
      );
      return dtoOf(tx, row, actor);
    },

    /**
     * BR-6, BR-8: the approval engine decided. Approval books one `approved` cost entry per
     * worker-day-project, keyed `att:<entry>:<allocation>`; a rejected or returned sheet goes back
     * to the supervisor, and a sheet whose request was withdrawn becomes a draft again. A replayed
     * event finds the sheet already moved and does nothing.
     */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string },
      tx: Db,
    ): Promise<void> {
      const existing = await findSheet(tx, payload.docId, true);
      if (existing?.status !== 'submitted') return;
      const system = { userId: null, requestId: null };
      if (outcome !== 'approved') {
        await moveTo(
          tx,
          existing,
          outcome === 'cancelled' ? 'draft' : 'rejected',
          {},
          outcome,
          system,
        );
        return;
      }
      const entries = await listEntries(tx, existing.id);
      const allocations = await listAllocations(tx, existing.id);
      for (const entry of entries) {
        const description = `Attendance ${existing.sheet_date}: ${entry.worker_code}`;
        for (const allocation of allocations.filter((a) => a.entry_id === entry.id)) {
          const posted = await projects.postCost(
            {
              costObject: { type: 'project', id: allocation.cost_object_id },
              costCodeId: allocation.cost_code_id,
              amount: allocation.amount as string,
              status: 'approved',
              sourceModule: 'attendance',
              sourceDocType: attendanceSheetDocType,
              sourceDocId: existing.id,
              sourceLineId: allocation.id,
              entryDate: existing.sheet_date,
              description,
              idempotencyKey: allocationCostKey(entry.id, allocation.id),
            },
            tx,
          );
          await setAllocationEntry(tx, allocation.id, posted.id);
        }
        if (entry.overtime_project_id !== null) {
          const posted = await projects.postCost(
            {
              costObject: { type: 'project', id: entry.overtime_project_id },
              costCodeId: (allocations.find((a) => a.entry_id === entry.id) as AllocationRow)
                .cost_code_id,
              amount: entry.overtime_value as string,
              status: 'approved',
              sourceModule: 'attendance',
              sourceDocType: attendanceSheetDocType,
              sourceDocId: existing.id,
              sourceLineId: entry.id,
              entryDate: existing.sheet_date,
              description: `${description} (overtime)`,
              idempotencyKey: overtimeCostKey(entry.id),
            },
            tx,
          );
          await setOvertimeEntry(tx, entry.id, posted.id);
        }
      }
      const approver = lastDecision(
        await approvals.getApprovalState(tx, attendanceSheetDocType, existing.id),
      );
      await moveTo(
        tx,
        existing,
        'approved',
        { approved_by: approver.actorId, approved_at: clock.now().toISOString() },
        'approve',
        system,
        {
          type: 'attendance.approved',
          payload: {
            sheetId: existing.id,
            teamId: existing.team_id,
            date: existing.sheet_date,
            total: existing.total,
          },
        },
      );
    },

    /**
     * BR-7: unlocks an approved sheet with a reason. Its cost entries are reversed and its lines get
     * fresh ids, so approving it again books new entries. Refused once the wage period is approved.
     */
    async unlock(
      id: string,
      input: { reason: string },
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<SheetDto> {
      const existing = await locked(tx, id, actor);
      assertUpdated(existing.version === expectedVersion ? existing : undefined);
      const reason = assertReason(input.reason);
      assertSheetTransition(existing.status as SheetStatus, 'unlocked');
      assertWagePeriodOpen(await wages.approvedPeriodOf(tx, existing.sheet_date));
      const entryRows = await listEntries(tx, id);
      const allocationRows = await listAllocations(tx, id);
      const why = `Attendance ${existing.sheet_date} unlocked: ${reason}`;
      for (const allocation of allocationRows) {
        await projects.reverseCost(allocation.cost_entry_id as string, why, tx, actor.userId);
      }
      for (const entry of entryRows) {
        if (entry.overtime_cost_entry_id !== null) {
          await projects.reverseCost(entry.overtime_cost_entry_id, why, tx, actor.userId);
        }
      }
      await replaceEntries(
        tx,
        id,
        existing.sheet_date,
        entryRows.map((entry) => ({
          id: newId(),
          lineNo: entry.line_no,
          workerId: entry.worker_id,
          workerCode: entry.worker_code,
          workerName: entry.worker_name,
          status: entry.status,
          overtimeHours: entry.overtime_hours,
          overtimeProjectId: entry.overtime_project_id,
          remarks: entry.remarks,
          dailyRate: entry.daily_rate,
          dayValue: entry.day_value,
          overtimeValue: entry.overtime_value,
          allocations: allocationRows
            .filter((a) => a.entry_id === entry.id)
            .map((a) => ({
              id: newId(),
              projectId: a.cost_object_id,
              fraction: a.fraction,
              costCodeId: a.cost_code_id,
              amount: a.amount,
            })),
        })),
      );
      const row = await moveTo(
        tx,
        existing,
        'unlocked',
        { unlock_reason: reason, approved_by: null, approved_at: null },
        'unlock',
        actor,
        {
          type: 'attendance.unlocked',
          payload: {
            sheetId: id,
            teamId: existing.team_id,
            date: existing.sheet_date,
            reason,
          },
        },
      );
      return dtoOf(tx, row, actor);
    },
  };
}

import {
  addTotals,
  assertAmountAllowed,
  assertCostObjectOpen,
  assertCostTransition,
  budgetVariance,
  chainKey,
  normalizeAmount,
  sumAmounts,
  type CostStatus,
  type ProjectStatus,
  type StatusTotals,
} from '@emporium/domain/costing';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { projectSettingKeys, type CostObjectType } from '@emporium/shared';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertChainFree,
  assertCostCodeActive,
  assertFound,
  assertLatestInChain,
} from '../policy/projects.policy.js';
import {
  findEntry,
  findEntryByKey,
  insertEntry,
  latestInChain,
  listEntries,
  summaryRows,
  type EntryRow,
} from '../repo/ledger.repo.js';
import { budgetByCode, findProject } from '../repo/projects.repo.js';
import type {
  CostEntryDto,
  CostObjectRef,
  CostSummaryDto,
  CostSummaryLineDto,
  Db,
  PageResult,
} from '../types.js';
import { createRecorder, pageOf, requiredText, textOrNull, type Recorded } from './support.js';

/** What another module posts (spec section 2, `postCost(entry)`). */
export interface PostCostInput {
  costObject: CostObjectRef;
  costCodeId: string;
  /** Money as text; negative only for a salvage credit (BR-5). */
  amount: string;
  status: Exclude<CostStatus, 'reversed'>;
  sourceModule: string;
  sourceDocType: string;
  sourceDocId: string;
  sourceLineId?: string | null | undefined;
  entryDate: string;
  description?: string | undefined;
  idempotencyKey: string;
  /** The user behind the posting, or null for a system job. */
  actorUserId?: string | null | undefined;
}

export interface EntryQuery {
  status?: CostStatus | undefined;
  costCodeId?: string | undefined;
  limit: number;
  offset: number;
}

export interface CostingService {
  /** BR-5: a repeat with the same idempotency key returns the entry that exists. */
  postCost(entry: PostCostInput, tx: Db): Promise<CostEntryDto>;
  /** BR-6: moves a chain to its next status by appending a row. */
  transitionCost(
    entryId: string,
    toStatus: CostStatus,
    tx: Db,
    actorUserId?: string | null,
  ): Promise<CostEntryDto>;
  reverseCost(
    entryId: string,
    reason: string,
    tx: Db,
    actorUserId?: string | null,
  ): Promise<CostEntryDto>;
  getCostSummary(db: Db, costObject: CostObjectRef): Promise<CostSummaryDto>;
  listEntries(
    db: Db,
    costObject: CostObjectRef,
    query: EntryQuery,
  ): Promise<PageResult<CostEntryDto>>;
}

const entryOf = (row: EntryRow): CostEntryDto => ({
  id: row.id,
  costObjectType: row.cost_object_type as CostObjectType,
  costObjectId: row.cost_object_id,
  costCodeId: row.cost_code_id,
  amount: row.amount,
  status: row.status as CostStatus,
  sourceModule: row.source_module,
  sourceDocType: row.source_doc_type,
  sourceDocId: row.source_doc_id,
  sourceLineId: row.source_line_id,
  entryDate: row.entry_date,
  description: row.description,
  idempotencyKey: row.idempotency_key,
  reversesEntryId: row.reverses_entry_id,
  createdAt: row.created_at.toISOString(),
});

const ZERO: StatusTotals = { committed: '0.00', approved: '0.00', posted: '0.00' };

export function createCostingService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'getCostCode'>;
}): CostingService {
  const { platform, clock, newId } = deps;
  const record = createRecorder(platform);

  const announce = (tx: Db, by: string | null, row: EntryRow, action: string) => {
    const actor: Recorded = { userId: by, requestId: null };
    return record(tx, actor, {
      action: `projects.cost.${action}`,
      entityType: 'prj_cost_entry',
      entityId: row.id,
      after: entryOf(row),
      event: {
        type: 'projects.cost.changed',
        payload: {
          entryId: row.id,
          costObjectType: row.cost_object_type,
          costObjectId: row.cost_object_id,
          status: row.status,
          action,
        },
      },
    });
  };

  /** Appends the next row of a chain: the same source line and amount in the new status. */
  const append = async (
    tx: Db,
    entry: EntryRow,
    to: CostStatus,
    description: string,
    by: string | null,
  ): Promise<CostEntryDto> => {
    const key = `transition:${entry.id}:${to}`;
    const repeat = await findEntryByKey(tx, key);
    if (repeat !== undefined) return entryOf(repeat);
    assertLatestInChain((await latestInChain(tx, entry.chain_key))?.id === entry.id);
    assertCostTransition(entry.status as CostStatus, to);
    const row = await insertEntry(tx, {
      id: newId(),
      costObjectType: entry.cost_object_type,
      costObjectId: entry.cost_object_id,
      costCodeId: entry.cost_code_id,
      amount: entry.amount,
      status: to,
      sourceModule: entry.source_module,
      sourceDocType: entry.source_doc_type,
      sourceDocId: entry.source_doc_id,
      sourceLineId: entry.source_line_id,
      chainKey: entry.chain_key,
      entryDate: BusinessDate.today(clock).toString(),
      description,
      idempotencyKey: key,
      reversesEntryId: to === 'reversed' ? entry.id : null,
      createdBy: by,
      createdAt: clock.now(),
    });
    await announce(tx, by, row, to === 'reversed' ? 'reverse' : 'transition');
    return entryOf(row);
  };

  const transition = async (
    tx: Db,
    entryId: string,
    to: CostStatus,
    description: string | null,
    by: string | null,
  ): Promise<CostEntryDto> => {
    const entry = assertFound(await findEntry(tx, entryId), 'cost_entry');
    return append(tx, entry, to, description ?? entry.description, by);
  };

  return {
    async postCost(input, tx) {
      const repeat = await findEntryByKey(
        tx,
        requiredText(input.idempotencyKey, 'idempotency_key'),
      );
      if (repeat !== undefined) return entryOf(repeat);
      const sourceModule = requiredText(input.sourceModule, 'source_module');
      const sourceDocType = requiredText(input.sourceDocType, 'source_doc_type');
      const amount = normalizeAmount(input.amount);
      assertAmountAllowed(amount, sourceDocType);
      const { type, id } = input.costObject;
      const project = type === 'project' && id !== null ? await findProject(tx, id) : undefined;
      assertCostObjectOpen({
        type,
        id,
        workOrdersEnabled:
          (await platform.settings.get(tx, projectSettingKeys.workOrdersEnabled)).value === true,
        projectStatus: project === undefined ? null : (project.status as ProjectStatus),
      });
      assertCostCodeActive((await deps.masterData.getCostCode(tx, input.costCodeId)).active);
      const key = chainKey(
        sourceModule,
        sourceDocType,
        input.sourceDocId,
        input.sourceLineId ?? null,
      );
      assertChainFree((await latestInChain(tx, key))?.status);
      const by = input.actorUserId ?? null;
      const row = await insertEntry(tx, {
        id: newId(),
        costObjectType: type,
        costObjectId: id,
        costCodeId: input.costCodeId,
        amount,
        status: input.status,
        sourceModule,
        sourceDocType,
        sourceDocId: input.sourceDocId,
        sourceLineId: input.sourceLineId ?? null,
        chainKey: key,
        entryDate: BusinessDate.parse(input.entryDate).toString(),
        description: textOrNull(input.description) ?? '',
        idempotencyKey: input.idempotencyKey,
        reversesEntryId: null,
        createdBy: by,
        createdAt: clock.now(),
      });
      await announce(tx, by, row, 'post');
      return entryOf(row);
    },

    transitionCost: (entryId, toStatus, tx, actorUserId = null) =>
      transition(tx, entryId, toStatus, null, actorUserId),

    async reverseCost(entryId, reason, tx, actorUserId = null) {
      return transition(tx, entryId, 'reversed', requiredText(reason, 'reason'), actorUserId);
    },

    async getCostSummary(db, costObject) {
      const rows = await summaryRows(db, costObject.type, costObject.id);
      const isProject = costObject.type === 'project' && costObject.id !== null;
      const budgets = new Map(
        (isProject ? await budgetByCode(db, costObject.id as string) : []).map((row) => [
          row.cost_code_id,
          row.budget,
        ]),
      );
      const warning = Number(
        (await platform.settings.get(db, projectSettingKeys.budgetWarningPercent)).value,
      );
      const spent = new Map(rows.map((row) => [row.cost_code_id, row]));
      const codes = [...new Set([...spent.keys(), ...budgets.keys()])].sort();
      const lines: CostSummaryLineDto[] = codes.map((costCodeId) => {
        const totals = spent.get(costCodeId) ?? ZERO;
        const checked = isProject
          ? budgetVariance(budgets.get(costCodeId) ?? '0', totals, warning)
          : null;
        return {
          costCodeId,
          committed: totals.committed,
          approved: totals.approved,
          posted: totals.posted,
          budget: checked?.budget ?? null,
          variance: checked?.variance ?? null,
          flag: checked?.flag ?? null,
        };
      });
      const totals = addTotals(lines);
      const overall = isProject
        ? budgetVariance(sumAmounts([...budgets.values()]), totals, warning)
        : null;
      return {
        costObjectType: costObject.type,
        costObjectId: costObject.id,
        lines,
        totals,
        budget: overall?.budget ?? null,
        variance: overall?.variance ?? null,
        flag: overall?.flag ?? null,
      };
    },

    async listEntries(db, costObject, query) {
      const { rows, total } = await listEntries(db, {
        costObjectType: costObject.type,
        costObjectId: costObject.id,
        ...query,
      });
      return pageOf(rows.map(entryOf), total, query);
    },
  };
}

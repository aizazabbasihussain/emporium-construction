import {
  approvalAmount,
  assertCopyable,
  assertEditable,
  assertInternallyApproved,
  assertTransition,
  atRisk,
  budgetLines,
  checkClientApproval,
  currentContractValue,
  impactTotals,
  isOpenStatus,
  normalizeLines,
  variationNumber,
  type AtRisk,
  type LedgerRow,
  type LineInput,
  type VariationStatus,
} from '@emporium/domain/variations';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import { variationDocType, variationEntityType } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Files } from '../../files/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import {
  assertApplied,
  assertCostCodeActive,
  assertFound,
  assertProjectActive,
  assertProjectReachable,
  assertUpdated,
} from '../policy/variations.policy.js';
import {
  findVariation,
  insertHistory,
  insertVariation,
  listApproved,
  listHistory,
  listLineCodes,
  listLines,
  nextSeq,
  replaceLines,
  searchVariations,
  softDeleteVariation,
  updateVariation,
  type VariationRow,
} from '../repo/variations.repo.js';
import type {
  Actor,
  ContractValueDto,
  Db,
  PageResult,
  VariationDto,
  VariationHeaderDto,
} from '../types.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

export interface VariationInput {
  title: string;
  reason?: string | undefined;
  discoveredOn: string;
  lines: LineInput[];
}

export interface ClientApproveInput {
  /** BR-4: the client's reference, the date they approved and (as a file) their document. */
  reference: string;
  approvedOn: string;
}

export interface VariationQuery {
  status?: VariationStatus | undefined;
  limit: number;
  offset: number;
}

export interface VariationService {
  /** Module interface `listApprovedVariations(projectId)` (spec section 2). */
  listApproved(db: Db, projectId: string): Promise<VariationHeaderDto[]>;
  /** Module interface `getCurrentContractValue(projectId)` (spec section 2, BR-5). */
  contractValue(db: Db, projectId: string): Promise<ContractValueDto>;
  list(
    db: Db,
    projectId: string,
    query: VariationQuery,
    actor: Actor,
  ): Promise<PageResult<VariationHeaderDto>>;
  get(db: Db, id: string, actor: Actor): Promise<VariationDto>;
  create(projectId: string, input: VariationInput, actor: Actor, tx: Db): Promise<VariationDto>;
  update(
    id: string,
    input: VariationInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<VariationDto>;
  remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** BR-3 */
  submitInternal(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<VariationDto>;
  /** BR-3 */
  sendToClient(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<VariationDto>;
  /** BR-4, BR-5 */
  clientApprove(
    id: string,
    input: ClientApproveInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<VariationDto>;
  clientReject(
    id: string,
    reason: string,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<VariationDto>;
  cancel(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<VariationDto>;
  /** BR-7: a new draft copied from a variation the client rejected. */
  copy(id: string, actor: Actor, tx: Db): Promise<VariationDto>;
  /** Whether a variation exists, for the file access rule. */
  exists(db: Db, id: string): Promise<boolean>;
}

const headerOf = (row: VariationRow, atRiskTotal: string): VariationHeaderDto => ({
  id: row.id,
  projectId: row.project_id,
  number: row.number,
  title: row.title,
  reason: row.reason,
  discoveredOn: row.discovered_on,
  status: row.status as VariationStatus,
  priceImpact: row.price_impact,
  costImpact: row.cost_impact,
  clientApprovalRef: row.client_approval_ref,
  clientApprovedOn: row.client_approved_on,
  copiedFromId: row.copied_from_id,
  atRiskTotal,
  version: row.version,
});

export function createVariationService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject' | 'addBudgetLine' | 'costing'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getCostCode'>;
  files: Pick<Files, 'list'>;
  /** How many ledger rows are read at a time (tests use a small page). */
  ledgerPageSize?: number;
}): VariationService {
  const { platform, clock, newId, projects, approvals, masterData, files } = deps;
  const pageSize = deps.ledgerPageSize ?? 500;
  const record = createRecorder(platform);

  const changed = (row: VariationRow, change: string) => ({
    type: 'variations.variation.changed',
    payload: {
      variationId: row.id,
      projectId: row.project_id,
      number: row.number,
      status: row.status,
      change,
    },
  });

  const summaryOf = (row: VariationRow, lineCount: number) => ({
    number: row.number,
    status: row.status,
    priceImpact: row.price_impact,
    costImpact: row.cost_impact,
    lines: lineCount,
  });

  /** All ledger rows of a project, newest first (the order `atRisk` relies on). */
  async function ledgerOf(db: Db, projectId: string): Promise<LedgerRow[]> {
    const rows: LedgerRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await projects.costing.listEntries(
        db,
        { type: 'project', id: projectId },
        { limit: pageSize, offset },
      );
      rows.push(...page.items);
      if (offset + pageSize >= page.total) return rows;
    }
  }

  /** BR-8: the costs at risk for each of the given variations (all of one project). */
  async function atRisksOf(
    db: Db,
    projectId: string,
    rows: readonly VariationRow[],
  ): Promise<Map<string, AtRisk>> {
    // Decided variations have nothing at risk, so the ledger is read only when one is open.
    const needLedger = rows.some((row) => isOpenStatus(row.status));
    const ledger = needLedger ? await ledgerOf(db, projectId) : [];
    const codes = needLedger
      ? await listLineCodes(
          db,
          rows.map((row) => row.id),
        )
      : [];
    return new Map(
      rows.map((row) => [
        row.id,
        atRisk(
          {
            status: row.status,
            discoveredOn: row.discovered_on,
            costCodeIds: codes.filter((c) => c.variation_id === row.id).map((c) => c.cost_code_id),
          },
          ledger,
        ),
      ]),
    );
  }

  async function dtoOf(db: Db, row: VariationRow): Promise<VariationDto> {
    const risk = (await atRisksOf(db, row.project_id, [row])).get(row.id) as AtRisk;
    const state = await approvals.getApprovalState(db, variationDocType, row.id);
    return {
      ...headerOf(row, risk.total),
      lines: (await listLines(db, row.id)).map((line) => ({
        lineNo: line.line_no,
        description: line.description,
        costCodeId: line.cost_code_id,
        costAmount: line.cost_amount,
        priceAmount: line.price_amount,
      })),
      history: (await listHistory(db, row.id)).map((h) => ({
        fromStatus: h.from_status as VariationStatus | null,
        toStatus: h.to_status as VariationStatus,
        at: h.at.toISOString(),
        changedBy: h.changed_by,
        note: h.note,
      })),
      atRisk: risk,
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  /** BR-2: checks the lines and cost codes and derives the stored fields. */
  async function prepare(db: Db, input: VariationInput) {
    const lines = normalizeLines(input.lines);
    for (const costCodeId of new Set(lines.map((line) => line.costCodeId))) {
      assertCostCodeActive((await masterData.getCostCode(db, costCodeId)).active);
    }
    return {
      values: {
        title: requiredText(input.title, 'title'),
        reason: input.reason?.trim() ?? '',
        discovered_on: BusinessDate.parse(input.discoveredOn).toString(),
        ...impactsOf(lines),
      },
      lines,
    };
  }

  const impactsOf = (lines: ReturnType<typeof normalizeLines>) => {
    const totals = impactTotals(lines);
    return { price_impact: totals.priceImpact, cost_impact: totals.costImpact };
  };

  const lineRows = (lines: ReturnType<typeof normalizeLines>) =>
    lines.map((line) => ({ id: newId(), ...line }));

  /** One status change: the transition table, the row update, the history line. */
  async function moveTo(
    tx: Db,
    row: VariationRow,
    to: VariationStatus,
    values: Record<string, unknown>,
    by: string,
    note: string | null,
  ): Promise<VariationRow> {
    assertTransition(row.status as VariationStatus, to);
    const at = clock.now();
    const next = assertUpdated(
      await updateVariation(tx, row.id, row.version, { status: to, ...values }, by, at),
    );
    await insertHistory(tx, {
      id: newId(),
      variationId: row.id,
      from: row.status,
      to,
      at,
      by,
      note,
    });
    return next;
  }

  /** Locks the row, checks the caller reaches its project and that the version is current. */
  async function withLock(
    tx: Db,
    id: string,
    actor: Actor,
    expectedVersion?: number,
  ): Promise<VariationRow> {
    const row = assertFound(await findVariation(tx, id, true), 'variation');
    assertProjectReachable(actor, row.project_id);
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  async function insertDraft(
    tx: Db,
    projectId: string,
    projectCode: string,
    input: VariationInput,
    actor: Actor,
    copiedFromId: string | null,
    change: string,
  ): Promise<VariationDto> {
    const { values, lines } = await prepare(tx, input);
    const seq = await nextSeq(tx, projectId);
    const id = newId();
    const now = clock.now();
    const row = await insertVariation(
      tx,
      {
        id,
        project_id: projectId,
        seq,
        number: variationNumber(projectCode, seq),
        copied_from_id: copiedFromId,
        ...values,
      },
      actor.userId,
      now,
    );
    await replaceLines(tx, id, lineRows(lines));
    await insertHistory(tx, {
      id: newId(),
      variationId: id,
      from: null,
      to: 'draft',
      at: now,
      by: actor.userId,
      note: copiedFromId === null ? null : 'copied from a rejected variation',
    });
    await record(tx, actor, {
      action: `variations.variation.${change}`,
      entityType: 'var_variation',
      entityId: id,
      after: summaryOf(row, lines.length),
      event: changed(row, change === 'copy' ? 'copied' : 'created'),
    });
    return dtoOf(tx, row);
  }

  /** BR-5: the original value plus the price impacts of the client-approved variations. */
  async function contractValueOf(db: Db, projectId: string): Promise<ContractValueDto> {
    const project = await projects.getProject(db, projectId);
    const approved = await listApproved(db, projectId);
    const impacts = approved.map((row) => row.price_impact);
    return {
      projectId,
      originalContractValue: project.originalContractValue,
      approvedPriceImpact: currentContractValue('0', impacts),
      currentContractValue: currentContractValue(project.originalContractValue, impacts),
      approvedVariations: approved.length,
    };
  }

  return {
    async listApproved(db, projectId) {
      return (await listApproved(db, projectId)).map((row) => headerOf(row, '0.00'));
    },

    contractValue: contractValueOf,

    async list(db, projectId, query, actor) {
      assertProjectReachable(actor, projectId);
      await projects.getProject(db, projectId);
      const { rows, total } = await searchVariations(db, { projectId, ...query });
      const risks = await atRisksOf(db, projectId, rows);
      return pageOf(
        rows.map((row) => headerOf(row, (risks.get(row.id) as AtRisk).total)),
        total,
        query,
      );
    },

    async get(db, id, actor) {
      const row = assertFound(await findVariation(db, id), 'variation');
      assertProjectReachable(actor, row.project_id);
      return dtoOf(db, row);
    },

    async exists(db, id) {
      return (await findVariation(db, id)) !== undefined;
    },

    async create(projectId, input, actor, tx) {
      assertProjectReachable(actor, projectId);
      const project = await projects.getProject(tx, projectId);
      assertProjectActive(project.status);
      return insertDraft(tx, projectId, project.code, input, actor, null, 'create');
    },

    async update(id, input, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertEditable(existing.status as VariationStatus);
      const { values, lines } = await prepare(tx, input);
      const before = summaryOf(existing, (await listLines(tx, id)).length);
      const row = assertUpdated(
        await updateVariation(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await replaceLines(tx, id, lineRows(lines));
      await record(tx, actor, {
        action: 'variations.variation.update',
        entityType: 'var_variation',
        entityId: id,
        before,
        after: summaryOf(row, lines.length),
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row);
    },

    async remove(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertEditable(existing.status as VariationStatus);
      assertApplied(await softDeleteVariation(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'variations.variation.delete',
        entityType: 'var_variation',
        entityId: id,
        before: summaryOf(existing, (await listLines(tx, id)).length),
        event: changed(existing, 'deleted'),
      });
    },

    async submitInternal(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as VariationStatus, 'pending_internal_approval');
      // BR-3: the engine always runs; no matching rule is an error raised by the engine.
      await approvals.requestApproval(
        {
          docType: variationDocType,
          docId: id,
          amount: approvalAmount(existing.price_impact),
          requesterId: actor.userId,
          context: {
            number: existing.number,
            title: existing.title,
            projectId: existing.project_id,
            priceImpact: existing.price_impact,
            costImpact: existing.cost_impact,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(tx, existing, 'pending_internal_approval', {}, actor.userId, null);
      await record(tx, actor, {
        action: 'variations.variation.submit-internal',
        entityType: 'var_variation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'submitted_internally'),
      });
      return dtoOf(tx, row);
    },

    async sendToClient(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as VariationStatus, 'submitted_to_client');
      assertInternallyApproved((await approvals.getApprovalState(tx, variationDocType, id)).status);
      const row = await moveTo(tx, existing, 'submitted_to_client', {}, actor.userId, null);
      await record(tx, actor, {
        action: 'variations.variation.send-to-client',
        entityType: 'var_variation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'sent_to_client'),
      });
      return dtoOf(tx, row);
    },

    async clientApprove(id, input, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as VariationStatus, 'client_approved');
      const proof = checkClientApproval(
        {
          reference: input.reference,
          approvedOn: input.approvedOn,
          hasDocument: (await files.list(tx, actor, variationEntityType, id)).length > 0,
        },
        BusinessDate.today(clock),
      );
      const row = await moveTo(
        tx,
        existing,
        'client_approved',
        { client_approval_ref: proof.reference, client_approved_on: proof.approvedOn },
        actor.userId,
        proof.reference,
      );
      // BR-5: the status change above is the guard, so the budget lines are added exactly once.
      for (const line of budgetLines(row.number, await listLines(tx, id).then(toLines))) {
        await projects.addBudgetLine(row.project_id, line, tx, {
          userId: actor.userId,
          requestId: actor.requestId,
        });
      }
      const contract = await contractValueOf(tx, row.project_id);
      await record(tx, actor, {
        action: 'variations.variation.client-approve',
        entityType: 'var_variation',
        entityId: id,
        before: { status: existing.status },
        after: {
          status: row.status,
          clientApprovalRef: proof.reference,
          clientApprovedOn: proof.approvedOn,
          currentContractValue: contract.currentContractValue,
        },
        event: {
          type: 'variation.approved',
          payload: {
            variationId: id,
            projectId: row.project_id,
            number: row.number,
            priceImpact: row.price_impact,
            costImpact: row.cost_impact,
            clientApprovedOn: proof.approvedOn,
            currentContractValue: contract.currentContractValue,
          },
        },
      });
      return dtoOf(tx, row);
    },

    async clientReject(id, reason, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as VariationStatus, 'client_rejected');
      const text = requiredText(reason, 'reason');
      const row = await moveTo(tx, existing, 'client_rejected', {}, actor.userId, text);
      await record(tx, actor, {
        action: 'variations.variation.client-reject',
        entityType: 'var_variation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, reason: text },
        event: {
          type: 'variation.rejected',
          payload: {
            variationId: id,
            projectId: row.project_id,
            number: row.number,
            priceImpact: row.price_impact,
            reason: text,
          },
        },
      });
      return dtoOf(tx, row);
    },

    async cancel(id, expectedVersion, actor, tx) {
      const existing = await withLock(tx, id, actor, expectedVersion);
      assertTransition(existing.status as VariationStatus, 'cancelled');
      if (existing.status === 'pending_internal_approval') {
        await approvals.cancelApproval(
          {
            docType: variationDocType,
            docId: id,
            reason: 'The variation was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      const row = await moveTo(tx, existing, 'cancelled', {}, actor.userId, null);
      await record(tx, actor, {
        action: 'variations.variation.cancel',
        entityType: 'var_variation',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status },
        event: changed(row, 'cancelled'),
      });
      return dtoOf(tx, row);
    },

    async copy(id, actor, tx) {
      const source = await withLock(tx, id, actor);
      assertCopyable(source.status as VariationStatus);
      const project = await projects.getProject(tx, source.project_id);
      assertProjectActive(project.status);
      return insertDraft(
        tx,
        source.project_id,
        project.code,
        {
          title: source.title,
          reason: textOrNull(source.reason) ?? undefined,
          discoveredOn: source.discovered_on,
          lines: (await listLines(tx, id)).map((line) => ({
            description: line.description,
            costCodeId: line.cost_code_id,
            costAmount: line.cost_amount,
            priceAmount: line.price_amount,
          })),
        },
        actor,
        source.id,
        'copy',
      );
    },
  };
}

const toLines = (
  rows: Awaited<ReturnType<typeof listLines>>,
): { lineNo: number; description: string; costCodeId: string; costAmount: string }[] =>
  rows.map((row) => ({
    lineNo: row.line_no,
    description: row.description,
    costCodeId: row.cost_code_id,
    costAmount: row.cost_amount,
  }));

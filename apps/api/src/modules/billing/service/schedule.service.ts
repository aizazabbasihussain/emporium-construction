import {
  applyScheduleEdit,
  assertScheduleMatchesContract,
  nextStageNo,
  scheduleFromQuotation,
  scheduleTotal,
  variationStage,
  type PlannedStage,
  type ScheduleEditStage,
  type ScheduleStage,
} from '@emporium/domain/billing';
import { Money, type Clock } from '@emporium/domain/kernel';
import { RuleViolationError } from '@emporium/domain';
import { scheduleDocType, type ScheduleSource, type ScheduleStatus } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../../projects/index.js';
import type { Quotations } from '../../quotations/index.js';
import type { Variations } from '../../variations/index.js';
import { assertNoPendingScheduleEdit, assertProjectReachable } from '../policy/billing.policy.js';
import {
  decideEdit,
  deletePlannedStages,
  findEdit,
  insertEdit,
  insertStage,
  listStages,
  pendingEditId,
  stagesOnLiveInvoices,
  type StageRow,
} from '../repo/billing.repo.js';
import type { Actor, Db, ScheduleDto } from '../types.js';
import { createRecorder, type Recorded } from './support.js';

export interface ScheduleService {
  /**
   * BR-1: builds the schedule from the accepted quotation (once) and adds one stage for each
   * approved variation that has none. Idempotent, so events and commands may both call it.
   */
  sync(tx: Db, projectId: string, by: Recorded): Promise<void>;
  get(db: Db, projectId: string, actor: Actor): Promise<ScheduleDto>;
  /** BR-1: replaces the planned stages; the change waits for the owner's approval. */
  edit(projectId: string, stages: ScheduleEditStage[], actor: Actor, tx: Db): Promise<ScheduleDto>;
  /** The approval engine's decision on a manual edit; replays are ignored. */
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
  /** BR-1: no edit pending and the stages add up to the current contract value; returns that value. */
  assertReadyToBill(db: Db, projectId: string): Promise<string>;
  /** The contract value still unbilled: the planned stages (BR-3). */
  plannedTotal(db: Db, projectId: string): Promise<string>;
}

const toDto = (row: StageRow) => ({
  id: row.id,
  stageNo: row.stage_no,
  name: row.name,
  basisPercent: row.basis_percent,
  amount: row.amount,
  source: row.source as ScheduleSource,
  sourceId: row.source_id,
  status: row.status as ScheduleStatus,
});

export function createScheduleService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject'>;
  variations: Pick<Variations, 'getCurrentContractValue' | 'listApprovedVariations'>;
  quotations: Pick<Quotations, 'getQuotation'>;
  approvals: Pick<Approvals, 'requestApproval'>;
}): ScheduleService {
  const { platform, clock, newId, projects, variations, quotations, approvals } = deps;
  const record = createRecorder(platform);

  const insert = (tx: Db, projectId: string, stage: ScheduleStage, by: Recorded, id = newId()) =>
    insertStage(
      tx,
      {
        id,
        project_id: projectId,
        stage_no: stage.stageNo,
        name: stage.name,
        basis_percent: stage.basisPercent,
        amount: stage.amount,
        source: stage.source,
        source_id: stage.sourceId,
      },
      by.userId,
      clock.now(),
    );

  async function sync(tx: Db, projectId: string, by: Recorded): Promise<void> {
    const project = await projects.getProject(tx, projectId);
    let stages = await listStages(tx, projectId);
    if (stages.length === 0 && project.quotationId !== null) {
      const quotation = await quotations.getQuotation(tx, project.quotationId);
      for (const stage of scheduleFromQuotation(project.originalContractValue, quotation.stages)) {
        await insert(tx, projectId, stage, by);
      }
      stages = await listStages(tx, projectId);
    }
    const known = new Set(stages.map((stage) => stage.source_id));
    let stageNo = nextStageNo(stages.map((stage) => ({ stageNo: stage.stage_no })));
    for (const variation of await variations.listApprovedVariations(tx, projectId)) {
      if (known.has(variation.id)) continue;
      await insert(
        tx,
        projectId,
        variationStage({
          stageNo: stageNo++,
          number: variation.number,
          priceImpact: variation.priceImpact,
          variationId: variation.id,
        }),
        by,
      );
    }
  }

  async function get(db: Db, projectId: string): Promise<ScheduleDto> {
    const project = await projects.getProject(db, projectId);
    const contractValue = await variations.getCurrentContractValue(db, projectId);
    const rows = await listStages(db, projectId);
    const total = scheduleTotal(rows);
    return {
      projectId,
      originalContractValue: project.originalContractValue,
      contractValue,
      scheduleTotal: total,
      matchesContract: Money.of(total).equals(Money.of(contractValue)),
      pendingEditId: await pendingEditId(db, projectId),
      stages: rows.map(toDto),
    };
  }

  return {
    sync,

    async get(db, projectId, actor) {
      assertProjectReachable(actor, projectId);
      return get(db, projectId);
    },

    async edit(projectId, stages, actor, tx) {
      assertProjectReachable(actor, projectId);
      assertNoPendingScheduleEdit(await pendingEditId(tx, projectId));
      await sync(tx, projectId, actor);
      const all = await listStages(tx, projectId);
      const planned = all.filter((row) => row.status === 'planned');
      const taken = await stagesOnLiveInvoices(
        tx,
        planned.map((row) => row.id),
        null,
      );
      if (taken.length > 0) {
        throw new RuleViolationError(
          'stage_in_use',
          'A planned stage is on an invoice; cancel that invoice before changing the schedule',
        );
      }
      const next = applyScheduleEdit(
        planned.map((row): PlannedStage => ({
          id: row.id,
          stageNo: row.stage_no,
          name: row.name,
          basisPercent: row.basis_percent,
          amount: row.amount,
          source: row.source as ScheduleSource,
          sourceId: row.source_id,
        })),
        all.filter((row) => row.status !== 'planned').map((row) => row.stage_no),
        stages,
      );
      const editId = newId();
      await insertEdit(tx, {
        id: editId,
        projectId,
        previous: planned.map((row) => ({
          id: row.id,
          stageNo: row.stage_no,
          name: row.name,
          basisPercent: row.basis_percent,
          amount: row.amount,
          source: row.source,
          sourceId: row.source_id,
        })),
        by: actor.userId,
        at: clock.now(),
      });
      await deletePlannedStages(tx, projectId);
      for (const stage of next) await insert(tx, projectId, stage, actor);
      const contractValue = await variations.getCurrentContractValue(tx, projectId);
      await approvals.requestApproval(
        {
          docType: scheduleDocType,
          docId: editId,
          amount: contractValue,
          requesterId: actor.userId,
          context: { projectId, stages: next.length },
          requestId: actor.requestId,
        },
        tx,
      );
      await record(tx, actor, {
        action: 'billing.schedule.edit',
        entityType: 'bil_schedule_edit',
        entityId: editId,
        before: { stages: planned.length },
        after: { stages: next.length },
        event: {
          type: 'billing.schedule.changed',
          payload: { projectId, editId, change: 'edited' },
        },
      });
      return get(tx, projectId);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const edit = await findEdit(tx, payload.docId);
      if (edit === undefined || edit.status !== 'pending_approval') return;
      const system: Recorded = { userId: null, requestId: null };
      if (outcome === 'approved') {
        await decideEdit(tx, edit.id, 'approved', clock.now());
      } else {
        await deletePlannedStages(tx, edit.project_id);
        for (const previous of edit.previous) {
          await insert(
            tx,
            edit.project_id,
            { ...previous, source: previous.source as ScheduleSource },
            system,
            previous.id,
          );
        }
        await decideEdit(tx, edit.id, 'rejected', clock.now());
        await sync(tx, edit.project_id, system);
      }
      await record(tx, system, {
        action: `billing.schedule.${outcome}`,
        entityType: 'bil_schedule_edit',
        entityId: edit.id,
        after: { status: outcome === 'approved' ? 'approved' : 'rejected' },
        event: {
          type: 'billing.schedule.changed',
          payload: { projectId: edit.project_id, editId: edit.id, change: outcome },
        },
      });
    },

    async assertReadyToBill(db, projectId) {
      assertNoPendingScheduleEdit(await pendingEditId(db, projectId));
      const contractValue = await variations.getCurrentContractValue(db, projectId);
      assertScheduleMatchesContract(await listStages(db, projectId), contractValue);
      return contractValue;
    },

    async plannedTotal(db, projectId) {
      return scheduleTotal(
        (await listStages(db, projectId)).filter((row) => row.status === 'planned'),
      );
    },
  };
}

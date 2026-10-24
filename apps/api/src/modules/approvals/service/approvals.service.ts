import { ConflictError, NotFoundError, RuleViolationError } from '@emporium/domain';
import {
  assertOpen,
  decide,
  selectBand,
  type ApprovalActionType,
  type RequestStatus,
} from '@emporium/domain/approvals';
import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import type { Platform } from '../../platform/index.js';
import { assertInScope, assertMayRead, isInboxVisible } from '../policy/approvals.policy.js';
import {
  findLatestRequest,
  findOpenRequest,
  findRequest,
  insertAction,
  insertRequest,
  listActions,
  listPendingRequests,
  listStepsOfRules,
  maxRevision,
  selectRulesInForce,
  updateRequestState,
  type ActionRow,
  type RequestRow,
  type StepRow,
} from '../repo/approvals.repo.js';
import type {
  Actor,
  ApprovalState,
  Db,
  RequestApprovalInput,
  RequestDto,
  StepDto,
} from '../types.js';

export interface ApprovalsService {
  /** Routes a document to approval (BR-1, BR-6). Runs in the caller's transaction. */
  requestApproval(input: RequestApprovalInput, tx: Db): Promise<RequestDto>;
  getApprovalState(db: Db, docType: string, docId: string): Promise<ApprovalState>;
  /** BR-5: cancels the open request of a document; returns null when there is none. */
  cancelApproval(
    input: {
      docType: string;
      docId: string;
      reason: string;
      actorUserId: string;
      requestId?: string | null;
    },
    tx: Db,
  ): Promise<RequestDto | null>;
  act(
    requestId: string,
    action: ApprovalActionType,
    input: { comment: string | null; expectedVersion?: number | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<RequestDto>;
  inbox(db: Db, actor: Actor): Promise<RequestDto[]>;
  getRequest(db: Db, id: string, actor: Actor, canManage: boolean): Promise<RequestDto>;
}

const toStep = (s: StepRow): StepDto => ({
  stepNo: s.step_no,
  roleCode: s.role_code,
  minApprovers: s.min_approvers,
});

export function toRequestDto(
  row: RequestRow,
  steps: readonly StepRow[],
  actions: readonly ActionRow[],
): RequestDto {
  const current = steps.find((s) => s.step_no === row.current_step) as StepRow;
  return {
    id: row.id,
    docType: row.doc_type,
    docId: row.doc_id,
    revision: row.revision,
    amount: row.amount,
    requesterId: row.requester_id,
    status: row.status,
    currentStep: row.current_step,
    currentRole: row.status === 'pending' ? current.role_code : null,
    ruleId: row.rule_id,
    context: row.context,
    submittedAt: row.submitted_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    version: row.version,
    steps: steps.map(toStep),
    actions: actions.map((a) => ({
      stepNo: a.step_no,
      actorId: a.actor_id,
      action: a.action,
      comment: a.comment,
      at: a.at.toISOString(),
    })),
  };
}

export function createApprovalsService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
}): ApprovalsService {
  const { platform, clock, newId } = deps;

  async function load(db: Db, row: RequestRow): Promise<RequestDto> {
    const [steps, actions] = await Promise.all([
      listStepsOfRules(db, [row.rule_id]),
      listActions(db, row.id),
    ]);
    return toRequestDto(row, steps, actions);
  }

  const payloadOf = (row: RequestRow, status: RequestStatus) => ({
    requestId: row.id,
    docType: row.doc_type,
    docId: row.doc_id,
    revision: row.revision,
    amount: row.amount,
    requesterId: row.requester_id,
    status,
  });

  async function record(
    tx: Db,
    params: {
      actorUserId: string;
      requestId: string | null;
      action: string;
      row: RequestRow;
      status: RequestStatus;
      eventType: string;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await platform.audit.record(
      {
        actorUserId: params.actorUserId,
        action: params.action,
        entityType: 'approval_request',
        entityId: params.row.id,
        before: { status: params.row.status, currentStep: params.row.current_step },
        after: { ...payloadOf(params.row, params.status), ...params.detail },
        requestId: params.requestId,
      },
      tx,
    );
    await platform.events.publish(
      { type: params.eventType, payload: payloadOf(params.row, params.status) },
      tx,
    );
  }

  return {
    async requestApproval(input, tx) {
      if (await findOpenRequest(tx, input.docType, input.docId)) {
        throw new ConflictError(
          'open_request_exists',
          'This document already has an approval request in progress',
        );
      }
      const today = BusinessDate.today(clock).toString();
      const rules = await selectRulesInForce(tx, input.docType, today);
      const band = selectBand(
        rules.map((r) => ({ id: r.id, minAmount: r.min_amount, maxAmount: r.max_amount })),
        input.amount,
      );
      if (band === undefined) {
        throw new RuleViolationError(
          'no_approval_rule',
          `No approval rule covers ${input.docType} of ${input.amount}; ask an administrator to set one`,
          { docType: input.docType, amount: input.amount },
        );
      }
      const id = newId();
      const at = clock.now();
      await insertRequest(tx, {
        id,
        docType: input.docType,
        docId: input.docId,
        revision: (await maxRevision(tx, input.docType, input.docId)) + 1,
        amount: input.amount,
        requesterId: input.requesterId,
        ruleId: band.id,
        context: input.context ?? {},
        at,
        actorUserId: input.requesterId,
      });
      const row = (await findRequest(tx, id)) as RequestRow;
      await record(tx, {
        actorUserId: input.requesterId,
        requestId: input.requestId ?? null,
        action: 'approval.request',
        row,
        status: 'pending',
        eventType: 'approval.requested',
      });
      return load(tx, row);
    },

    async getApprovalState(db, docType, docId) {
      const row = await findLatestRequest(db, docType, docId);
      return row ? load(db, row) : { status: 'none', docType, docId };
    },

    async cancelApproval(input, tx) {
      const row = await findOpenRequest(tx, input.docType, input.docId, true);
      if (!row) return null;
      assertOpen(row.status);
      const at = clock.now();
      await updateRequestState(tx, row.id, {
        status: 'cancelled',
        currentStep: row.current_step,
        decidedAt: at,
        actorUserId: input.actorUserId,
        at,
      });
      await record(tx, {
        actorUserId: input.actorUserId,
        requestId: input.requestId ?? null,
        action: 'approval.cancel',
        row,
        status: 'cancelled',
        eventType: 'approval.cancelled',
        detail: { reason: input.reason },
      });
      return load(tx, (await findRequest(tx, row.id)) as RequestRow);
    },

    async act(requestId, action, { comment, expectedVersion }, actor, tx) {
      const row = await findRequest(tx, requestId, true);
      if (!row) throw new NotFoundError('request_not_found', 'Not found');
      assertInScope(actor, row.context);
      assertOpen(row.status);
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw new ConflictError('version_conflict', 'The request was changed by someone else', {
          expectedVersion,
        });
      }
      const [steps, history] = await Promise.all([
        listStepsOfRules(tx, [row.rule_id]),
        listActions(tx, row.id),
      ]);
      const outcome = decide({
        steps: steps.map(toStep),
        currentStep: row.current_step,
        requesterId: row.requester_id,
        actorId: actor.userId,
        actorRoles: actor.roles,
        action,
        comment,
        history: history.map((h) => ({ stepNo: h.step_no, actorId: h.actor_id, action: h.action })),
      });
      const at = clock.now();
      const note = comment?.trim() || null;
      await insertAction(tx, {
        id: newId(),
        requestId: row.id,
        stepNo: row.current_step,
        actorId: actor.userId,
        action,
        comment: note,
        at,
      });
      const final = outcome.status !== 'pending';
      await updateRequestState(tx, row.id, {
        status: outcome.status,
        currentStep: outcome.currentStep,
        decidedAt: final ? at : null,
        actorUserId: actor.userId,
        at,
      });
      const eventType = final ? `approval.${outcome.status}` : 'approval.step_approved';
      await record(tx, {
        actorUserId: actor.userId,
        requestId: actor.requestId,
        action: `approval.${action}`,
        row,
        status: outcome.status,
        eventType,
        detail: { stepNo: row.current_step, comment: note },
      });
      return load(tx, (await findRequest(tx, row.id)) as RequestRow);
    },

    async inbox(db, actor) {
      const pending = await listPendingRequests(db);
      const stepsByRule = new Map<string, StepRow[]>();
      const ruleIds = [...new Set(pending.map((r) => r.rule_id))];
      for (const step of await listStepsOfRules(db, ruleIds)) {
        stepsByRule.set(step.rule_id, [...(stepsByRule.get(step.rule_id) ?? []), step]);
      }
      const items: RequestDto[] = [];
      for (const row of pending) {
        const steps = stepsByRule.get(row.rule_id) as StepRow[];
        const dto = toRequestDto(row, steps, []);
        if (!isInboxVisible(actor, { ...dto })) continue;
        const actions = await listActions(db, row.id);
        if (actions.some((a) => a.actor_id === actor.userId && a.action === 'approve')) continue;
        items.push({ ...dto, actions: toRequestDto(row, steps, actions).actions });
      }
      return items;
    },

    async getRequest(db, id, actor, canManage) {
      const row = await findRequest(db, id);
      if (!row) throw new NotFoundError('request_not_found', 'Not found');
      const dto = await load(db, row);
      assertMayRead(
        actor,
        {
          requesterId: dto.requesterId,
          stepRoles: dto.steps.map((s) => s.roleCode),
          context: dto.context,
        },
        canManage,
      );
      return dto;
    },
  };
}

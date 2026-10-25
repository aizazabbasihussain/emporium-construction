import { BusinessDate, type Clock } from '@emporium/domain/kernel';
import {
  assertPolicyRequest,
  effectiveOnApproval,
  resolvePolicy,
  type Method,
  type PolicyRef,
} from '@emporium/domain/valuation';
import {
  valuationPolicyDocType,
  type PolicyScope,
  type PolicyStatus,
  type ValuationMethod,
} from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Platform } from '../../platform/index.js';
import { assertItemKnown, deciderOf } from '../policy/valuation.policy.js';
import {
  decidePolicy,
  findPolicy,
  insertPolicy,
  listPolicies,
  supersedeSameStart,
  type PolicyRow,
} from '../repo/valuation.repo.js';
import type { Actor, Db, PolicyDto } from '../types.js';
import { createRecorder } from './support.js';

export interface PolicyInput {
  scope: PolicyScope;
  categoryId?: string | null | undefined;
  method: ValuationMethod;
  effectiveFrom: string;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'returned' | 'cancelled';

export interface PoliciesService {
  list(db: Db, status?: PolicyStatus): Promise<PolicyDto[]>;
  /** BR-2, BR-3: records a pending policy and asks the owner to approve it. */
  setPolicy(input: PolicyInput, actor: Actor, tx: Db): Promise<PolicyDto>;
  /** BR-1: the method that applies to an item on a posting date. */
  resolvePolicy(db: Db, itemId: string, date: string): Promise<PolicyRef>;
  /** The item's category and its ancestors, nearest first. */
  categoryChain(db: Db, itemId: string): Promise<string[]>;
  /** Reacts to `approval.*` events of a policy request; a repeat is a no-op. */
  onApprovalOutcome(
    outcome: ApprovalOutcome,
    payload: { docId: string; requesterId: string },
    tx: Db,
  ): Promise<void>;
}

const toDto = (row: PolicyRow): PolicyDto => ({
  id: row.id,
  scope: row.scope as PolicyScope,
  categoryId: row.category_id,
  method: row.method as ValuationMethod,
  effectiveFrom: row.effective_from,
  status: row.status as PolicyStatus,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
  createdAt: row.created_at.toISOString(),
});

const toRef = (row: PolicyRow): PolicyRef => ({
  id: row.id,
  scope: row.scope as PolicyRef['scope'],
  categoryId: row.category_id,
  method: row.method as Method,
  effectiveFrom: row.effective_from,
});

export function createPoliciesService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  masterData: Pick<MasterData, 'getItem' | 'getItemCategory'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): PoliciesService {
  const { platform, clock, newId, masterData, approvals } = deps;
  const record = createRecorder(platform);

  const changed = (row: PolicyRow) => ({
    type: 'valuation.policy.changed',
    payload: {
      policyId: row.id,
      scope: row.scope,
      categoryId: row.category_id,
      method: row.method,
      effectiveFrom: row.effective_from,
      status: row.status,
    },
  });

  async function categoryChain(db: Db, itemId: string): Promise<string[]> {
    const item = assertItemKnown(await masterData.getItem(db, itemId));
    const chain: string[] = [];
    let next = item.categoryId;
    while (next !== null) {
      chain.push(next);
      next = (await masterData.getItemCategory(db, next)).parentId;
    }
    return chain;
  }

  return {
    async list(db, status) {
      return (await listPolicies(db, status)).map(toDto);
    },

    async setPolicy(input, actor, tx) {
      const categoryId = input.categoryId ?? null;
      const today = BusinessDate.today(clock).toString();
      BusinessDate.parse(input.effectiveFrom);
      assertPolicyRequest(
        { scope: input.scope, categoryId, effectiveFrom: input.effectiveFrom },
        today,
      );
      if (categoryId !== null) await masterData.getItemCategory(tx, categoryId);
      const id = newId();
      const row = await insertPolicy(tx, {
        id,
        scope: input.scope,
        categoryId,
        method: input.method,
        effectiveFrom: input.effectiveFrom,
        requestedBy: actor.userId,
        at: clock.now(),
      });
      await approvals.requestApproval(
        {
          docType: valuationPolicyDocType,
          docId: id,
          amount: '0',
          requesterId: actor.userId,
          context: { scope: input.scope, categoryId, method: input.method },
          requestId: actor.requestId,
        },
        tx,
      );
      await record(tx, actor, {
        action: 'valuation.policy.request',
        entityType: 'val_policy',
        entityId: id,
        after: toDto(row),
        event: changed(row),
      });
      return toDto(row);
    },

    categoryChain,

    async resolvePolicy(db, itemId, date) {
      const chain = await categoryChain(db, itemId);
      return resolvePolicy(chain, (await listPolicies(db, 'active')).map(toRef), date);
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const row = await findPolicy(tx, payload.docId, true);
      if (row === undefined || row.status !== 'pending_approval') return;
      const decider = deciderOf(
        await approvals.getApprovalState(tx, valuationPolicyDocType, payload.docId),
      );
      const actor: Actor = { userId: decider ?? payload.requesterId, requestId: null };
      const approved = outcome === 'approved';
      const effectiveFrom = approved
        ? effectiveOnApproval(row.effective_from, BusinessDate.today(clock).toString())
        : row.effective_from;
      if (approved) {
        await supersedeSameStart(tx, {
          id: row.id,
          scope: row.scope,
          categoryId: row.category_id,
          effectiveFrom,
        });
      }
      await decidePolicy(tx, row.id, {
        status: approved ? 'active' : 'rejected',
        effectiveFrom,
        approvedBy: approved ? actor.userId : null,
      });
      const after = (await findPolicy(tx, row.id)) as PolicyRow;
      await record(tx, actor, {
        action: `valuation.policy.${approved ? 'activate' : 'reject'}`,
        entityType: 'val_policy',
        entityId: row.id,
        before: toDto(row),
        after: toDto(after),
        event: changed(after),
      });
    },
  };
}

import type { ApprovalAction, ApprovalStatus } from '@emporium/shared';
import type { Db } from '../types.js';

export interface RuleRow {
  id: string;
  doc_type: string;
  min_amount: string;
  max_amount: string | null;
  effective_from: string;
}

export interface StepRow {
  rule_id: string;
  step_no: number;
  role_code: string;
  min_approvers: number;
}

export interface RequestRow {
  id: string;
  doc_type: string;
  doc_id: string;
  revision: number;
  amount: string;
  requester_id: string;
  status: ApprovalStatus;
  current_step: number;
  rule_id: string;
  context: Record<string, unknown>;
  submitted_at: Date;
  decided_at: Date | null;
  version: number;
}

export interface ActionRow {
  request_id: string;
  step_no: number;
  actor_id: string;
  action: ApprovalAction;
  comment: string | null;
  at: Date;
}

const RULE_COLUMNS = `id, doc_type, min_amount::text as min_amount, max_amount::text as max_amount,
  effective_from::text as effective_from`;
const REQUEST_COLUMNS = `id, doc_type, doc_id, revision, amount::text as amount, requester_id, status,
  current_step, rule_id, context, submitted_at, decided_at, version`;

/** The active rule set (all bands sharing one effective date) in force on `date`: BR-1, BR-8. */
export async function selectRulesInForce(
  db: Db,
  docType: string,
  date: string,
): Promise<RuleRow[]> {
  return db.query<RuleRow>(
    `select ${RULE_COLUMNS} from apr_rules
      where doc_type = $1 and active and deleted_at is null and effective_from = (
        select max(effective_from) from apr_rules
         where doc_type = $1 and active and deleted_at is null and effective_from <= $2::date)
      order by min_amount`,
    [docType, date],
  );
}

/** Every active band of a document type, including rule sets that start in the future. */
export async function listActiveRules(db: Db, docType: string): Promise<RuleRow[]> {
  return db.query<RuleRow>(
    `select ${RULE_COLUMNS} from apr_rules
      where doc_type = $1 and active and deleted_at is null
      order by effective_from, min_amount`,
    [docType],
  );
}

export async function listDocTypes(db: Db): Promise<string[]> {
  const rows = await db.query<{ doc_type: string }>(
    'select distinct doc_type from apr_rules where active and deleted_at is null order by doc_type',
  );
  return rows.map((r) => r.doc_type);
}

export async function listStepsOfRules(db: Db, ruleIds: readonly string[]): Promise<StepRow[]> {
  return db.query<StepRow>(
    `select rule_id, step_no, role_code, min_approvers from apr_rule_steps
      where rule_id = any($1::uuid[]) order by rule_id, step_no`,
    [ruleIds],
  );
}

/** Retires the rule set that starts on `effectiveFrom`; retired rows stay for pending requests (AC-4). */
export async function deactivateRuleSet(
  db: Db,
  params: { docType: string; effectiveFrom: string; actorUserId: string; at: Date },
): Promise<void> {
  await db.query(
    `update apr_rules set active = false, updated_at = $4, updated_by = $3, version = version + 1
      where doc_type = $1 and effective_from = $2::date and active`,
    [params.docType, params.effectiveFrom, params.actorUserId, params.at.toISOString()],
  );
}

export async function insertRule(
  db: Db,
  rule: {
    id: string;
    docType: string;
    minAmount: string;
    maxAmount: string | null;
    effectiveFrom: string;
    actorUserId: string;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `insert into apr_rules
       (id, doc_type, min_amount, max_amount, effective_from, created_at, updated_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5::date, $6, $6, $7, $7)`,
    [
      rule.id,
      rule.docType,
      rule.minAmount,
      rule.maxAmount,
      rule.effectiveFrom,
      rule.at.toISOString(),
      rule.actorUserId,
    ],
  );
}

export async function insertStep(
  db: Db,
  step: { ruleId: string; stepNo: number; roleCode: string; minApprovers: number },
): Promise<void> {
  await db.query(
    `insert into apr_rule_steps (rule_id, step_no, role_code, min_approvers) values ($1, $2, $3, $4)`,
    [step.ruleId, step.stepNo, step.roleCode, step.minApprovers],
  );
}

export async function insertRequest(
  db: Db,
  request: {
    id: string;
    docType: string;
    docId: string;
    revision: number;
    amount: string;
    requesterId: string;
    ruleId: string;
    context: Record<string, unknown>;
    at: Date;
    actorUserId: string;
  },
): Promise<void> {
  await db.query(
    `insert into apr_requests
       (id, doc_type, doc_id, revision, amount, requester_id, current_step, rule_id, context,
        submitted_at, created_at, updated_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8::jsonb, $9, $9, $9, $10, $10)`,
    [
      request.id,
      request.docType,
      request.docId,
      request.revision,
      request.amount,
      request.requesterId,
      request.ruleId,
      JSON.stringify(request.context),
      request.at.toISOString(),
      request.actorUserId,
    ],
  );
}

/** Highest revision of the document, 0 when it was never submitted. */
export async function maxRevision(db: Db, docType: string, docId: string): Promise<number> {
  const rows = await db.query<{ revision: number }>(
    `select coalesce(max(revision), 0)::int as revision from apr_requests
      where doc_type = $1 and doc_id = $2`,
    [docType, docId],
  );
  return rows[0]?.revision ?? 0;
}

export async function findRequest(
  db: Db,
  id: string,
  lock = false,
): Promise<RequestRow | undefined> {
  const rows = await db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from apr_requests where id = $1 and deleted_at is null${lock ? ' for update' : ''}`,
    [id],
  );
  return rows[0];
}

export async function findOpenRequest(
  db: Db,
  docType: string,
  docId: string,
  lock = false,
): Promise<RequestRow | undefined> {
  const rows = await db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from apr_requests
      where doc_type = $1 and doc_id = $2 and status = 'pending' and deleted_at is null${lock ? ' for update' : ''}`,
    [docType, docId],
  );
  return rows[0];
}

export async function findLatestRequest(
  db: Db,
  docType: string,
  docId: string,
): Promise<RequestRow | undefined> {
  const rows = await db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from apr_requests
      where doc_type = $1 and doc_id = $2 and deleted_at is null
      order by revision desc limit 1`,
    [docType, docId],
  );
  return rows[0];
}

export async function listPendingRequests(db: Db): Promise<RequestRow[]> {
  return db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from apr_requests
      where status = 'pending' and deleted_at is null order by submitted_at, id`,
  );
}

export async function updateRequestState(
  db: Db,
  id: string,
  params: {
    status: ApprovalStatus;
    currentStep: number;
    decidedAt: Date | null;
    actorUserId: string;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `update apr_requests
        set status = $2, current_step = $3, decided_at = $4, updated_at = $5, updated_by = $6,
            version = version + 1
      where id = $1`,
    [
      id,
      params.status,
      params.currentStep,
      params.decidedAt?.toISOString() ?? null,
      params.at.toISOString(),
      params.actorUserId,
    ],
  );
}

export async function insertAction(
  db: Db,
  action: {
    id: string;
    requestId: string;
    stepNo: number;
    actorId: string;
    action: ApprovalAction;
    comment: string | null;
    at: Date;
  },
): Promise<void> {
  await db.query(
    `insert into apr_actions (id, request_id, step_no, actor_id, action, comment, at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      action.id,
      action.requestId,
      action.stepNo,
      action.actorId,
      action.action,
      action.comment,
      action.at.toISOString(),
    ],
  );
}

export async function listActions(db: Db, requestId: string): Promise<ActionRow[]> {
  return db.query<ActionRow>(
    `select request_id, step_no, actor_id, action, comment, at from apr_actions
      where request_id = $1 order by at, id`,
    [requestId],
  );
}

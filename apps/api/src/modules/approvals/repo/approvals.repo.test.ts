import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deactivateRuleSet,
  findLatestRequest,
  findOpenRequest,
  findRequest,
  insertAction,
  insertRequest,
  insertRule,
  insertStep,
  listActions,
  listActiveRules,
  listDocTypes,
  listPendingRequests,
  listStepsOfRules,
  maxRevision,
  selectRulesInForce,
  updateRequestState,
} from './approvals.repo.js';

let db: SqlDb;
const id = (n: number) => `018f6666-1111-7000-8000-${String(n).padStart(12, '0')}`;
const user = id(900);
const at = new Date('2026-10-24T10:00:00Z');

const rule = (n: number, over: Partial<Parameters<typeof insertRule>[1]> = {}) => ({
  id: id(n),
  docType: 'sample',
  minAmount: '0',
  maxAmount: null,
  effectiveFrom: '2026-01-01',
  actorUserId: user,
  at,
  ...over,
});

const request = (n: number, over: Partial<Parameters<typeof insertRequest>[1]> = {}) => ({
  id: id(n),
  docType: 'sample',
  docId: id(500),
  revision: 1,
  amount: '1250.50',
  requesterId: user,
  ruleId: id(1),
  context: { scope: { type: 'project', id: id(77) } },
  at,
  actorUserId: user,
  ...over,
});

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe('apr_rules and apr_rule_steps', () => {
  it('stores bands with steps and returns them with text amounts', async () => {
    await insertRule(db, rule(1));
    await insertStep(db, { ruleId: id(1), stepNo: 1, roleCode: 'management', minApprovers: 1 });
    await insertStep(db, { ruleId: id(1), stepNo: 2, roleCode: 'accountant', minApprovers: 2 });
    expect(await listActiveRules(db, 'sample')).toEqual([
      {
        id: id(1),
        doc_type: 'sample',
        min_amount: '0.00',
        max_amount: null,
        effective_from: '2026-01-01',
      },
    ]);
    expect(await listStepsOfRules(db, [id(1)])).toEqual([
      { rule_id: id(1), step_no: 1, role_code: 'management', min_approvers: 1 },
      { rule_id: id(1), step_no: 2, role_code: 'accountant', min_approvers: 2 },
    ]);
    expect(await listStepsOfRules(db, [])).toEqual([]);
  });

  it('selects the latest rule set effective on the date', async () => {
    await insertRule(db, rule(2, { docType: 'dated', effectiveFrom: '2026-01-01' }));
    await insertRule(db, rule(3, { docType: 'dated', effectiveFrom: '2026-06-01' }));
    await insertRule(db, rule(4, { docType: 'dated', effectiveFrom: '2027-01-01' }));
    const on = async (date: string) =>
      (await selectRulesInForce(db, 'dated', date)).map((r) => r.id);
    expect(await on('2025-12-31')).toEqual([]);
    expect(await on('2026-01-01')).toEqual([id(2)]);
    expect(await on('2026-10-24')).toEqual([id(3)]);
    expect(await on('2027-01-01')).toEqual([id(4)]);
  });

  it('retires a rule set without deleting it', async () => {
    await insertRule(db, rule(5, { docType: 'retire' }));
    await deactivateRuleSet(db, {
      docType: 'retire',
      effectiveFrom: '2026-01-01',
      actorUserId: user,
      at,
    });
    expect(await listActiveRules(db, 'retire')).toEqual([]);
    expect(await selectRulesInForce(db, 'retire', '2026-10-24')).toEqual([]);
    const kept = await db.query('select 1 from apr_rules where id = $1', [id(5)]);
    expect(kept).toHaveLength(1);
  });

  it('lists the document types with active rules', async () => {
    expect(await listDocTypes(db)).toEqual(
      expect.arrayContaining(['dated', 'expense', 'purchase_order', 'sample']),
    );
    expect(await listDocTypes(db)).not.toContain('retire');
  });

  it('seeds the H-09 default: the owner approves every item without limits', async () => {
    const rules = await selectRulesInForce(db, 'purchase_order', '2026-10-24');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ min_amount: '0.00', max_amount: null });
    expect(await listStepsOfRules(db, [(rules[0] as { id: string }).id])).toEqual([
      expect.objectContaining({ step_no: 1, role_code: 'management', min_approvers: 1 }),
    ]);
  });
});

describe('apr_requests and apr_actions', () => {
  it('inserts and finds requests, keeping amount and context', async () => {
    await insertRequest(db, request(10));
    const row = await findRequest(db, id(10));
    expect(row).toMatchObject({
      id: id(10),
      amount: '1250.50',
      status: 'pending',
      current_step: 1,
      version: 1,
      context: { scope: { type: 'project', id: id(77) } },
    });
    expect(await findRequest(db, id(404))).toBeUndefined();
    expect(await findRequest(db, id(10), true)).toMatchObject({ id: id(10) });
    expect(await findOpenRequest(db, 'sample', id(500))).toMatchObject({ id: id(10) });
    expect(await findOpenRequest(db, 'sample', id(500), true)).toMatchObject({ id: id(10) });
    expect(await findOpenRequest(db, 'sample', id(501))).toBeUndefined();
  });

  it('allows only one open request per document (BR-6)', async () => {
    await expect(insertRequest(db, request(11, { revision: 2 }))).rejects.toThrow();
  });

  it('numbers revisions and finds the latest one', async () => {
    expect(await maxRevision(db, 'sample', id(500))).toBe(1);
    expect(await maxRevision(db, 'sample', id(999))).toBe(0);
    await updateRequestState(db, id(10), {
      status: 'returned',
      currentStep: 1,
      decidedAt: at,
      actorUserId: user,
      at,
    });
    await insertRequest(db, request(12, { revision: 2 }));
    expect(await findLatestRequest(db, 'sample', id(500))).toMatchObject({
      id: id(12),
      revision: 2,
    });
    expect(await findLatestRequest(db, 'sample', id(999))).toBeUndefined();
  });

  it('updates the state with a version bump and lists pending requests', async () => {
    expect(await findRequest(db, id(10))).toMatchObject({ status: 'returned', version: 2 });
    expect((await listPendingRequests(db)).map((r) => r.id)).toEqual([id(12)]);
    await updateRequestState(db, id(12), {
      status: 'pending',
      currentStep: 2,
      decidedAt: null,
      actorUserId: user,
      at,
    });
    expect(await findRequest(db, id(12))).toMatchObject({
      current_step: 2,
      decided_at: null,
      version: 2,
    });
  });

  it('keeps actions append-only', async () => {
    await insertAction(db, {
      id: id(20),
      requestId: id(12),
      stepNo: 1,
      actorId: user,
      action: 'approve',
      comment: null,
      at,
    });
    await insertAction(db, {
      id: id(21),
      requestId: id(12),
      stepNo: 2,
      actorId: id(901),
      action: 'return',
      comment: 'check quantities',
      at,
    });
    expect(await listActions(db, id(12))).toEqual([
      { request_id: id(12), step_no: 1, actor_id: user, action: 'approve', comment: null, at },
      {
        request_id: id(12),
        step_no: 2,
        actor_id: id(901),
        action: 'return',
        comment: 'check quantities',
        at,
      },
    ]);
    await expect(db.query("update apr_actions set comment = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query('delete from apr_actions')).rejects.toThrow(/append-only/);
  });
});

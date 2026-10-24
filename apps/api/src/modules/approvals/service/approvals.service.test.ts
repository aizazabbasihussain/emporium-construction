import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTANT,
  ADMIN,
  ESTIMATOR,
  OWNER,
  PM,
  PM2,
  SUPERVISOR,
  createApprovalsKit,
  twoStepRules,
  type ApprovalsKit,
} from '../test-support.js';
import type { RequestDto } from '../types.js';

let k: ApprovalsKit;

beforeAll(async () => {
  k = await createApprovalsKit();
  await k.seedTestDoc();
}, 60_000);

afterAll(async () => {
  await k.close();
});

const PM_ACTOR = () => k.actor(PM, ['project_manager']);
const PM2_ACTOR = () => k.actor(PM2, ['project_manager']);
const OWNER_ACTOR = () => k.actor(OWNER, ['management']);

const submit = (
  docId: string,
  amount: string,
  over: { docType?: string; context?: Record<string, unknown>; requesterId?: string } = {},
) =>
  k.db.transaction((tx) =>
    k.approvals.requestApproval(
      {
        docType: over.docType ?? 'test_doc',
        docId,
        amount,
        requesterId: over.requesterId ?? ESTIMATOR,
        ...(over.context ? { context: over.context } : {}),
      },
      tx,
    ),
  );

const act = (
  request: RequestDto,
  action: 'approve' | 'reject' | 'return',
  actor: ReturnType<typeof k.actor>,
  comment: string | null = null,
  expectedVersion?: number,
) =>
  k.db.transaction((tx) =>
    k.approvals.service.act(request.id, action, { comment, expectedVersion }, actor, tx),
  );

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no_error';
};

describe('rule selection (BR-1, T-1, AC-3)', () => {
  it('routes by band, min inclusive and max exclusive', async () => {
    const low = await submit(k.newDoc(), '99999.99');
    expect(low.steps).toHaveLength(1);
    const high = await submit(k.newDoc(), '100000');
    expect(high.steps).toHaveLength(2);
    expect(high.amount).toBe('100000.00');
    expect(high.currentRole).toBe('project_manager');
  });

  it('refuses a request with no matching band, never auto-approving (AC-3)', async () => {
    await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(
        'bounded_doc',
        {
          effectiveFrom: '2026-01-01',
          bands: [
            {
              minAmount: '0',
              maxAmount: '500',
              steps: [{ stepNo: 1, roleCode: 'management', minApprovers: 1 }],
            },
          ],
        },
        { userId: ADMIN, requestId: null },
        tx,
      ),
    );
    const docId = k.newDoc();
    expect(await codeOf(submit(docId, '500', { docType: 'bounded_doc' }))).toBe('no_approval_rule');
    expect(await codeOf(submit(docId, '10', { docType: 'never_configured' }))).toBe(
      'no_approval_rule',
    );
    expect((await k.approvals.getApprovalState(k.db, 'bounded_doc', docId)).status).toBe('none');
  });

  it('uses the owner-approves-everything default from H-09', async () => {
    const request = await submit(k.newDoc(), '99999999.99', { docType: 'purchase_order' });
    expect(request.steps).toEqual([{ stepNo: 1, roleCode: 'management', minApprovers: 1 }]);
  });
});

describe('two-step flow (AC-1, AC-2, T-2, T-7)', () => {
  it('routes a document through two steps and approves it, emitting each event once', async () => {
    const docId = k.newDoc();
    const request = await submit(docId, '250000.00');
    const first = await act(request, 'approve', PM_ACTOR());
    expect(first).toMatchObject({
      status: 'pending',
      currentStep: 1,
      currentRole: 'project_manager',
    });
    const second = await act(request, 'approve', PM2_ACTOR(), 'looks fine');
    expect(second).toMatchObject({ status: 'pending', currentStep: 2, currentRole: 'management' });
    const done = await act(request, 'approve', OWNER_ACTOR());
    expect(done).toMatchObject({ status: 'approved', currentRole: null });
    expect(done.decidedAt).toBe('2026-10-24T10:00:00.000Z');
    expect(done.actions.map((a) => [a.stepNo, a.actorId, a.action, a.comment])).toEqual([
      [1, PM, 'approve', null],
      [1, PM2, 'approve', 'looks fine'],
      [2, OWNER, 'approve', null],
    ]);
    expect(await k.eventsFor(docId)).toEqual([
      'approval.requested',
      'approval.step_approved',
      'approval.step_approved',
      'approval.approved',
    ]);
    const state = await k.approvals.getApprovalState(k.db, 'test_doc', docId);
    expect(state).toMatchObject({ id: request.id, status: 'approved' });
  });

  it('never lets the requester approve their own request, even holding the role (AC-2)', async () => {
    const request = await submit(k.newDoc(), '10', { requesterId: PM });
    expect(await codeOf(act(request, 'approve', PM_ACTOR()))).toBe('self_approval');
    expect(await codeOf(act(request, 'reject', PM_ACTOR(), 'no'))).toBe('self_approval');
  });

  it('blocks a user without the step role, a repeat approver and the same user on two steps', async () => {
    const request = await submit(k.newDoc(), '300000');
    expect(await codeOf(act(request, 'approve', k.actor(ACCOUNTANT, ['accountant'])))).toBe(
      'not_an_approver',
    );
    await act(request, 'approve', PM_ACTOR());
    expect(await codeOf(act(request, 'approve', PM_ACTOR()))).toBe('already_approved');
    await act(request, 'approve', PM2_ACTOR());
    const both = k.actor(PM, ['project_manager', 'management']);
    expect(await codeOf(act(request, 'approve', both))).toBe('already_approved');
  });

  it('rejects stale versions and finished requests', async () => {
    const request = await submit(k.newDoc(), '10');
    expect(await codeOf(act(request, 'approve', PM_ACTOR(), null, 99))).toBe('version_conflict');
    const approved = await act(request, 'approve', PM_ACTOR(), '  ', request.version);
    expect(approved.actions[0]?.comment).toBeNull();
    expect(await codeOf(act(request, 'approve', PM2_ACTOR()))).toBe('request_not_pending');
    expect(
      await codeOf(
        k.db.transaction((tx) =>
          k.approvals.service.act(
            '018f0000-0000-7000-8000-00000000dead',
            'approve',
            { comment: null },
            PM2_ACTOR(),
            tx,
          ),
        ),
      ),
    ).toBe('request_not_found');
  });
});

describe('reject, return and resubmission (BR-4, BR-6, T-4)', () => {
  it('requires a comment to reject or return', async () => {
    const request = await submit(k.newDoc(), '10');
    expect(await codeOf(act(request, 'reject', PM_ACTOR()))).toBe('comment_required');
    expect(await codeOf(act(request, 'return', PM_ACTOR(), '   '))).toBe('comment_required');
  });

  it('ends a rejected request and emits approval.rejected', async () => {
    const docId = k.newDoc();
    const request = await submit(docId, '10');
    const rejected = await act(request, 'reject', PM_ACTOR(), 'over budget');
    expect(rejected).toMatchObject({ status: 'rejected', currentRole: null });
    expect(rejected.actions[0]).toMatchObject({ action: 'reject', comment: 'over budget' });
    expect(await k.eventsFor(docId)).toEqual(['approval.requested', 'approval.rejected']);
  });

  it('allows only one open request per document and numbers resubmissions', async () => {
    const docId = k.newDoc();
    const first = await submit(docId, '10');
    expect(await codeOf(submit(docId, '10'))).toBe('open_request_exists');
    await act(first, 'return', PM_ACTOR(), 'fix the quantity');
    expect(await k.eventsFor(docId)).toEqual(['approval.requested', 'approval.returned']);
    const second = await submit(docId, '20');
    expect(second.revision).toBe(2);
    expect(second.id).not.toBe(first.id);
    const state = await k.approvals.getApprovalState(k.db, 'test_doc', docId);
    expect(state).toMatchObject({ id: second.id, revision: 2, status: 'pending' });
  });
});

describe('cancellation (BR-5, T-5)', () => {
  it('cancels the open request and emits approval.cancelled once', async () => {
    const docId = k.newDoc();
    const request = await submit(docId, '10');
    const cancel = () =>
      k.db.transaction((tx) =>
        k.approvals.cancelApproval(
          {
            docType: 'test_doc',
            docId,
            reason: 'amount_changed',
            actorUserId: ESTIMATOR,
            requestId: 'r-1',
          },
          tx,
        ),
      );
    expect(await cancel()).toMatchObject({ id: request.id, status: 'cancelled' });
    expect(await cancel()).toBeNull();
    expect(await k.eventsFor(docId)).toEqual(['approval.requested', 'approval.cancelled']);
    expect(await codeOf(act(request, 'approve', PM_ACTOR()))).toBe('request_not_pending');
    const resubmitted = await submit(docId, '15');
    expect(resubmitted.revision).toBe(2);
  });

  it('cancels without a request id', async () => {
    const docId = k.newDoc();
    await submit(docId, '10');
    const cancelled = await k.db.transaction((tx) =>
      k.approvals.cancelApproval(
        { docType: 'test_doc', docId, reason: 'withdrawn', actorUserId: ESTIMATOR },
        tx,
      ),
    );
    expect(cancelled?.status).toBe('cancelled');
  });
});

describe('rule edits (BR-8, AC-4, T-6)', () => {
  it('does not change pending requests when the rules change', async () => {
    await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(
        'edit_doc',
        twoStepRules('2026-01-01'),
        { userId: ADMIN, requestId: null },
        tx,
      ),
    );
    const request = await submit(k.newDoc(), '500000', { docType: 'edit_doc' });
    expect(request.steps).toHaveLength(2);
    await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(
        'edit_doc',
        {
          effectiveFrom: '2026-01-01',
          bands: [
            {
              minAmount: '0',
              maxAmount: null,
              steps: [{ stepNo: 1, roleCode: 'accountant', minApprovers: 1 }],
            },
          ],
        },
        { userId: ADMIN, requestId: null },
        tx,
      ),
    );
    const after = await k.approvals.service.getRequest(k.db, request.id, PM_ACTOR(), true);
    expect(after.steps).toEqual(request.steps);
    expect(after.currentRole).toBe('project_manager');
    await act(request, 'approve', PM_ACTOR());
    await act(request, 'approve', PM2_ACTOR());
    expect((await act(request, 'approve', OWNER_ACTOR())).status).toBe('approved');
    const fresh = await submit(k.newDoc(), '500000', { docType: 'edit_doc' });
    expect(fresh.steps).toEqual([{ stepNo: 1, roleCode: 'accountant', minApprovers: 1 }]);
  });

  it('keeps rule sets by effective date and audits the change', async () => {
    const docType = 'dated_doc';
    const actor = { userId: ADMIN, requestId: 'req-9' };
    await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(docType, twoStepRules('2026-01-01'), actor, tx),
    );
    const sets = await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(docType, twoStepRules('2027-01-01'), actor, tx),
    );
    expect(sets.map((s) => s.effectiveFrom)).toEqual(['2026-01-01', '2027-01-01']);
    expect(sets[0]?.bands[1]?.steps).toHaveLength(2);
    expect(await k.approvals.rules.getRules(k.db, docType)).toEqual(sets);
    expect(await k.approvals.rules.listDocTypes(k.db)).toContain(docType);
    const audit = await k.db.query(
      `select 1 from sys_audit_log where action = 'approval.rules.replace' and request_id = 'req-9'`,
    );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    const request = await submit(k.newDoc(), '10', { docType });
    expect(request.steps).toHaveLength(1);
  });

  it('rejects overlapping bands, gaps, unknown roles and bad dates', async () => {
    const replace = (input: Parameters<typeof k.approvals.rules.replaceRules>[1]) =>
      k.db.transaction((tx) =>
        k.approvals.rules.replaceRules('bad_doc', input, { userId: ADMIN, requestId: null }, tx),
      );
    const step = { stepNo: 1, roleCode: 'management', minApprovers: 1 };
    expect(
      await codeOf(
        replace({
          effectiveFrom: '2026-01-01',
          bands: [
            { minAmount: '0', maxAmount: '10', steps: [step] },
            { minAmount: '5', maxAmount: null, steps: [step] },
          ],
        }),
      ),
    ).toBe('band_overlap');
    expect(
      await codeOf(
        replace({
          effectiveFrom: '2026-01-01',
          bands: [
            { minAmount: '0', maxAmount: '10', steps: [step] },
            { minAmount: '20', maxAmount: null, steps: [step] },
          ],
        }),
      ),
    ).toBe('band_gap');
    expect(
      await codeOf(
        replace({
          effectiveFrom: '2026-01-01',
          bands: [{ minAmount: '0', maxAmount: null, steps: [{ ...step, roleCode: 'wizard' }] }],
        }),
      ),
    ).toBe('unknown_role');
    expect(
      await codeOf(
        replace({
          effectiveFrom: '2026-01-01',
          bands: [{ minAmount: '0', maxAmount: null, steps: [] }],
        }),
      ),
    ).toBe('steps_empty');
    expect(
      await codeOf(
        replace({
          effectiveFrom: '2026-02-30',
          bands: [{ minAmount: '0', maxAmount: null, steps: [step] }],
        }),
      ),
    ).toBe('invalid_date');
    expect(await k.approvals.rules.getRules(k.db, 'bad_doc')).toEqual([]);
  });
});

describe('inbox and reading (BR-7)', () => {
  it('lists only requests the user can act on', async () => {
    const mine = await submit(k.newDoc(), '10', { requesterId: PM2 });
    const ownRequest = await submit(k.newDoc(), '10', { requesterId: PM });
    const approvedByMe = await submit(k.newDoc(), '300000');
    await act(approvedByMe, 'approve', PM_ACTOR());
    const ids = (await k.approvals.service.inbox(k.db, PM_ACTOR())).map((r) => r.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(ownRequest.id);
    expect(ids).not.toContain(approvedByMe.id);
    const pm2Ids = (await k.approvals.service.inbox(k.db, PM2_ACTOR())).map((r) => r.id);
    expect(pm2Ids).toContain(approvedByMe.id);
    const item = (await k.approvals.service.inbox(k.db, PM2_ACTOR())).find(
      (r) => r.id === approvedByMe.id,
    );
    expect(item?.actions).toHaveLength(1);
    expect(await k.approvals.service.inbox(k.db, k.actor(ACCOUNTANT, ['accountant']))).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: mine.id })]),
    );
  });

  it('respects the project scope supplied by the owning module', async () => {
    const project = '018f0000-0000-7000-8000-0000000000a1';
    const other = '018f0000-0000-7000-8000-0000000000a2';
    await k.db.transaction((tx) =>
      k.approvals.rules.replaceRules(
        'scoped_doc',
        {
          effectiveFrom: '2026-01-01',
          bands: [
            {
              minAmount: '0',
              maxAmount: null,
              steps: [{ stepNo: 1, roleCode: 'supervisor', minApprovers: 1 }],
            },
          ],
        },
        { userId: ADMIN, requestId: null },
        tx,
      ),
    );
    const inScope = await submit(k.newDoc(), '10', {
      docType: 'scoped_doc',
      context: { scope: { type: 'project', id: project } },
    });
    const outOfScope = await submit(k.newDoc(), '10', {
      docType: 'scoped_doc',
      context: { scope: { type: 'project', id: other } },
    });
    const supervisor = k.actor(SUPERVISOR, ['supervisor'], [{ type: 'project', id: project }]);
    const ids = (await k.approvals.service.inbox(k.db, supervisor)).map((r) => r.id);
    expect(ids).toContain(inScope.id);
    expect(ids).not.toContain(outOfScope.id);
    expect(await codeOf(act(outOfScope, 'approve', supervisor))).toBe('request_not_found');
    expect((await act(inScope, 'approve', supervisor)).status).toBe('approved');
  });

  it('shows a request to its requester, rule managers and approvers only', async () => {
    const request = await submit(k.newDoc(), '10');
    const read = (actor: ReturnType<typeof k.actor>, canManage = false) =>
      k.approvals.service.getRequest(k.db, request.id, actor, canManage);
    expect((await read(k.actor(ESTIMATOR, ['estimator']))).id).toBe(request.id);
    expect((await read(PM_ACTOR())).id).toBe(request.id);
    expect((await read(k.actor(ADMIN, ['admin']), true)).id).toBe(request.id);
    expect(await codeOf(read(k.actor(ACCOUNTANT, ['accountant'])))).toBe('request_not_found');
    expect(
      await codeOf(
        k.approvals.service.getRequest(
          k.db,
          '018f0000-0000-7000-8000-00000000dead',
          PM_ACTOR(),
          true,
        ),
      ),
    ).toBe('request_not_found');
  });
});

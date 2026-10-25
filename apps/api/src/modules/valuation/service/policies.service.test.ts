import { NotFoundError, RuleViolationError, ValidationError } from '@emporium/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Approvals } from '../../approvals/index.js';
import {
  auditCount,
  CAT_CEMENT,
  CAT_MATERIALS,
  CAT_STEEL,
  createValuationKit,
  eventCount,
  ITEM_CEMENT,
  ITEM_SAND,
  ITEM_STEEL,
  MANAGEMENT,
  TODAY,
  TOMORROW,
  type ValuationKit,
} from '../test-support.js';
import { createPoliciesService } from './policies.service.js';

const at = (day: string) => new Date(`${day}T10:00:00Z`);

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
}, 60_000);
afterAll(() => kit.close());

const methodOn = async (itemId: string, date: string) =>
  (await kit.valuation.resolvePolicy(kit.db, itemId, date)).method;

describe('the initial policy (H-07, BR-1)', () => {
  it('starts as the company default, weighted average, with no overrides', async () => {
    const all = await kit.valuation.policies.list(kit.db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      scope: 'company',
      categoryId: null,
      method: 'weighted_average',
      status: 'active',
    });
    expect(await methodOn(ITEM_CEMENT, TODAY)).toBe('weighted_average');
    expect(await methodOn(ITEM_SAND, TODAY)).toBe('weighted_average');
  });

  it('fails clearly if no company policy is in force on the date', async () => {
    await expect(
      kit.valuation.resolvePolicy(kit.db, ITEM_SAND, '1999-12-31'),
    ).rejects.toBeInstanceOf(RuleViolationError);
  });

  it('refuses an unknown item', async () => {
    await expect(
      kit.valuation.resolvePolicy(kit.db, '018f7a7a-3333-7000-8000-000000009999', TODAY),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('requesting a change (BR-2, BR-3)', () => {
  it('records a pending policy, asks for approval and leaves it inactive', async () => {
    const audits = await auditCount(kit.db, 'valuation.policy.request');
    const events = await eventCount(kit.db, 'valuation.policy.changed');
    const id = await kit.requestPolicy({
      scope: 'company',
      method: 'fifo',
      effectiveFrom: TOMORROW,
    });
    const [row] = (await kit.valuation.policies.list(kit.db, 'pending_approval')).filter(
      (p) => p.id === id,
    );
    expect(row).toMatchObject({ status: 'pending_approval', requestedBy: kit.actor.userId });
    const state = await kit.approvals.getApprovalState(kit.db, 'valuation_policy', id);
    expect(state).toMatchObject({ status: 'pending', currentRole: 'management' });
    expect(await methodOn(ITEM_SAND, TOMORROW)).toBe('weighted_average');
    expect(await auditCount(kit.db, 'valuation.policy.request')).toBe(audits + 1);
    expect(await eventCount(kit.db, 'valuation.policy.changed')).toBe(events + 1);
    await kit.decide(id, 'reject');
  });

  it('becomes active when the owner approves, from its effective date only', async () => {
    const id = await kit.requestPolicy({
      scope: 'company',
      method: 'fifo',
      effectiveFrom: TOMORROW,
    });
    await kit.decide(id, 'approve');
    const [row] = (await kit.valuation.policies.list(kit.db, 'active')).filter((p) => p.id === id);
    expect(row).toMatchObject({
      status: 'active',
      approvedBy: MANAGEMENT,
      effectiveFrom: TOMORROW,
    });
    expect(await methodOn(ITEM_SAND, TODAY)).toBe('weighted_average');
    expect(await methodOn(ITEM_SAND, TOMORROW)).toBe('fifo');
  });

  it('starts a late-approved policy on the day of approval, not in the past (BR-2)', async () => {
    const id = await kit.requestPolicy({
      scope: 'category',
      categoryId: CAT_STEEL,
      method: 'fifo',
      effectiveFrom: TODAY,
    });
    kit.now.current = at(TOMORROW);
    await kit.decide(id, 'approve');
    const [row] = (await kit.valuation.policies.list(kit.db)).filter((p) => p.id === id);
    expect(row?.effectiveFrom).toBe(TOMORROW);
    kit.now.current = at(TODAY);
    expect(await methodOn(ITEM_STEEL, TODAY)).toBe('weighted_average');
  });

  it('replaces an active policy with the same scope and start date', async () => {
    const first = await kit.activatePolicy({
      scope: 'category',
      categoryId: CAT_CEMENT,
      method: 'fifo',
      effectiveFrom: TOMORROW,
    });
    const second = await kit.activatePolicy({
      scope: 'category',
      categoryId: CAT_CEMENT,
      method: 'weighted_average',
      effectiveFrom: TOMORROW,
    });
    const all = await kit.valuation.policies.list(kit.db);
    expect(all.find((p) => p.id === first)?.status).toBe('superseded');
    expect(all.find((p) => p.id === second)?.status).toBe('active');
    expect(await methodOn(ITEM_CEMENT, TOMORROW)).toBe('weighted_average');
  });

  it('marks a rejected policy rejected and never activates it', async () => {
    const id = await kit.requestPolicy({
      scope: 'company',
      method: 'fifo',
      effectiveFrom: '2026-12-01',
    });
    await kit.decide(id, 'reject');
    const [row] = (await kit.valuation.policies.list(kit.db, 'rejected')).filter(
      (p) => p.id === id,
    );
    expect(row).toMatchObject({ status: 'rejected', approvedBy: null });
    expect(await methodOn(ITEM_SAND, '2026-12-02')).toBe('fifo'); // the tomorrow policy, not this one
    expect((await kit.valuation.policies.list(kit.db, 'active')).some((p) => p.id === id)).toBe(
      false,
    );
  });

  it('refuses back-dating, a bad date and a malformed or unknown category', async () => {
    const request = (input: Parameters<typeof kit.requestPolicy>[0]) => kit.requestPolicy(input);
    await expect(
      request({ scope: 'company', method: 'fifo', effectiveFrom: '2026-10-24' }),
    ).rejects.toThrow(/past/);
    await expect(
      request({ scope: 'company', method: 'fifo', effectiveFrom: '2026-02-30' }),
    ).rejects.toThrow(/Invalid/);
    await expect(
      request({ scope: 'category', method: 'fifo', effectiveFrom: TOMORROW }),
    ).rejects.toThrow(/needs a category/);
    await expect(
      request({ scope: 'company', categoryId: CAT_STEEL, method: 'fifo', effectiveFrom: TOMORROW }),
    ).rejects.toThrow(/no category/);
    await expect(
      request({
        scope: 'category',
        categoryId: '018f7a7a-3333-7000-8000-000000009998',
        method: 'fifo',
        effectiveFrom: TOMORROW,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('does not allow a second request while one is open for the same policy', async () => {
    const id = await kit.requestPolicy({
      scope: 'company',
      method: 'fifo',
      effectiveFrom: '2026-12-10',
    });
    await expect(
      kit.tx((tx) =>
        kit.approvals.requestApproval(
          { docType: 'valuation_policy', docId: id, amount: '0', requesterId: kit.actor.userId },
          tx,
        ),
      ),
    ).rejects.toThrow(/in progress/);
    await kit.decide(id, 'reject');
  });
});

describe('policy resolution (BR-1, T-6)', () => {
  it('lets a category beat the company default and the nearest ancestor win', async () => {
    const d = '2026-11-15';
    await kit.activatePolicy({ scope: 'company', method: 'weighted_average', effectiveFrom: d });
    await kit.activatePolicy({
      scope: 'category',
      categoryId: CAT_MATERIALS,
      method: 'fifo',
      effectiveFrom: d,
    });
    expect(await methodOn(ITEM_STEEL, d)).toBe('fifo'); // inherited from the parent category
    expect(await methodOn(ITEM_CEMENT, d)).toBe('weighted_average'); // its own override (set earlier) is nearer
    expect(await methodOn(ITEM_SAND, d)).toBe('weighted_average'); // no category: company policy
  });
});

describe('approval events', () => {
  const publish = (type: string, payload: unknown) =>
    kit.tx((tx) => kit.platform.events.publish({ type, payload }, tx));

  it('ignores approvals of other documents and of unknown or settled policies', async () => {
    const before = await kit.valuation.policies.list(kit.db);
    await publish('approval.approved', {
      docType: 'expense',
      docId: 'x',
      requesterId: kit.actor.userId,
    });
    await publish('approval.approved', {
      docType: 'valuation_policy',
      docId: '018f7a7a-3333-7000-8000-000000009997',
      requesterId: kit.actor.userId,
    });
    await publish('approval.rejected', {
      docType: 'valuation_policy',
      docId: before.find((p) => p.status === 'active')?.id,
      requesterId: kit.actor.userId,
    });
    await kit.platform.events.dispatchDue(kit.db);
    expect(await kit.valuation.policies.list(kit.db)).toEqual(before);
  });

  it('falls back to the requester when the approval carries no decider', async () => {
    const approvals = {
      requestApproval: kit.approvals.requestApproval,
      getApprovalState: () =>
        Promise.resolve({ status: 'none' as const, docType: 'valuation_policy', docId: 'x' }),
    } satisfies Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
    const service = createPoliciesService({
      platform: kit.platform,
      clock: { now: () => at(TODAY) },
      newId: () => `018f7c7c-5555-7000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`,
      masterData: kit.masterData,
      approvals,
    });
    const created = await kit.tx((tx) =>
      service.setPolicy(
        { scope: 'company', method: 'fifo', effectiveFrom: '2026-12-20' },
        kit.actor,
        tx,
      ),
    );
    await kit.tx((tx) =>
      service.onApprovalOutcome(
        'approved',
        { docId: created.id, requesterId: kit.actor.userId },
        tx,
      ),
    );
    const [row] = (await service.list(kit.db, 'active')).filter((p) => p.id === created.id);
    expect(row?.approvedBy).toBe(kit.actor.userId);
  });
});

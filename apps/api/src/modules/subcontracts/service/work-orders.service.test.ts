import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCount,
  createSubcontractsKit,
  eventCount,
  PM,
  type SubcontractsKit,
} from '../test-support.js';

let kit: SubcontractsKit;
beforeAll(async () => {
  kit = await createSubcontractsKit();
}, 180_000);
afterAll(() => kit.close());

const refused = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string },
  );
  expect(error?.code).toBe(code);
};

const svc = () => kit.subcontracts.orders;

const hold = async (projectId: string) => {
  const project = await kit.projects.getProject(kit.db, projectId);
  await kit.run((tx) =>
    kit.projects.service.transition(projectId, 'on_hold', project.version, kit.actorFor(PM), tx),
  );
};

describe('creating and editing a work order (BR-1, BR-8)', () => {
  it('creates a draft with a number, audit and event, and uses the contractor kinds of BR-1', async () => {
    const before = await auditCount(kit.db, 'subcontracts.work_order.create');
    const draft = await kit.draftOrder();
    expect(draft).toMatchObject({
      status: 'draft',
      contractAmount: '1000000.00',
      retentionPercent: '0.0000',
    });
    expect(draft.number).toMatch(/^SCO-\d{4}-\d{4}$/);
    expect(await auditCount(kit.db, 'subcontracts.work_order.create')).toBe(before + 1);
    expect(await eventCount(kit.db, 'subcontracts.work_order.changed')).toBeGreaterThan(0);
    // A labour contractor is a subcontractor for this purpose.
    const project = await kit.locatedProject();
    const labour = await kit.contractor(['labour_contractor']);
    const second = await kit.run((tx) =>
      svc().create(kit.orderInput(project.id, labour), kit.pm, tx),
    );
    expect(second.partyId).toBe(labour);
  });

  it('needs neither dates nor a scope text', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const input = kit.orderInput(project.id, partyId, {
      startDate: undefined,
      endDate: undefined,
      scopeText: undefined,
    });
    const order = await kit.run((tx) => svc().create(input, kit.pm, tx));
    expect(order).toMatchObject({ startDate: null, endDate: null, scopeText: '' });
  });

  it('refuses retention, an inactive project, a wrong party, an inactive code and bad dates', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const create = (over = {}) =>
      kit.run((tx) => svc().create(kit.orderInput(project.id, partyId, over), kit.pm, tx));
    await refused(create({ retentionPercent: '5' }), 'retention_not_supported');
    await expect(create({ retentionPercent: '0' })).resolves.toBeDefined();
    await refused(create({ contractAmount: '0' }), 'contract_amount_invalid');
    await refused(create({ title: '  ' }), 'title_required');
    await refused(create({ costCodeId: kit.inactiveCode }), 'cost_code_inactive');
    await refused(create({ startDate: '2026-12-31', endDate: '2026-12-01' }), 'end_before_start');
    await refused(create({ partyId: await kit.vendor() }), 'not_a_subcontractor');
    await refused(
      kit.run((tx) =>
        svc().create(
          kit.orderInput(project.id, '018f7c7c-0000-7000-8000-00000000dead'),
          kit.pm,
          tx,
        ),
      ),
      'party_not_found',
    );
    await hold(project.id);
    await refused(create(), 'project_not_active');
  });

  it('updates and deletes only drafts and keeps the version (constitution 5.2)', async () => {
    const draft = await kit.draftOrder();
    const input = kit.orderInput(draft.projectId, draft.partyId, { title: 'Changed' });
    const updated = await kit.run((tx) => svc().update(draft.id, input, draft.version, kit.pm, tx));
    expect(updated.title).toBe('Changed');
    await refused(
      kit.run((tx) => svc().update(draft.id, input, draft.version, kit.pm, tx)),
      'version_conflict',
    );
    await kit.run((tx) => svc().remove(draft.id, updated.version, kit.pm, tx));
    await refused(svc().get(kit.db, draft.id, kit.pm), 'work_order_not_found');
    await refused(
      kit.run((tx) => svc().remove(draft.id, updated.version, kit.pm, tx)),
      'work_order_not_found',
    );
    const active = await kit.activeOrder();
    await refused(
      kit.run((tx) =>
        svc().update(
          active.id,
          kit.orderInput(active.projectId, active.partyId),
          active.version,
          kit.pm,
          tx,
        ),
      ),
      'work_order_not_editable',
    );
    await refused(
      kit.run((tx) => svc().remove(active.id, active.version, kit.pm, tx)),
      'work_order_not_editable',
    );
  });
});

describe('approval and the commitment (BR-1, T-2)', () => {
  it('posts the commitment once when the owner approves, also on a replayed event', async () => {
    const draft = await kit.draftOrder();
    const submitted = await kit.run((tx) => svc().submit(draft.id, draft.version, kit.pm, tx));
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approval.status).toBe('pending');
    await refused(
      kit.run((tx) =>
        svc().update(
          draft.id,
          kit.orderInput(draft.projectId, draft.partyId),
          submitted.version,
          kit.pm,
          tx,
        ),
      ),
      'work_order_not_editable',
    );
    await kit.decide('subcontract_order', draft.id, 'approve');
    const active = await kit.order(draft.id);
    expect(active.status).toBe('active');
    const ledger = (await kit.ledger(draft.projectId)).filter(
      (r) => r.sourceDocType === 'subcontract_commitment',
    );
    expect(ledger).toEqual([
      {
        status: 'committed',
        amount: '1000000.00',
        sourceDocType: 'subcontract_commitment',
        reverses: false,
      },
    ]);
    // A replay finds the order active and does nothing.
    await kit.run((tx) => svc().onApprovalOutcome('approved', { docId: draft.id }, tx));
    expect(
      (await kit.ledger(draft.projectId)).filter(
        (r) => r.sourceDocType === 'subcontract_commitment',
      ),
    ).toHaveLength(1);
    // Events for unknown documents, or cancelled approvals, are ignored.
    await kit.run((tx) =>
      svc().onApprovalOutcome('approved', { docId: '018f7c7c-0000-7000-8000-00000000dead' }, tx),
    );
    await kit.run((tx) => svc().onApprovalOutcome('cancelled', { docId: draft.id }, tx));
  });

  it('sends a rejected or returned order back to draft', async () => {
    for (const action of ['reject', 'return'] as const) {
      const draft = await kit.draftOrder();
      await kit.run((tx) => svc().submit(draft.id, draft.version, kit.pm, tx));
      await kit.decide('subcontract_order', draft.id, action);
      const back = await kit.order(draft.id);
      expect(back.status).toBe('draft');
      expect(
        (await kit.ledger(draft.projectId)).filter(
          (r) => r.sourceDocType === 'subcontract_commitment',
        ),
      ).toEqual([]);
    }
  });

  it('refuses to submit when the project is no longer active or the version is stale', async () => {
    const draft = await kit.draftOrder();
    await refused(
      kit.run((tx) => svc().submit(draft.id, draft.version + 1, kit.pm, tx)),
      'version_conflict',
    );
    await hold(draft.projectId);
    await refused(
      kit.run((tx) => svc().submit(draft.id, draft.version, kit.pm, tx)),
      'project_not_active',
    );
  });
});

describe('closing and cancelling (BR-6, BR-7)', () => {
  it('cancels an order with nothing certified and releases its commitment', async () => {
    const order = await kit.activeOrder();
    const cancelled = await kit.run((tx) => svc().cancel(order.id, order.version, kit.pm, tx));
    expect(cancelled.status).toBe('cancelled');
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '0.00',
      approved: '0.00',
      posted: '0.00',
    });
    const rows = await kit.ledger(order.projectId);
    expect(rows.map((r) => [r.status, r.reverses])).toEqual([
      ['committed', false],
      ['reversed', true],
    ]);
    // A draft can be cancelled too: there is no commitment to release.
    const draft = await kit.draftOrder();
    expect((await kit.run((tx) => svc().cancel(draft.id, draft.version, kit.pm, tx))).status).toBe(
      'cancelled',
    );
    await refused(
      kit.run((tx) => svc().cancel(draft.id, draft.version + 1, kit.pm, tx)),
      'version_conflict',
    );
  });

  it('only closes an order that has certified work (BR-7)', async () => {
    const order = await kit.activeOrder();
    await kit.certified(order.id);
    const current = await kit.order(order.id);
    await refused(
      kit.run((tx) => svc().cancel(order.id, current.version, kit.pm, tx)),
      'order_has_certified',
    );
  });

  it('refuses to close with a draft certificate, needs a reason when work remains, then releases the remainder', async () => {
    const order = await kit.activeOrder();
    await kit.certified(order.id, { cumulativePercent: '40' });
    const open = await kit.draftCertificate(order.id, { cumulativePercent: '50' });
    let current = await kit.order(order.id);
    await refused(
      kit.run((tx) => svc().close(order.id, { version: current.version, reason: 'x' }, kit.pm, tx)),
      'open_certificate',
    );
    await kit.run((tx) => kit.subcontracts.certificates.cancel(open.id, open.version, kit.pm, tx));
    current = await kit.order(order.id);
    await refused(
      kit.run((tx) => svc().close(order.id, { version: current.version }, kit.pm, tx)),
      'close_reason_required',
    );
    await refused(
      kit.run((tx) =>
        svc().close(order.id, { version: current.version + 1, reason: 'x' }, kit.pm, tx),
      ),
      'version_conflict',
    );
    const closed = await kit.run((tx) =>
      svc().close(order.id, { version: current.version, reason: ' Scope dropped ' }, kit.pm, tx),
    );
    expect(closed).toMatchObject({
      status: 'closed',
      closeReason: 'Scope dropped',
      committedAmount: '0.00',
    });
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '0.00',
      approved: '400000.00',
      posted: '0.00',
    });
    await refused(
      kit.run((tx) =>
        svc().close(order.id, { version: closed.version, reason: 'again' }, kit.pm, tx),
      ),
      'order_not_closable',
    );
    // Replay-safe: the ledger has one reversal of the commitment.
    expect(
      (await kit.ledger(order.projectId)).filter(
        (r) => r.reverses && r.sourceDocType === 'subcontract_commitment',
      ).length,
    ).toBe(2);
  });

  it('completes the order when the whole contract is certified and closes it without a reason', async () => {
    const order = await kit.activeOrder();
    const last = await kit.certified(order.id, { cumulativePercent: '100' });
    expect(last.cumulativeAmount).toBe('1000000.00');
    const done = await kit.order(order.id);
    expect(done).toMatchObject({ status: 'completed', committedAmount: '0.00' });
    await refused(
      kit.run((tx) => svc().addVariation(order.id, { amount: '5', reason: 'late' }, kit.pm, tx)),
      'order_not_active',
    );
    const closed = await kit.run((tx) =>
      svc().close(order.id, { version: done.version }, kit.pm, tx),
    );
    expect(closed).toMatchObject({ status: 'closed', closeReason: null });
  });
});

describe('variations (BR-1)', () => {
  it('adds, edits, approves and rejects variations and moves the commitment', async () => {
    const order = await kit.activeOrder();
    const add = (amount: string) =>
      kit.run((tx) => svc().addVariation(order.id, { amount, reason: ' Extra ' }, kit.pm, tx));
    const plus = await add('100000');
    expect(plus).toMatchObject({ seq: 1, status: 'draft', reason: 'Extra' });
    const edited = await kit.run((tx) =>
      svc().updateVariation(
        plus.id,
        { amount: '150000', reason: 'More', version: plus.version },
        kit.pm,
        tx,
      ),
    );
    expect(edited.amount).toBe('150000.00');
    await refused(
      kit.run((tx) =>
        svc().updateVariation(
          plus.id,
          { amount: '1', reason: 'x', version: plus.version },
          kit.pm,
          tx,
        ),
      ),
      'version_conflict',
    );
    await refused(
      kit.run((tx) => svc().addVariation(order.id, { amount: '0', reason: 'x' }, kit.pm, tx)),
      'variation_amount_invalid',
    );
    // Separation of duties: the proposer does not approve it.
    await refused(
      kit.run((tx) =>
        svc().decideVariation(
          plus.id,
          { decision: 'approved', version: edited.version },
          kit.pm,
          tx,
        ),
      ),
      'own_variation',
    );
    const approved = await kit.run((tx) =>
      svc().decideVariation(
        plus.id,
        { decision: 'approved', note: ' ok ', version: edited.version },
        kit.owner,
        tx,
      ),
    );
    expect(approved).toMatchObject({ status: 'approved', decisionNote: 'ok' });
    expect((await kit.order(order.id)).committedAmount).toBe('1150000.00');
    await refused(
      kit.run((tx) =>
        svc().updateVariation(
          plus.id,
          { amount: '1', reason: 'x', version: approved.version },
          kit.pm,
          tx,
        ),
      ),
      'variation_not_editable',
    );
    await refused(
      kit.run((tx) =>
        svc().decideVariation(
          plus.id,
          { decision: 'rejected', version: approved.version },
          kit.owner,
          tx,
        ),
      ),
      'variation_transition',
    );
    // A reduction below what is certified is refused; a rejected variation changes nothing.
    await kit.certified(order.id, { cumulativePercent: '50' });
    const cut = await add('-700000');
    await refused(
      kit.run((tx) =>
        svc().decideVariation(
          cut.id,
          { decision: 'approved', version: cut.version },
          kit.owner,
          tx,
        ),
      ),
      'variation_below_certified',
    );
    const rejected = await kit.run((tx) =>
      svc().decideVariation(
        cut.id,
        { decision: 'rejected', note: 'No', version: cut.version },
        kit.owner,
        tx,
      ),
    );
    expect(rejected.status).toBe('rejected');
    const small = await add('-50000');
    await kit.run((tx) =>
      svc().decideVariation(
        small.id,
        { decision: 'approved', version: small.version },
        kit.owner,
        tx,
      ),
    );
    // 1,150,000 current after the first variation; 50% of it, 575,000, is certified; then -50,000.
    expect((await kit.order(order.id)).currentContractAmount).toBe('1100000.00');
    expect((await kit.order(order.id)).committedAmount).toBe('525000.00');
  });

  it('refuses a variation decision while a certificate is open, or for an unknown variation', async () => {
    const order = await kit.activeOrder();
    const v = await kit.run((tx) =>
      svc().addVariation(order.id, { amount: '10', reason: 'r' }, kit.pm, tx),
    );
    await kit.draftCertificate(order.id);
    await refused(
      kit.run((tx) =>
        svc().decideVariation(v.id, { decision: 'approved', version: v.version }, kit.owner, tx),
      ),
      'open_certificate',
    );
    await refused(
      kit.run((tx) =>
        svc().updateVariation(
          '018f7c7c-0000-7000-8000-00000000dead',
          { amount: '1', reason: 'r', version: 1 },
          kit.pm,
          tx,
        ),
      ),
      'variation_not_found',
    );
    const draft = await kit.draftOrder();
    await refused(
      kit.run((tx) => svc().addVariation(draft.id, { amount: '10', reason: 'r' }, kit.pm, tx)),
      'order_not_active',
    );
    await refused(
      kit.run((tx) => svc().addVariation(draft.id, { amount: '10', reason: ' ' }, kit.pm, tx)),
      'order_not_active',
    );
  });
});

describe('reading orders (BR-9, T-6)', () => {
  it('hides every amount from a supervisor and shows only the assigned projects', async () => {
    const order = await kit.activeOrder();
    const other = await kit.activeOrder();
    await kit.run((tx) => svc().addVariation(order.id, { amount: '10', reason: 'r' }, kit.pm, tx));
    const supervisor = kit.supervisorOf([order.projectId]);
    const seen = await svc().get(kit.db, order.id, supervisor);
    expect(seen).toMatchObject({
      contractAmount: null,
      currentContractAmount: null,
      certifiedAmount: null,
      committedAmount: null,
    });
    expect(seen.variations[0]?.amount).toBeNull();
    expect(seen.title).toBe(order.title);
    await refused(svc().get(kit.db, other.id, supervisor), 'project_not_found');
    const page = await svc().list(kit.db, { limit: 100, offset: 0 }, supervisor);
    expect(page.items.map((o) => o.id)).toEqual([order.id]);
    expect(page.items[0]?.contractAmount).toBeNull();
    // Someone who may read amounts sees them, and filters narrow the list.
    const all = await svc().list(kit.db, { limit: 100, offset: 0 }, kit.owner);
    expect(all.items.length).toBeGreaterThan(1);
    const filtered = await svc().list(
      kit.db,
      {
        projectId: other.projectId,
        partyId: other.partyId,
        status: 'active',
        limit: 10,
        offset: 0,
      },
      kit.owner,
    );
    expect(filtered).toMatchObject({
      total: 1,
      items: [{ id: other.id, contractAmount: '1000000.00' }],
    });
    await refused(
      svc().get(kit.db, '018f7c7c-0000-7000-8000-00000000dead', kit.owner),
      'work_order_not_found',
    );
  });

  it('answers the module interfaces', async () => {
    const order = await kit.activeOrder();
    expect(await kit.subcontracts.getCertifiedAmount(kit.db, order.id)).toBe('0.00');
    await kit.certified(order.id, { cumulativePercent: '25' });
    expect(await kit.subcontracts.getCertifiedAmount(kit.db, order.id)).toBe('250000.00');
    expect((await kit.subcontracts.getWorkOrder(kit.db, order.id, kit.owner)).id).toBe(order.id);
    await refused(
      kit.subcontracts.getCertifiedAmount(kit.db, '018f7c7c-0000-7000-8000-00000000dead'),
      'work_order_not_found',
    );
  });
});

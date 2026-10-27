import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MISSING,
  PM,
  STORE,
  SUPERVISOR,
  auditCount,
  createProcurementKit,
  eventCount,
  type ProcurementKit,
} from '../test-support.js';

let kit: ProcurementKit;
beforeAll(async () => {
  kit = await createProcurementKit();
}, 120_000);
afterAll(() => kit.close());

const svc = () => kit.procurement.service;
const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};
const getReq = (id: string) => svc().requisitions.get(kit.db, id, kit.actor);

describe('requisition create (BR-1)', () => {
  it('numbers requisitions per year and stores a store-destined draft', async () => {
    const before = await auditCount(kit.db, 'procurement.requisition.create');
    const first = await kit.requisition();
    const second = await kit.requisition();
    const dto = await getReq(first.id);
    expect(dto.number).toBe('REQ-2026-0001');
    expect((await getReq(second.id)).number).toBe('REQ-2026-0002');
    expect(dto).toMatchObject({
      storeId: STORE,
      projectId: null,
      status: 'draft',
      approval: { status: 'none' },
    });
    expect(
      dto.lines.map((l) => [l.lineNo, l.quantity, l.estimatedRate, l.unitCode, l.orderedQty]),
    ).toEqual([
      [1, '100.0000', '1200.0000', 'bag', '0.0000'],
      [2, '40.0000', null, 'bag', '0.0000'],
    ]);
    expect(await auditCount(kit.db, 'procurement.requisition.create')).toBe(before + 2);
  });

  it('needs exactly one destination and a known project', async () => {
    const item = await kit.item();
    const line = { itemId: item, quantity: '1', costCodeId: kit.codes['100'] as string };
    const create = (over: object) =>
      tx((db) => svc().requisitions.create({ lines: [line], ...over }, kit.actor, db));
    expect(await codeOf(create({}))).toBe('destination_required');
    expect(await codeOf(create({ storeId: STORE, projectId: MISSING }))).toBe(
      'destination_required',
    );
    expect(await codeOf(create({ projectId: MISSING }))).toBe('project_not_found');
    const project = await kit.project();
    expect((await create({ projectId: project.id })).projectId).toBe(project.id);
  });

  it('checks items, cost codes and quantities', async () => {
    const good = await kit.item();
    const create = (line: object) =>
      tx((db) =>
        svc().requisitions.create({ storeId: STORE, lines: [line as never] }, kit.actor, db),
      );
    const base = { itemId: good, quantity: '1', costCodeId: kit.codes['100'] as string };
    expect(await codeOf(create({ ...base, itemId: MISSING }))).toBe('item_not_found');
    expect(await codeOf(create({ ...base, itemId: await kit.item({ active: false }) }))).toBe(
      'item_inactive',
    );
    expect(await codeOf(create({ ...base, costCodeId: kit.inactiveCode }))).toBe(
      'cost_code_inactive',
    );
    expect(await codeOf(create({ ...base, quantity: '0' }))).toBe('quantity_invalid');
    expect(
      await codeOf(
        tx((db) => svc().requisitions.create({ storeId: STORE, lines: [] }, kit.actor, db)),
      ),
    ).toBe('lines_required');
  });

  it('lets a supervisor raise requisitions only for assigned projects (BR-12)', async () => {
    const project = await kit.project();
    const other = await kit.project();
    await kit.assignSupervisor(project.id, SUPERVISOR);
    const supervisor = kit.actorFor(SUPERVISOR, [{ type: 'project', id: project.id }]);
    const line = {
      itemId: await kit.item(),
      quantity: '2',
      costCodeId: kit.codes['100'] as string,
    };
    const create = (over: object) =>
      tx((db) => svc().requisitions.create({ lines: [line], ...over }, supervisor, db));
    const mine = await create({ projectId: project.id });
    expect(mine.requestedBy).toBe(SUPERVISOR);
    expect(await codeOf(create({ projectId: other.id }))).toBe('destination_not_found');
    expect(await codeOf(create({ storeId: STORE }))).toBe('destination_not_found');
    const theirs = await kit.requisition({ projectId: other.id });
    expect(await codeOf(svc().requisitions.get(kit.db, theirs.id, supervisor))).toBe(
      'destination_not_found',
    );
    expect((await svc().requisitions.get(kit.db, mine.id, supervisor)).id).toBe(mine.id);
    const listed = await svc().requisitions.list(kit.db, { limit: 50, offset: 0 }, supervisor);
    expect(listed.items.map((r) => r.id)).toContain(mine.id);
    expect(listed.items.map((r) => r.id)).not.toContain(theirs.id);
  });
});

describe('requisition update, list, cancel', () => {
  it('edits a draft with the expected version only', async () => {
    const { id, version } = await kit.requisition();
    const input = {
      storeId: STORE,
      requiredBy: '2026-11-05',
      note: ' changed ',
      lines: [{ itemId: await kit.item(), quantity: '7', costCodeId: kit.codes['100'] as string }],
    };
    expect(
      await codeOf(tx((db) => svc().requisitions.update(id, input, version + 5, kit.actor, db))),
    ).toBe('version_conflict');
    const updated = await tx((db) => svc().requisitions.update(id, input, version, kit.actor, db));
    expect(updated).toMatchObject({
      note: 'changed',
      requiredBy: '2026-11-05',
      version: version + 1,
    });
    expect(updated.lines).toHaveLength(1);
    const project = await kit.project();
    const moved = await tx((db) =>
      svc().requisitions.update(
        id,
        { ...input, storeId: undefined, projectId: project.id },
        version + 1,
        kit.actor,
        db,
      ),
    );
    expect(moved).toMatchObject({ projectId: project.id, storeId: null });
    expect(
      await codeOf(
        tx((db) =>
          svc().requisitions.update(
            id,
            { ...input, projectId: MISSING, storeId: undefined },
            version + 2,
            kit.actor,
            db,
          ),
        ),
      ),
    ).toBe('project_not_found');
    const bare = await tx((db) =>
      svc().requisitions.update(
        id,
        { storeId: STORE, lines: input.lines },
        version + 2,
        kit.actor,
        db,
      ),
    );
    expect(bare).toMatchObject({ note: '', requiredBy: null });
    expect(
      await codeOf(tx((db) => svc().requisitions.update(MISSING, input, 1, kit.actor, db))),
    ).toBe('requisition_not_found');
  });

  it('lists with filters', async () => {
    const project = await kit.project();
    const mine = await kit.requisition({ projectId: project.id });
    const byProject = await svc().requisitions.list(
      kit.db,
      { projectId: project.id, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(byProject.items.map((r) => r.id)).toEqual([mine.id]);
    const byStore = await svc().requisitions.list(
      kit.db,
      { storeId: STORE, status: 'draft', limit: 1, offset: 0 },
      kit.actor,
    );
    expect(byStore.items).toHaveLength(1);
    expect(byStore.total).toBeGreaterThan(1);
    expect(
      (await svc().requisitions.list(kit.db, { status: 'ordered', limit: 5, offset: 0 }, kit.actor))
        .items,
    ).toEqual([]);
  });

  it('submits through the engine and follows the decision (BR-1)', async () => {
    const { id, version } = await kit.requisition();
    const submitted = await tx((db) => svc().requisitions.submit(id, version, kit.actor, db));
    expect(submitted.status).toBe('pending_approval');
    expect(submitted.approval.status).toBe('pending');
    expect(
      await codeOf(tx((db) => svc().requisitions.submit(id, version + 1, kit.actor, db))),
    ).toBe('requisition_transition');
    expect(
      await codeOf(
        tx((db) =>
          svc().requisitions.update(id, { storeId: STORE, lines: [] }, version + 1, kit.actor, db),
        ),
      ),
    ).toBe('requisition_read_only');
    await kit.decide('requisition', id, 'approve');
    expect((await getReq(id)).status).toBe('approved');
    // A replayed or late event finds the requisition already decided.
    await tx((db) =>
      svc().requisitions.onApprovalOutcome('rejected', { docId: id, requesterId: PM }, db),
    );
    await tx((db) =>
      svc().requisitions.onApprovalOutcome('approved', { docId: MISSING, requesterId: PM }, db),
    );
    expect((await getReq(id)).status).toBe('approved');
  });

  it('rejected ends it, returned goes back to a draft, cancelling the request is ignored', async () => {
    const rejected = await kit.requisition();
    await tx((db) => svc().requisitions.submit(rejected.id, rejected.version, kit.actor, db));
    await kit.decide('requisition', rejected.id, 'reject');
    expect((await getReq(rejected.id)).status).toBe('rejected');
    expect(
      await codeOf(
        tx((db) => svc().requisitions.cancel(rejected.id, rejected.version + 2, kit.actor, db)),
      ),
    ).toBe('requisition_transition');

    const returned = await kit.requisition();
    await tx((db) => svc().requisitions.submit(returned.id, returned.version, kit.actor, db));
    await kit.decide('requisition', returned.id, 'return');
    expect((await getReq(returned.id)).status).toBe('draft');
  });

  it('cancels a draft, a pending request (withdrawing the approval) and an approved requisition', async () => {
    const draft = await kit.requisition();
    expect(
      await codeOf(
        tx((db) => svc().requisitions.cancel(draft.id, draft.version + 3, kit.actor, db)),
      ),
    ).toBe('version_conflict');
    expect(
      (await tx((db) => svc().requisitions.cancel(draft.id, draft.version, kit.actor, db))).status,
    ).toBe('cancelled');

    const pending = await kit.requisition();
    await tx((db) => svc().requisitions.submit(pending.id, pending.version, kit.actor, db));
    const cancelled = await tx((db) =>
      svc().requisitions.cancel(pending.id, pending.version + 1, kit.actor, db),
    );
    expect(cancelled.status).toBe('cancelled');
    await kit.platform.events.dispatchDue(kit.db);
    expect((await getReq(pending.id)).status).toBe('cancelled');

    const approved = await kit.approvedRequisition();
    const version = (await getReq(approved)).version;
    expect(
      (await tx((db) => svc().requisitions.cancel(approved, version, kit.actor, db))).status,
    ).toBe('cancelled');
  });
});

describe('request for quotation and comparison (BR-2)', () => {
  async function sourcing() {
    const requisition = await kit.approvedRequisition();
    const req = await getReq(requisition);
    const [vendorA, vendorB, vendorC] = [
      await kit.vendor(),
      await kit.vendor(),
      await kit.vendor(),
    ];
    const rfq = await tx((db) =>
      svc().rfqs.create(
        { requisitionId: requisition, vendorIds: [vendorA, vendorB, vendorC, vendorA] },
        kit.actor,
        db,
      ),
    );
    return {
      requisition,
      req,
      rfq,
      vendorA: vendorA,
      vendorB: vendorB,
      vendorC: vendorC,
      lines: req.lines,
    };
  }
  const quote = (rfqId: string, vendorId: string, rates: [string, string][], over: object = {}) =>
    tx((db) =>
      svc().rfqs.createQuote(
        {
          rfqId,
          vendorId,
          lines: rates.map(([requisitionLineId, rate]) => ({ requisitionLineId, rate })),
          ...over,
        },
        kit.actor,
        db,
      ),
    );

  it('creates an RFQ for an approved requisition and invites distinct vendors', async () => {
    const { rfq, vendorA, requisition } = await sourcing();
    expect(rfq).toMatchObject({
      number: 'RFQ-2026-0001',
      status: 'open',
      requisitionId: requisition,
    });
    expect(rfq.vendorIds).toHaveLength(3);
    expect(rfq.vendorIds).toContain(vendorA);
    expect(rfq.comparison.lines).toHaveLength(2);
    expect(rfq.comparison.totals).toEqual([]);
    const draft = await kit.requisition();
    expect(
      await codeOf(
        tx((db) =>
          svc().rfqs.create({ requisitionId: draft.id, vendorIds: [vendorA] }, kit.actor, db),
        ),
      ),
    ).toBe('requisition_not_approved');
    expect(
      await codeOf(
        tx((db) =>
          svc().rfqs.create({ requisitionId: MISSING, vendorIds: [vendorA] }, kit.actor, db),
        ),
      ),
    ).toBe('requisition_not_found');
    expect(
      await codeOf(
        tx((db) => svc().rfqs.create({ requisitionId: requisition, vendorIds: [] }, kit.actor, db)),
      ),
    ).toBe('vendors_required');
    const client = await kit.vendor({ roles: ['client'] });
    expect(
      await codeOf(
        tx((db) =>
          svc().rfqs.create({ requisitionId: requisition, vendorIds: [client] }, kit.actor, db),
        ),
      ),
    ).toBe('not_a_vendor');
    expect(
      await codeOf(
        tx((db) =>
          svc().rfqs.create({ requisitionId: requisition, vendorIds: [MISSING] }, kit.actor, db),
        ),
      ),
    ).toBe('vendor_not_found');
  });

  it('ranks quotes by line rate and by total (T-2)', async () => {
    const { rfq, lines, vendorA, vendorB, vendorC } = await sourcing();
    const [l1, l2] = [lines[0]!.id, lines[1]!.id];
    const qa = await quote(
      rfq.id,
      vendorA,
      [
        [l1, '1250'],
        [l2, '90'],
      ],
      { validUntil: '2026-11-30', deliveryDays: 5, terms: ' net 30 ' },
    );
    const qb = await quote(rfq.id, vendorB, [
      [l1, '1200'],
      [l2, '100'],
    ]);
    const qc = await quote(rfq.id, vendorC, [[l1, '1000']]);
    expect(qa).toMatchObject({
      total: '128600.00',
      deliveryDays: 5,
      terms: 'net 30',
      validUntil: '2026-11-30',
    });
    const sheet = (await svc().rfqs.get(kit.db, rfq.id, kit.actor)).comparison;
    expect(sheet.lines[0]!.ranking.map((r) => [r.vendorId, r.rank])).toEqual([
      [vendorC, 1],
      [vendorB, 2],
      [vendorA, 3],
    ]);
    expect(sheet.lines[1]!.ranking.map((r) => r.vendorId)).toEqual([vendorA, vendorB]);
    expect(sheet.totals.map((t) => [t.quoteId, t.complete, t.rank])).toEqual([
      [qb.id, true, 1],
      [qa.id, true, 2],
      [qc.id, false, 3],
    ]);
    expect((await svc().rfqs.getQuote(kit.db, qa.id, kit.actor)).lines).toHaveLength(2);
    expect(await codeOf(svc().rfqs.getQuote(kit.db, MISSING, kit.actor))).toBe('quote_not_found');
  });

  it('validates quotes', async () => {
    const { rfq, lines, vendorA } = await sourcing();
    const l1 = lines[0]!.id;
    const outsider = await kit.vendor();
    expect(await codeOf(quote(rfq.id, outsider, [[l1, '1']]))).toBe('vendor_not_invited');
    expect(await codeOf(quote(rfq.id, vendorA, []))).toBe('lines_required');
    expect(await codeOf(quote(rfq.id, vendorA, [[MISSING, '1']]))).toBe('line_not_found');
    expect(
      await codeOf(
        quote(rfq.id, vendorA, [
          [l1, '1'],
          [l1, '2'],
        ]),
      ),
    ).toBe('duplicate_line');
    expect(await codeOf(quote(MISSING, vendorA, [[l1, '1']]))).toBe('rfq_not_found');
    const made = await quote(rfq.id, vendorA, [[l1, '1']]);
    expect(await codeOf(quote(rfq.id, vendorA, [[l1, '1']]))).toBe('quote_exists');
    const update = (version: number, rate = '2') =>
      tx((db) =>
        svc().rfqs.updateQuote(
          made.id,
          { lines: [{ requisitionLineId: l1, rate }] },
          version,
          kit.actor,
          db,
        ),
      );
    expect(await codeOf(update(made.version + 4))).toBe('version_conflict');
    const changed = await update(made.version, '2.5');
    expect(changed).toMatchObject({ total: '250.00', version: made.version + 1 });
    expect(
      await codeOf(tx((db) => svc().rfqs.updateQuote(MISSING, { lines: [] }, 1, kit.actor, db))),
    ).toBe('quote_not_found');
    await tx((db) => svc().rfqs.close(rfq.id, rfq.version, kit.actor, db));
    expect(await codeOf(update(changed.version))).toBe('rfq_closed');
    expect(await codeOf(quote(rfq.id, vendorA, [[l1, '1']]))).toBe('rfq_closed');
  });

  it('a non-lowest vendor needs a reason; ties and the lowest do not (BR-2)', async () => {
    const { rfq, lines, vendorA, vendorB, vendorC } = await sourcing();
    const [l1, l2] = [lines[0]!.id, lines[1]!.id];
    const qa = await quote(rfq.id, vendorA, [
      [l1, '1250'],
      [l2, '90'],
    ]);
    const qb = await quote(rfq.id, vendorB, [
      [l1, '1000'],
      [l2, '100'],
    ]);
    const qc = await quote(rfq.id, vendorC, [[l1, '1000']]);
    const select = (requisitionLineId: string, quoteId: string, reason?: string) =>
      tx((db) =>
        svc().rfqs.selectVendor(rfq.id, { requisitionLineId, quoteId, reason }, kit.actor, db),
      );
    expect(await codeOf(select(l1, qa.id))).toBe('selection_reason_required');
    expect(await codeOf(select(l1, qa.id, '   '))).toBe('selection_reason_required');
    expect((await select(l1, qb.id)).selections).toHaveLength(1);
    const tied = await select(l1, qc.id);
    expect(tied.selections.find((s) => s.requisitionLineId === l1)).toMatchObject({
      vendorId: vendorC,
      reason: null,
    });
    const reasoned = await select(l1, qa.id, ' Closer to site ');
    expect(reasoned.selections.find((s) => s.requisitionLineId === l1)).toMatchObject({
      vendorId: vendorA,
      reason: 'Closer to site',
    });
    expect(await codeOf(select(l2, qc.id))).toBe('quote_line_missing');
    expect(await codeOf(select(MISSING, qa.id))).toBe('line_not_quoted');
    expect(
      await codeOf(
        tx((db) =>
          svc().rfqs.selectVendor(
            MISSING,
            { requisitionLineId: l1, quoteId: qa.id },
            kit.actor,
            db,
          ),
        ),
      ),
    ).toBe('rfq_not_found');
    expect((await select(l2, qa.id)).selections).toHaveLength(2);
  });

  it('closes once, lists, and keeps a scoped caller to their projects', async () => {
    const { rfq, vendorA, requisition } = await sourcing();
    expect(await codeOf(tx((db) => svc().rfqs.close(rfq.id, rfq.version + 3, kit.actor, db)))).toBe(
      'version_conflict',
    );
    const closed = await tx((db) => svc().rfqs.close(rfq.id, rfq.version, kit.actor, db));
    expect(closed.status).toBe('closed');
    expect(await codeOf(tx((db) => svc().rfqs.close(rfq.id, closed.version, kit.actor, db)))).toBe(
      'rfq_closed',
    );
    expect(await codeOf(svc().rfqs.get(kit.db, MISSING, kit.actor))).toBe('rfq_not_found');

    const listed = await svc().rfqs.list(
      kit.db,
      { requisitionId: requisition, limit: 10, offset: 0 },
      kit.actor,
    );
    expect(listed.items.map((r) => r.id)).toEqual([rfq.id]);
    expect(
      (await svc().rfqs.list(kit.db, { limit: 100, offset: 0 }, kit.actor)).total,
    ).toBeGreaterThan(0);

    const project = await kit.project();
    const forProject = await kit.approvedRequisition({ projectId: project.id, storeId: undefined });
    const projectRfq = await tx((db) =>
      svc().rfqs.create({ requisitionId: forProject, vendorIds: [vendorA] }, kit.actor, db),
    );
    const outsider = kit.actorFor(SUPERVISOR, []);
    expect(await codeOf(svc().rfqs.get(kit.db, projectRfq.id, outsider))).toBe(
      'destination_not_found',
    );
    expect(await codeOf(svc().rfqs.get(kit.db, rfq.id, outsider))).toBe('destination_not_found');
    expect(
      (
        await svc().rfqs.get(
          kit.db,
          projectRfq.id,
          kit.actorFor(SUPERVISOR, [{ type: 'project', id: project.id }]),
        )
      ).id,
    ).toBe(projectRfq.id);
    expect(await eventCount(kit.db, 'procurement.rfq.changed')).toBeGreaterThan(0);
  });
});

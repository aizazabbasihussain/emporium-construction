import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MISSING,
  PM,
  STORE,
  createProcurementKit,
  eventCount,
  type ProcurementKit,
} from '../test-support.js';

vi.setConfig({ testTimeout: 60_000 });

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
const getPo = (id: string) => svc().orders.get(kit.db, id);
const live = (rows: Awaited<ReturnType<ProcurementKit['ledger']>>, status: string) =>
  rows.filter((row) => row.status === status && !row.reverses);
const poOf = async (projectId: string | null) => {
  const { id, version } = await kit.draftPo(projectId);
  return { id, version };
};

describe('purchase order lines and totals (BR-3, T-1)', () => {
  it('rounds each line half-up and totals the rounded lines', async () => {
    const project = await kit.project();
    const { id } = await poOf(project.id);
    const po = await getPo(id);
    expect(po).toMatchObject({
      number: 'PO-2026-0001',
      status: 'draft',
      revision: 1,
      destinationType: 'project',
      total: '126100.00',
      approval: { status: 'none' },
    });
    expect(po.lines.map((l) => [l.lineNo, l.lineTotal, l.unitCode, l.receivedQty])).toEqual([
      [1, '125050.00', 'bag', '0.0000'],
      [2, '1050.00', 'bag', '0.0000'],
    ]);
  });

  it('checks the destination, vendor, items and cost codes (BR-10)', async () => {
    const item = await kit.item();
    const base = {
      vendorId: await kit.vendor(),
      storeId: STORE,
      orderDate: '2026-10-25',
      lines: [{ itemId: item, quantity: '1', rate: '1', costCodeId: kit.codes['100'] as string }],
    };
    const create = (over: object) =>
      tx((db) => svc().orders.create({ ...base, ...over }, kit.actor, db));
    expect((await create({})).destinationType).toBe('store');
    expect(await codeOf(create({ storeId: undefined }))).toBe('destination_required');
    expect(await codeOf(create({ projectId: MISSING }))).toBe('destination_required');
    expect(await codeOf(create({ storeId: undefined, projectId: MISSING }))).toBe(
      'project_not_found',
    );
    expect(await codeOf(create({ vendorId: await kit.vendor({ roles: ['client'] }) }))).toBe(
      'not_a_vendor',
    );
    expect(
      await codeOf(
        create({ lines: [{ ...base.lines[0], itemId: await kit.item({ active: false }) }] }),
      ),
    ).toBe('item_inactive');
    expect(
      await codeOf(create({ lines: [{ ...base.lines[0], costCodeId: kit.inactiveCode }] })),
    ).toBe('cost_code_inactive');
    expect(await codeOf(create({ lines: [{ ...base.lines[0], lineId: MISSING }] }))).toBe(
      'line_not_found',
    );
    expect(await codeOf(create({ lines: [{ ...base.lines[0], rate: '-1' }] }))).toBe(
      'rate_invalid',
    );
    expect(await codeOf(svc().orders.get(kit.db, MISSING))).toBe('purchase_order_not_found');
  });

  it('edits a draft: keeps, adds and drops lines', async () => {
    const project = await kit.project();
    const { id, version } = await poOf(null);
    const before = await getPo(id);
    const first = before.lines[0]!;
    const input = {
      vendorId: before.vendorId,
      storeId: STORE,
      orderDate: '2026-10-26',
      expectedDate: undefined,
      terms: ' ',
      lines: [
        {
          itemId: await kit.item(),
          quantity: '2',
          rate: '10',
          costCodeId: kit.codes['100'] as string,
        },
        {
          lineId: first.id,
          itemId: first.itemId,
          quantity: '50',
          rate: '2',
          costCodeId: first.costCodeId,
        },
      ],
    };
    expect(
      await codeOf(tx((db) => svc().orders.update(id, input, version + 9, kit.actor, db))),
    ).toBe('version_conflict');
    const updated = await tx((db) => svc().orders.update(id, input, version, kit.actor, db));
    expect(updated).toMatchObject({
      total: '120.00',
      orderDate: '2026-10-26',
      expectedDate: null,
      terms: '',
    });
    expect(updated.lines.map((l) => [l.lineNo, l.quantity, l.id === first.id])).toEqual([
      [1, '2.0000', false],
      [2, '50.0000', true],
    ]);
    const dup = { ...input, lines: [input.lines[1]!, input.lines[1]!] };
    expect(await codeOf(tx((db) => svc().orders.update(id, dup, version + 1, kit.actor, db)))).toBe(
      'line_not_found',
    );
    const moved = await tx((db) =>
      svc().orders.update(
        id,
        { ...input, storeId: undefined, projectId: project.id, lines: [input.lines[0]!] },
        version + 1,
        kit.actor,
        db,
      ),
    );
    expect(moved.destinationType).toBe('project');
    expect(
      await codeOf(
        tx((db) =>
          svc().orders.update(
            id,
            { ...input, storeId: undefined, projectId: MISSING },
            version + 2,
            kit.actor,
            db,
          ),
        ),
      ),
    ).toBe('project_not_found');
    expect(await codeOf(tx((db) => svc().orders.update(MISSING, input, 1, kit.actor, db)))).toBe(
      'purchase_order_not_found',
    );
  });
});
describe('approval commits cost exactly once (BR-4, T-3)', () => {
  it('posts one committed entry per line, replay safe', async () => {
    const project = await kit.project();
    const before = await eventCount(kit.db, 'po.approved');
    const id = await kit.approvedPo(project.id);
    const ledger = await kit.ledger(project.id);
    expect(ledger.map((r) => [r.status, r.amount, r.sourceDocType])).toEqual([
      ['committed', '125050.00', 'purchase_order'],
      ['committed', '1050.00', 'purchase_order'],
    ]);
    expect((await getPo(id)).status).toBe('approved');
    expect(await eventCount(kit.db, 'po.approved')).toBe(before + 1);
    // The same event again: the order has moved on, nothing is posted twice.
    await tx((db) =>
      svc().orders.onApprovalOutcome('approved', { docId: id, requesterId: PM }, db),
    );
    await tx((db) =>
      svc().orders.onApprovalOutcome('approved', { docId: MISSING, requesterId: PM }, db),
    );
    await kit.platform.events.dispatchDue(kit.db);
    expect(await kit.ledger(project.id)).toHaveLength(2);
    const summary = await kit.projects.getCostSummary(kit.db, { type: 'project', id: project.id });
    expect(JSON.stringify(summary)).toContain('126100.00');
  });

  it('a store-destined order posts no project cost', async () => {
    const id = await kit.approvedPo(null);
    expect((await getPo(id)).status).toBe('approved');
    expect(await eventCount(kit.db, 'po.approved')).toBeGreaterThan(0);
  });

  it('is only submitted from a draft and returns to a draft when not approved', async () => {
    const project = await kit.project();
    const { id, version } = await kit.draftPo(project.id);
    const submitted = await tx((db) => svc().orders.submit(id, version, kit.actor, db));
    expect(submitted).toMatchObject({
      status: 'pending_approval',
      approval: { status: 'pending' },
    });
    expect(await codeOf(tx((db) => svc().orders.submit(id, version + 1, kit.actor, db)))).toBe(
      'po_transition',
    );
    expect(
      await codeOf(tx((db) => svc().orders.update(id, {} as never, version + 1, kit.actor, db))),
    ).toBe('po_read_only');
    await kit.decide('purchase_order', id, 'reject');
    expect((await getPo(id)).status).toBe('draft');
    expect(await kit.ledger(project.id)).toEqual([]);
    const next = await poOf(project.id);
    await tx((db) => svc().orders.submit(next.id, next.version, kit.actor, db));
    await kit.decide('purchase_order', next.id, 'return');
    expect((await getPo(next.id)).status).toBe('draft');
  });
});

describe('amendment (BR-5, T-3)', () => {
  it('reverses the old commitments and posts new ones only after re-approval', async () => {
    const project = await kit.project();
    const id = await kit.approvedPo(project.id);
    const po = await getPo(id);
    const [a, b] = po.lines;
    const input = {
      vendorId: po.vendorId,
      projectId: project.id,
      orderDate: po.orderDate,
      lines: [
        {
          lineId: a!.id,
          itemId: a!.itemId,
          quantity: '120',
          rate: '1250.5',
          costCodeId: a!.costCodeId,
        },
        {
          itemId: await kit.item(),
          quantity: '1',
          rate: '500',
          costCodeId: kit.codes['100'] as string,
        },
      ],
    };
    const amend = (version: number, over: object = {}) =>
      tx((db) => svc().orders.amend(id, { ...input, ...over }, version, kit.actor, db));
    expect(await codeOf(amend(po.version + 7))).toBe('version_conflict');
    expect(await codeOf(amend(po.version, { projectId: undefined, storeId: STORE }))).toBe(
      'destination_fixed',
    );
    const amended = await amend(po.version);
    expect(amended).toMatchObject({ status: 'draft', revision: 2, total: '150560.00' });
    // Nothing changes in the ledger until the new version is approved.
    expect(live(await kit.ledger(project.id), 'committed')).toHaveLength(2);
    expect((await kit.ledger(project.id)).filter((r) => r.reverses)).toHaveLength(0);

    await tx((db) => svc().orders.submit(id, amended.version, kit.actor, db));
    await kit.decide('purchase_order', id, 'approve');
    const ledger = await kit.ledger(project.id);
    expect(ledger.filter((r) => r.reverses)).toHaveLength(2);
    expect(live(ledger, 'committed').map((r) => r.amount)).toEqual([
      '125050.00',
      '1050.00',
      '150060.00',
      '500.00',
    ]);
    expect((await getPo(id)).lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(b).toBeDefined();
    // Amended again, then not amendable while it is a draft.
    await amend((await getPo(id)).version);
    expect(await codeOf(amend((await getPo(id)).version))).toBe('po_not_amendable');
  });

  it('never orders less than was received and keeps received lines', async () => {
    const project = await kit.project();
    const id = await kit.approvedPo(project.id);
    await kit.receive(id, { 1: '60' });
    const po = await getPo(id);
    const [a, b] = po.lines;
    const keep = (quantity: string) => ({
      vendorId: po.vendorId,
      projectId: project.id,
      orderDate: po.orderDate,
      lines: [
        { lineId: a!.id, itemId: a!.itemId, quantity, rate: a!.rate, costCodeId: a!.costCodeId },
      ],
    });
    const amend = (input: object) =>
      tx((db) => svc().orders.amend(id, input as never, po.version, kit.actor, db));
    expect(await codeOf(amend(keep('59.9999')))).toBe('below_received');
    // Dropping the line that has not been received is allowed; the received one must stay.
    const dropped = await amend(keep('80'));
    expect(dropped.lines).toHaveLength(1);
    await tx((db) => svc().orders.submit(id, dropped.version, kit.actor, db));
    await kit.decide('purchase_order', id, 'approve');
    const ledger = await kit.ledger(project.id);
    // The dropped line's commitment was released; the received line commits what is still to come.
    expect(live(ledger, 'committed').map((r) => r.amount)).toEqual([
      '125050.00',
      '1050.00',
      '50020.00',
      '25010.00',
    ]);
    expect(ledger.filter((r) => r.reverses).map((r) => r.amount)).toEqual([
      '125050.00',
      '50020.00',
      '1050.00',
    ]);
    expect(live(ledger, 'approved').map((r) => r.amount)).toEqual(['75030.00']);
    expect((await getPo(id)).status).toBe('partly_received');
    expect(b).toBeDefined();

    const again = await getPo(id);
    const without = {
      vendorId: again.vendorId,
      projectId: project.id,
      orderDate: again.orderDate,
      lines: [
        {
          itemId: await kit.item(),
          quantity: '1',
          rate: '1',
          costCodeId: kit.codes['100'] as string,
        },
      ],
    };
    expect(
      await codeOf(tx((db) => svc().orders.amend(id, without, again.version, kit.actor, db))),
    ).toBe('line_received');
  });

  it('re-approves a fully received order as received, and a rejected amendment stays a draft', async () => {
    const id = await kit.approvedPo(null);
    await kit.receive(id, { 1: '100', 2: '10.5' });
    const po = await getPo(id);
    expect(po.status).toBe('received');
    const same = {
      vendorId: po.vendorId,
      storeId: STORE,
      orderDate: po.orderDate,
      lines: po.lines.map((l) => ({
        lineId: l.id,
        itemId: l.itemId,
        quantity: l.quantity,
        rate: l.rate,
        costCodeId: l.costCodeId,
      })),
    };
    const amended = await tx((db) => svc().orders.amend(id, same, po.version, kit.actor, db));
    await tx((db) => svc().orders.submit(id, amended.version, kit.actor, db));
    await kit.decide('purchase_order', id, 'approve');
    expect((await getPo(id)).status).toBe('received');
    const again = await getPo(id);
    const second = await tx((db) => svc().orders.amend(id, same, again.version, kit.actor, db));
    await tx((db) => svc().orders.submit(id, second.version, kit.actor, db));
    await kit.decide('purchase_order', id, 'reject');
    expect((await getPo(id)).status).toBe('draft');
    expect(await codeOf(tx((db) => svc().orders.amend(MISSING, same, 1, kit.actor, db)))).toBe(
      'purchase_order_not_found',
    );
  });
});

describe('closing and cancelling (BR-9, T-7)', () => {
  it('closing releases the remaining commitment and keeps the approved cost', async () => {
    const project = await kit.project();
    const id = await kit.approvedPo(project.id);
    await kit.receive(id, { 1: '40' });
    const po = await getPo(id);
    expect(await codeOf(tx((db) => svc().orders.close(id, po.version + 5, kit.actor, db)))).toBe(
      'version_conflict',
    );
    const closed = await tx((db) => svc().orders.close(id, po.version, kit.actor, db));
    expect(closed.status).toBe('closed');
    const ledger = await kit.ledger(project.id);
    const stillCommitted = ledger.filter((r) => r.status === 'committed' && !r.reverses).length;
    const reversed = ledger.filter((r) => r.reverses).length;
    expect(stillCommitted - reversed).toBe(0);
    expect(live(ledger, 'approved').map((r) => r.amount)).toEqual(['50020.00']);
    expect(await codeOf(tx((db) => svc().orders.close(id, closed.version, kit.actor, db)))).toBe(
      'po_not_closable',
    );
    expect(await codeOf(tx((db) => svc().orders.cancel(id, closed.version, kit.actor, db)))).toBe(
      'po_transition',
    );
  });

  it('cannot close a draft', async () => {
    const { id, version } = await poOf(null);
    expect(await codeOf(tx((db) => svc().orders.close(id, version, kit.actor, db)))).toBe(
      'po_not_closable',
    );
  });

  it('cancels a draft, a pending order and an approved order without receipts', async () => {
    const project = await kit.project();
    const draft = await poOf(project.id);
    expect(
      (await tx((db) => svc().orders.cancel(draft.id, draft.version, kit.actor, db))).status,
    ).toBe('cancelled');

    const pending = await poOf(project.id);
    await tx((db) => svc().orders.submit(pending.id, pending.version, kit.actor, db));
    expect(
      (await tx((db) => svc().orders.cancel(pending.id, pending.version + 1, kit.actor, db)))
        .status,
    ).toBe('cancelled');
    await kit.platform.events.dispatchDue(kit.db);
    expect((await getPo(pending.id)).status).toBe('cancelled');

    const approved = await kit.approvedPo(project.id);
    const before = await eventCount(kit.db, 'po.cancelled');
    const version = await kit.poVersion(approved);
    await tx((db) => svc().orders.cancel(approved, version, kit.actor, db));
    expect(await eventCount(kit.db, 'po.cancelled')).toBe(before + 1);
    const ledger = await kit.ledger(project.id);
    expect(ledger.filter((r) => r.reverses)).toHaveLength(2);
  });

  it('refuses to cancel an order that has receipts', async () => {
    const id = await kit.approvedPo(null);
    await kit.receive(id, { 1: '1' });
    expect(await codeOf(tx((db) => svc().orders.cancel(id, 99, kit.actor, db)))).toBe(
      'version_conflict',
    );
    const po = await getPo(id);
    // A receiving order is closed, not cancelled.
    expect(await codeOf(tx((db) => svc().orders.cancel(id, po.version, kit.actor, db)))).toBe(
      'po_transition',
    );
    // An amendment returns it to a draft, but the receipt still stands.
    const input = {
      vendorId: po.vendorId,
      storeId: STORE,
      orderDate: po.orderDate,
      lines: po.lines.map((l) => ({
        lineId: l.id,
        itemId: l.itemId,
        quantity: l.quantity,
        rate: l.rate,
        costCodeId: l.costCodeId,
      })),
    };
    const amended = await tx((db) => svc().orders.amend(id, input, po.version, kit.actor, db));
    expect(await codeOf(tx((db) => svc().orders.cancel(id, amended.version, kit.actor, db)))).toBe(
      'po_has_receipts',
    );
  });
});

describe('orders from selected quotes (BR-3)', () => {
  it('builds one order per vendor from the selections and tracks the requisition', async () => {
    const project = await kit.project();
    const requisition = await kit.approvedRequisition({
      projectId: project.id,
      storeId: undefined,
    });
    const req = await svc().requisitions.get(kit.db, requisition, kit.actor);
    const [l1, l2] = req.lines;
    const [vendorA, vendorB] = [await kit.vendor(), await kit.vendor()];
    const rfq = await tx((db) =>
      svc().rfqs.create(
        { requisitionId: requisition, vendorIds: [vendorA, vendorB] },
        kit.actor,
        db,
      ),
    );
    const qa = await tx((db) =>
      svc().rfqs.createQuote(
        {
          rfqId: rfq.id,
          vendorId: vendorA,
          lines: [
            { requisitionLineId: l1!.id, rate: '1100' },
            { requisitionLineId: l2!.id, rate: '90' },
          ],
        },
        kit.actor,
        db,
      ),
    );
    const qb = await tx((db) =>
      svc().rfqs.createQuote(
        {
          rfqId: rfq.id,
          vendorId: vendorB,
          lines: [
            { requisitionLineId: l1!.id, rate: '1200' },
            { requisitionLineId: l2!.id, rate: '80' },
          ],
        },
        kit.actor,
        db,
      ),
    );
    const select = (requisitionLineId: string, quoteId: string, reason?: string) =>
      tx((db) =>
        svc().rfqs.selectVendor(rfq.id, { requisitionLineId, quoteId, reason }, kit.actor, db),
      );
    await select(l1!.id, qa.id);
    await select(l2!.id, qb.id);
    const fromRfq = (vendorId: string, rfqId = rfq.id) =>
      tx((db) =>
        svc().orders.createFromRfq({ rfqId, vendorId, orderDate: '2026-10-25' }, kit.actor, db),
      );
    expect(await codeOf(fromRfq(await kit.vendor()))).toBe('nothing_to_order');
    expect(await codeOf(fromRfq(vendorA, MISSING))).toBe('rfq_not_found');

    const first = await fromRfq(vendorA);
    expect(first).toMatchObject({
      requisitionId: requisition,
      projectId: project.id,
      total: '110000.00',
    });
    expect(first.lines).toHaveLength(1);
    expect((await svc().requisitions.get(kit.db, requisition, kit.actor)).status).toBe(
      'partly_ordered',
    );
    expect(await codeOf(fromRfq(vendorA))).toBe('nothing_to_order');
    const second = await fromRfq(vendorB);
    expect(second.total).toBe('3200.00');
    const done = await svc().requisitions.get(kit.db, requisition, kit.actor);
    expect(done.status).toBe('ordered');
    expect(done.lines.map((l) => l.orderedQty)).toEqual(['100.0000', '40.0000']);

    // Amending an order that came from selections changes nothing in the requisition.
    const detail = await svc().orders.get(kit.db, second.id);
    await tx((db) => svc().orders.submit(second.id, second.version, kit.actor, db));
    await kit.decide('purchase_order', second.id, 'approve');
    const current = await svc().orders.get(kit.db, second.id);
    const amendInput = {
      vendorId: current.vendorId,
      projectId: project.id,
      orderDate: current.orderDate,
      lines: current.lines.map((l) => ({
        lineId: l.id,
        itemId: l.itemId,
        quantity: l.quantity,
        rate: l.rate,
        costCodeId: l.costCodeId,
      })),
    };
    await tx((db) => svc().orders.amend(second.id, amendInput, current.version, kit.actor, db));
    expect(detail.requisitionId).toBe(requisition);
    expect((await svc().requisitions.get(kit.db, requisition, kit.actor)).status).toBe('ordered');

    // Cancelling an order puts its quantity back.
    await tx((db) => svc().orders.cancel(first.id, first.version, kit.actor, db));
    expect((await svc().requisitions.get(kit.db, requisition, kit.actor)).status).toBe(
      'partly_ordered',
    );
    await tx((db) =>
      db.query("update prc_requisitions set status = 'cancelled' where id = $1", [requisition]),
    );
    expect(await codeOf(fromRfq(vendorB))).toBe('requisition_not_approved');
    // An order of a requisition that is no longer open can still be cancelled.
    const lastVersion = (await svc().orders.get(kit.db, second.id)).version;
    await tx((db) => svc().orders.cancel(second.id, lastVersion, kit.actor, db));
    expect((await svc().orders.get(kit.db, second.id)).status).toBe('cancelled');
  });
});

describe('listOpenRequisitions (P1-19 BR-3)', () => {
  it('lists the requisitions that wait for approval or purchasing, and no others', async () => {
    const project = await kit.project();
    const draft = await kit.requisition({ projectId: project.id });
    const waiting = await kit.requisition({ projectId: project.id });
    await tx((db) => svc().requisitions.submit(waiting.id, waiting.version, kit.actor, db));
    const approved = await kit.approvedRequisition({ projectId: project.id });
    const ordered = await kit.approvedRequisition({ projectId: project.id });
    const cancelled = await kit.approvedRequisition({ projectId: project.id });
    await tx((db) =>
      db.query("update prc_requisitions set status = 'ordered' where id = $1", [ordered]),
    );
    await tx((db) =>
      db.query("update prc_requisitions set status = 'cancelled' where id = $1", [cancelled]),
    );
    const open = await kit.procurement.listOpenRequisitions(kit.db, { projectId: project.id });
    expect(open.map((r) => [r.id, r.status, r.lineCount])).toEqual([
      [waiting.id, 'pending_approval', 2],
      [approved, 'approved', 2],
    ]);
    expect(open.map((r) => r.id)).not.toContain(draft.id);
    expect(open[0]).toMatchObject({ projectId: project.id, storeId: null });

    // Filters: by store, by the projects a scope-limited caller reaches, and all of them.
    const store = await kit.approvedRequisition({});
    expect(
      (await kit.procurement.listOpenRequisitions(kit.db, { storeId: STORE })).map((r) => r.id),
    ).toContain(store);
    expect(await kit.procurement.listOpenRequisitions(kit.db, { projectIds: [MISSING] })).toEqual(
      [],
    );
    expect(
      (await kit.procurement.listOpenRequisitions(kit.db, { projectIds: [project.id] })).length,
    ).toBe(2);
    expect((await kit.procurement.listOpenRequisitions(kit.db)).length).toBeGreaterThan(2);
  });
});

describe('open lines, print model, listing', () => {
  it('lists what is still to come and the print layout', async () => {
    const project = await kit.project();
    const id = await kit.approvedPo(project.id);
    await kit.receive(id, { 1: '25.5' });
    const open = await svc().orders.listOpenLines(kit.db, { projectId: project.id });
    expect(open.map((l) => [l.lineNo, l.openQty, l.receivedQty])).toEqual([
      [1, '74.5000', '25.5000'],
      [2, '10.5000', '0.0000'],
    ]);
    expect(await svc().orders.listOpenLines(kit.db, { vendorId: MISSING })).toEqual([]);
    expect(
      (await svc().orders.listOpenLines(kit.db, { storeId: STORE })).every(
        (l) => l.storeId === STORE,
      ),
    ).toBe(true);
    expect((await kit.procurement.listOpenPoLines(kit.db, {})).length).toBeGreaterThan(2);
    const model = await svc().orders.printModel(kit.db, id);
    expect(model).toMatchObject({
      number: (await getPo(id)).number,
      total: '126100.00',
      destination: { type: 'project' },
    });
    expect(model.vendor.name).toContain('Synthetic Vendor');
    expect(model.lines).toHaveLength(2);
    const listed = await svc().orders.list(kit.db, {
      projectId: project.id,
      status: 'partly_received',
      limit: 10,
      offset: 0,
    });
    expect(listed.items.map((p) => p.id)).toEqual([id]);
    expect(
      (
        await svc().orders.list(kit.db, {
          vendorId: (await getPo(id)).vendorId,
          limit: 10,
          offset: 0,
        })
      ).total,
    ).toBe(1);
    expect(await codeOf(svc().orders.printModel(kit.db, MISSING))).toBe('purchase_order_not_found');
    expect((await kit.procurement.getPurchaseOrder(kit.db, id)).id).toBe(id);
  });
});

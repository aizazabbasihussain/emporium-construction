import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MISSING,
  PHOTO,
  STOREKEEPER,
  SUPERVISOR,
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
const keeper = () => kit.actorFor(STOREKEEPER);
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
  rows.filter((row) => row.status === status && !row.reverses).map((row) => row.amount);
const create = async (poId: string, quantities: Record<number, string>, over: object = {}) => {
  const input = { ...(await kit.receiptInput(poId, quantities)), ...over };
  return tx((db) => svc().receipts.create(input, keeper(), db));
};

describe('receiving against a project order (BR-6, BR-7, T-4, T-5)', () => {
  it('moves the commitment of the accepted quantity to approved cost at the order rate', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    const grn = await create(po, { 1: '40' });
    expect(grn).toMatchObject({
      number: 'GRN-2026-0001',
      status: 'posted',
      deliveryNoteRef: 'DC-1',
      receivedBy: STOREKEEPER,
    });
    expect(grn.lines[0]).toMatchObject({
      acceptedQty: '40.0000',
      rejectedQty: '0.0000',
      costAmount: '50020.00',
    });
    const ledger = await kit.ledger(project.id);
    expect(live(ledger, 'approved')).toEqual(['50020.00']);
    // The commitment now covers only what is still to come.
    expect(live(ledger, 'committed')).toEqual(['125050.00', '1050.00', '75030.00']);
    expect(ledger.filter((r) => r.reverses).map((r) => r.amount)).toEqual(['125050.00']);
    const order = await getPo(po);
    expect(order.status).toBe('partly_received');
    expect(order.lines.map((l) => l.receivedQty)).toEqual(['40.0000', '0.0000']);
  });

  it('completes the order in parts; the last receipt leaves nothing committed', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    await create(po, { 1: '60' });
    expect((await getPo(po)).status).toBe('partly_received');
    await create(po, { 1: '40', 2: '10.5' });
    const order = await getPo(po);
    expect(order.status).toBe('received');
    const ledger = await kit.ledger(project.id);
    expect(live(ledger, 'approved')).toEqual(['75030.00', '50020.00', '1050.00']);
    const committedNow = live(ledger, 'committed').length - ledger.filter((r) => r.reverses).length;
    expect(committedNow).toBe(0);
    expect(await codeOf(create(po, { 1: '1' }))).toBe('po_not_receivable');
  });

  it('refuses over-receipt at 0% and allows the configured tolerance (AC-3)', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    await create(po, { 1: '90' });
    expect(await codeOf(create(po, { 1: '10.0001' }))).toBe('over_receipt');
    await kit.setting('procurement.over_receipt_tolerance_percent', '5');
    const over = await create(po, { 1: '15' });
    expect(over.lines[0]?.acceptedQty).toBe('15.0000');
    expect((await getPo(po)).lines[0]?.receivedQty).toBe('105.0000');
    expect(await codeOf(create(po, { 1: '0.0001' }))).toBe('over_receipt');
    // The commitment of a line that is over-received never goes negative.
    const ledger = await kit.ledger(project.id);
    expect(live(ledger, 'approved')).toEqual(['112545.00', '18757.50']);
  });

  it('records the rejected quantity without stock or cost', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    const order = await getPo(po);
    const grn = await create(
      po,
      {},
      {
        lines: [
          { poLineId: order.lines[0]!.id, acceptedQty: '10', rejectedQty: '3', note: ' cracked ' },
          { poLineId: order.lines[1]!.id, acceptedQty: '0', rejectedQty: '2' },
        ],
      },
    );
    expect(grn.lines.map((l) => [l.acceptedQty, l.rejectedQty, l.costAmount, l.note])).toEqual([
      ['10.0000', '3.0000', '12505.00', 'cracked'],
      ['0.0000', '2.0000', '0.00', ''],
    ]);
    const ledger = await kit.ledger(project.id);
    expect(live(ledger, 'approved')).toEqual(['12505.00']);
    expect((await getPo(po)).lines.map((l) => l.receivedQty)).toEqual(['10.0000', '0.0000']);
    const outbox = await kit.db.query<{ payload: { lines: unknown[] } }>(
      "select payload from sys_outbox where type = 'goods.received' and payload->>'grnId' = $1",
      [grn.id],
    );
    expect(outbox[0]?.payload.lines).toHaveLength(1);
  });

  it('validates lines', async () => {
    const po = await kit.approvedPo(null);
    const other = await kit.approvedPo(null);
    const foreign = (await getPo(other)).lines[0]!.id;
    expect(await codeOf(create(po, {}, { lines: [{ poLineId: foreign, acceptedQty: '1' }] }))).toBe(
      'line_not_found',
    );
    expect(await codeOf(create(po, {}, { lines: [{ poLineId: MISSING, acceptedQty: '1' }] }))).toBe(
      'line_not_found',
    );
    expect(await codeOf(create(po, {}, { lines: [] }))).toBe('lines_required');
    expect(
      await codeOf(
        create(MISSING, { 1: '1' }, { lines: [{ poLineId: foreign, acceptedQty: '1' }] }),
      ),
    ).toBe('purchase_order_not_found');
    const draft = await kit.draftPo(null);
    expect(
      await codeOf(
        create(
          draft.id,
          {},
          { lines: [{ poLineId: (await getPo(draft.id)).lines[0]!.id, acceptedQty: '1' }] },
        ),
      ),
    ).toBe('po_not_receivable');
  });
});

describe('receiving into a store (T-5)', () => {
  it('posts no project cost and announces goods.received with the payload', async () => {
    const po = await kit.approvedPo(null);
    const before = await eventCount(kit.db, 'goods.received');
    const grn = await create(po, { 1: '30', 2: '5' });
    expect(grn.lines.map((l) => l.costAmount)).toEqual(['37515.00', '500.00']);
    expect(await eventCount(kit.db, 'goods.received')).toBe(before + 1);
    const rows = await kit.db.query<{
      payload: Record<string, unknown> & { lines: Record<string, string>[] };
    }>("select payload from sys_outbox where type = 'goods.received' and payload->>'grnId' = $1", [
      grn.id,
    ]);
    const payload = rows[0]!.payload;
    expect(payload).toMatchObject({
      grnId: grn.id,
      grnNumber: grn.number,
      poId: po,
      destinationType: 'store',
      projectId: null,
      ownership: 'company',
    });
    expect(payload.storeId).toBeTruthy();
    expect(payload.lines.map((l) => [l.quantity, l.unitCost])).toEqual([
      ['30.0000', '1250.5000'],
      ['5.0000', '99.9999'],
    ]);
    expect(payload.lines[0]).toMatchObject({
      itemId: (await getPo(po)).lines[0]!.itemId,
      costCodeId: kit.codes['100'],
    });
  });
});

describe('delivery challan photo (BR-11, T-8)', () => {
  it('is mandatory unless the setting is off', async () => {
    const po = await kit.approvedPo(null);
    expect(await codeOf(create(po, { 1: '1' }, { photos: [] }))).toBe('grn_photo_required');
    expect(await codeOf(create(po, { 1: '1' }, { photos: undefined }))).toBe('grn_photo_required');
    // The refused receipt left nothing behind.
    expect((await getPo(po)).lines[0]?.receivedQty).toBe('0.0000');
    const ok = await create(po, { 1: '1' }, { photos: [PHOTO] });
    const attached = await kit.files.list(kit.db, kit.actorFor(STOREKEEPER), 'prc_grn', ok.id);
    expect(attached).toHaveLength(1);
    await kit.setting('procurement.grn_photo_required', false);
    expect((await create(po, { 1: '1' }, { photos: undefined })).status).toBe('posted');
    await kit.setting('procurement.grn_photo_required', true, 1);
  });
});

describe('scope (BR-12)', () => {
  it('a supervisor receives only on assigned projects', async () => {
    const mine = await kit.project();
    const theirs = await kit.project();
    await kit.assignSupervisor(mine.id, SUPERVISOR);
    const supervisor = kit.actorFor(SUPERVISOR, [{ type: 'project', id: mine.id }]);
    const poMine = await kit.approvedPo(mine.id);
    const poTheirs = await kit.approvedPo(theirs.id);
    const poStore = await kit.approvedPo(null);
    const receive = async (poId: string) => {
      const input = await kit.receiptInput(poId, { 1: '1' });
      return tx((db) => svc().receipts.create(input, supervisor, db));
    };
    const grn = await receive(poMine);
    expect(grn.receivedBy).toBe(SUPERVISOR);
    expect(await codeOf(receive(poTheirs))).toBe('destination_not_found');
    expect(await codeOf(receive(poStore))).toBe('destination_not_found');

    const other = await create(poTheirs, { 1: '1' });
    expect(await codeOf(svc().receipts.get(kit.db, other.id, supervisor))).toBe(
      'destination_not_found',
    );
    expect((await svc().receipts.get(kit.db, grn.id, supervisor)).id).toBe(grn.id);
    const listed = await svc().receipts.list(kit.db, { limit: 50, offset: 0 }, supervisor);
    expect(listed.items.map((g) => g.id)).toEqual([grn.id]);
    expect(
      await codeOf(
        tx((db) => svc().receipts.cancel(other.id, 'Mistake', other.version, supervisor, db)),
      ),
    ).toBe('destination_not_found');
  });
});

describe('cancelling a receipt (BR-8, T-6)', () => {
  it('reverses the cost and restores the commitment', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    const grn = await create(po, { 1: '40' });
    expect(
      await codeOf(tx((db) => svc().receipts.cancel(grn.id, ' ', grn.version, keeper(), db))),
    ).toBe('reason_required');
    expect(
      await codeOf(
        tx((db) => svc().receipts.cancel(grn.id, 'Wrong delivery', grn.version + 3, keeper(), db)),
      ),
    ).toBe('version_conflict');
    const cancelled = await tx((db) =>
      svc().receipts.cancel(grn.id, 'Wrong delivery', grn.version, keeper(), db),
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong delivery' });
    const order = await getPo(po);
    expect(order.status).toBe('approved');
    expect(order.lines[0]?.receivedQty).toBe('0.0000');
    const ledger = await kit.ledger(project.id);
    expect(live(ledger, 'committed').slice(-1)).toEqual(['125050.00']);
    const approvedEntries = ledger.filter(
      (r) => r.status === 'approved' || (r.reverses && r.sourceDocType === 'goods_receipt'),
    );
    expect(approvedEntries.map((r) => [r.status, r.reverses])).toEqual([
      ['approved', false],
      ['reversed', true],
    ]);
    expect(
      await codeOf(
        tx((db) => svc().receipts.cancel(grn.id, 'Again', cancelled.version, keeper(), db)),
      ),
    ).toBe('grn_transition');
    expect(await eventCount(kit.db, 'goods.receipt.cancelled')).toBeGreaterThan(0);
    // The order can take the quantity again.
    expect((await create(po, { 1: '100' })).status).toBe('posted');
  });

  it('is blocked when stock was issued or a bill refers to it', async () => {
    const po = await kit.approvedPo(null);
    const issued = await create(po, { 1: '5' });
    kit.guards.issued.add(issued.id);
    expect(
      await codeOf(
        tx((db) => svc().receipts.cancel(issued.id, 'Mistake', issued.version, keeper(), db)),
      ),
    ).toBe('grn_issued');
    const billed = await create(po, { 1: '5' });
    kit.guards.billed.add(billed.id);
    expect(
      await codeOf(
        tx((db) => svc().receipts.cancel(billed.id, 'Mistake', billed.version, keeper(), db)),
      ),
    ).toBe('grn_billed');
    expect((await getPo(po)).lines[0]?.receivedQty).toBe('10.0000');
    kit.guards.issued.delete(issued.id);
    const done = await tx((db) =>
      svc().receipts.cancel(issued.id, 'Mistake', issued.version, keeper(), db),
    );
    expect(done.status).toBe('cancelled');
    expect((await getPo(po)).lines[0]?.receivedQty).toBe('5.0000');
  });

  it('a receipt on a closed order can be cancelled without bringing the commitment back', async () => {
    const project = await kit.project();
    const po = await kit.approvedPo(project.id);
    const grn = await create(po, { 1: '40' });
    const poVersion = (await getPo(po)).version;
    await tx((db) => svc().orders.close(po, poVersion, kit.actor, db));
    await tx((db) => svc().receipts.cancel(grn.id, 'Returned', grn.version, keeper(), db));
    const order = await getPo(po);
    expect(order.status).toBe('closed');
    expect(order.lines[0]?.receivedQty).toBe('0.0000');
    const ledger = await kit.ledger(project.id);
    expect(
      live(ledger, 'committed').length -
        ledger.filter((r) => r.reverses && r.sourceDocType === 'purchase_order').length,
    ).toBe(0);
  });
});

describe('finding receipts', () => {
  it('lists, finds and checks existence', async () => {
    const po = await kit.approvedPo(null);
    const grn = await create(po, { 1: '2' });
    const listed = await svc().receipts.list(
      kit.db,
      { poId: po, status: 'posted', limit: 10, offset: 0 },
      kit.actor,
    );
    expect(listed.items.map((g) => g.id)).toEqual([grn.id]);
    expect((await kit.procurement.getGrn(kit.db, grn.id)).lines).toHaveLength(1);
    expect((await svc().receipts.get(kit.db, grn.id, kit.actor)).number).toBe(grn.number);
    expect(await svc().receipts.exists(kit.db, grn.id)).toBe(true);
    expect(await svc().receipts.exists(kit.db, MISSING)).toBe(false);
    expect(await codeOf(svc().receipts.get(kit.db, MISSING, kit.actor))).toBe('grn_not_found');
    expect(await codeOf(svc().receipts.find(kit.db, MISSING))).toBe('grn_not_found');
    expect(
      (await svc().receipts.list(kit.db, { status: 'cancelled', limit: 10, offset: 0 }, kit.actor))
        .total,
    ).toBeGreaterThanOrEqual(0);
  });
});

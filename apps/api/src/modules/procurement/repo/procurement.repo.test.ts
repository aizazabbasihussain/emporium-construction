import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MISSING,
  PM,
  STORE,
  STOREKEEPER,
  createProcurementKit,
  uid,
  type ProcurementKit,
} from '../test-support.js';
import * as repo from './procurement.repo.js';

vi.setConfig({ testTimeout: 60_000 });

let kit: ProcurementKit;
beforeAll(async () => {
  kit = await createProcurementKit();
}, 120_000);
afterAll(() => kit.close());

const at = new Date('2026-10-25T10:00:00Z');
const tx = <T>(fn: (db: typeof kit.db) => Promise<T>) => kit.db.transaction(fn);

describe('numbering', () => {
  it('counts per kind and year', async () => {
    expect(await tx((db) => repo.nextSeq(db, 'grn', 2030))).toBe(1);
    expect(await tx((db) => repo.nextSeq(db, 'grn', 2030))).toBe(2);
    expect(await tx((db) => repo.nextSeq(db, 'grn', 2031))).toBe(1);
    expect(await tx((db) => repo.nextSeq(db, 'rfq', 2030))).toBe(1);
  });
});

describe('requisitions', () => {
  it('inserts, finds, updates, replaces lines and searches', async () => {
    const project = await kit.project();
    const item = await kit.item();
    const row = await tx((db) =>
      repo.insertRequisition(
        db,
        {
          id: uid(5001),
          number: 'REQ-T-1',
          project_id: project.id,
          requested_by: PM,
          required_by: '2026-11-01',
          note: 'n',
        },
        PM,
        at,
      ),
    );
    expect(row).toMatchObject({
      number: 'REQ-T-1',
      required_by: '2026-11-01',
      status: 'draft',
      version: 1,
    });
    expect(await repo.findRequisition(kit.db, row.id)).toEqual(row);
    expect(await repo.findRequisition(kit.db, MISSING)).toBeUndefined();
    expect(await tx((db) => repo.findRequisition(db, row.id, true))).toEqual(row);

    const lines = [
      {
        id: uid(5002),
        line_no: 1,
        item_id: item,
        description: 'a',
        quantity: '5.0000',
        unit_code: 'bag',
        cost_code_id: kit.codes['100'] as string,
        estimated_rate: '10.0000',
      },
      {
        id: uid(5003),
        line_no: 2,
        item_id: item,
        description: 'b',
        quantity: '1.5000',
        unit_code: 'kg',
        cost_code_id: kit.codes['100'] as string,
        estimated_rate: null,
      },
    ];
    await tx((db) => repo.replaceRequisitionLines(db, row.id, lines));
    expect(
      (await repo.listRequisitionLines(kit.db, row.id)).map((l) => [
        l.id,
        l.quantity,
        l.estimated_rate,
      ]),
    ).toEqual([
      [uid(5002), '5.0000', '10.0000'],
      [uid(5003), '1.5000', null],
    ]);
    expect((await repo.findRequisitionLine(kit.db, uid(5002)))?.requisition_id).toBe(row.id);
    expect(await repo.findRequisitionLine(kit.db, MISSING)).toBeUndefined();
    await tx((db) => repo.replaceRequisitionLines(db, row.id, lines.slice(0, 1)));
    expect(await repo.listRequisitionLines(kit.db, row.id)).toHaveLength(1);

    expect(
      await tx((db) => repo.updateRequisition(db, row.id, 9, { note: 'x' }, PM, at)),
    ).toBeUndefined();
    const updated = await tx((db) =>
      repo.updateRequisition(db, row.id, 1, { status: 'approved' }, PM, at),
    );
    expect(updated).toMatchObject({ status: 'approved', version: 2 });

    const search = (over: object) =>
      repo.searchRequisitions(kit.db, { limit: 10, offset: 0, ...over });
    expect((await search({ projectId: project.id })).rows.map((r) => r.id)).toEqual([row.id]);
    expect((await search({ status: 'approved', projectIds: [project.id] })).total).toBe(1);
    expect((await search({ projectIds: [] })).total).toBe(0);
    expect((await search({ storeId: STORE })).rows.every((r) => r.store_id === STORE)).toBe(true);
    expect((await search({ limit: 1 })).rows.length).toBeLessThanOrEqual(1);
  });

  it('adds up what is on orders', async () => {
    const requisition = await kit.approvedRequisition();
    const lines = await repo.listRequisitionLines(kit.db, requisition);
    expect((await repo.orderedByLine(kit.db, requisition)).size).toBe(0);
    await kit.draftPo(null, {
      lines: [
        {
          itemId: await kit.item(),
          quantity: '30',
          rate: '1',
          costCodeId: kit.codes['100'] as string,
        },
      ],
    });
    const po = await kit.draftPo(null);
    await kit.db.query('update prc_purchase_orders set requisition_id = $2 where id = $1', [
      po.id,
      requisition,
    ]);
    await kit.db.query(
      'update prc_po_lines set requisition_line_id = $2 where po_id = $1 and line_no = 1',
      [po.id, lines[0]!.id],
    );
    expect((await repo.orderedByLine(kit.db, requisition)).get(lines[0]!.id)).toBe('100.0000');
  });
});

describe('RFQs, quotes and selections', () => {
  it('stores, finds and searches', async () => {
    const requisition = await kit.approvedRequisition();
    const lines = await repo.listRequisitionLines(kit.db, requisition);
    const [vendorA, vendorB] = [await kit.vendor(), await kit.vendor()];
    const rfq = await tx((db) =>
      repo.insertRfq(
        db,
        { id: uid(5101), requisition_id: requisition, number: 'RFQ-T-1', status: 'open' },
        PM,
        at,
      ),
    );
    await tx((db) => repo.setRfqVendors(db, rfq.id, [vendorB, vendorA]));
    expect(await repo.listRfqVendors(kit.db, rfq.id)).toEqual([vendorA, vendorB].sort());
    expect(await repo.findRfq(kit.db, rfq.id)).toEqual(rfq);
    expect(await repo.findRfq(kit.db, MISSING)).toBeUndefined();
    expect(await tx((db) => repo.findRfq(db, rfq.id, true))).toEqual(rfq);
    expect(
      await tx((db) => repo.updateRfq(db, rfq.id, 9, { status: 'closed' }, PM, at)),
    ).toBeUndefined();
    expect(
      (await tx((db) => repo.updateRfq(db, rfq.id, 1, { status: 'closed' }, PM, at)))?.status,
    ).toBe('closed');
    expect(
      (await repo.searchRfqs(kit.db, { requisitionId: requisition, limit: 5, offset: 0 })).rows,
    ).toHaveLength(1);
    expect((await repo.searchRfqs(kit.db, { limit: 1, offset: 0 })).total).toBeGreaterThan(0);

    const quote = await tx((db) =>
      repo.insertQuote(
        db,
        {
          id: uid(5102),
          rfq_id: rfq.id,
          vendor_id: vendorA,
          valid_until: '2026-12-01',
          delivery_days: 4,
          terms: 't',
          total: '10.00',
        },
        PM,
        at,
      ),
    );
    expect(quote).toMatchObject({ valid_until: '2026-12-01', delivery_days: 4, total: '10.00' });
    expect(await repo.findQuote(kit.db, quote.id)).toEqual(quote);
    expect(await tx((db) => repo.findQuote(db, quote.id, true))).toEqual(quote);
    expect(await repo.findQuote(kit.db, MISSING)).toBeUndefined();
    expect((await repo.findQuoteOfVendor(kit.db, rfq.id, vendorA))?.id).toBe(quote.id);
    expect(await repo.findQuoteOfVendor(kit.db, rfq.id, vendorB)).toBeUndefined();
    expect(
      await tx((db) => repo.updateQuote(db, quote.id, 9, { total: '1.00' }, PM, at)),
    ).toBeUndefined();
    expect(
      (await tx((db) => repo.updateQuote(db, quote.id, 1, { total: '20.00' }, PM, at)))?.total,
    ).toBe('20.00');
    expect((await repo.listQuotes(kit.db, rfq.id)).map((q) => q.id)).toEqual([quote.id]);

    await tx((db) =>
      repo.replaceQuoteLines(db, quote.id, [{ requisitionLineId: lines[0]!.id, rate: '9.5' }]),
    );
    await tx((db) =>
      repo.replaceQuoteLines(db, quote.id, [{ requisitionLineId: lines[1]!.id, rate: '7' }]),
    );
    expect(await repo.listQuoteLines(kit.db, rfq.id)).toEqual([
      { quote_id: quote.id, requisition_line_id: lines[1]!.id, rate: '7.0000' },
    ]);

    await tx((db) => repo.upsertSelection(db, rfq.id, lines[1]!.id, quote.id, 'first'));
    await tx((db) => repo.upsertSelection(db, rfq.id, lines[1]!.id, quote.id, null));
    expect(await repo.listSelections(kit.db, rfq.id)).toEqual([
      { requisition_line_id: lines[1]!.id, quote_id: quote.id, reason: null },
    ]);
  });
});

describe('purchase orders, lines and receipts', () => {
  it('stores, finds, searches and keeps the line numbers apart', async () => {
    const project = await kit.project();
    const po = await kit.draftPo(project.id);
    const row = await repo.findPo(kit.db, po.id);
    expect(row).toMatchObject({
      revision: 1,
      destination_type: 'project',
      project_id: project.id,
      expected_date: '2026-11-01',
    });
    expect(await repo.findPo(kit.db, MISSING)).toBeUndefined();
    expect(await tx((db) => repo.findPo(db, po.id, true))).toEqual(row);
    expect(await tx((db) => repo.updatePo(db, po.id, 9, { terms: 'x' }, PM, at))).toBeUndefined();
    expect(
      (await tx((db) => repo.updatePo(db, po.id, po.version, { terms: 'x' }, PM, at)))?.terms,
    ).toBe('x');

    const search = (over: object) => repo.searchPos(kit.db, { limit: 10, offset: 0, ...over });
    expect(
      (await search({ projectId: project.id, status: 'draft', vendorId: row!.vendor_id })).rows,
    ).toHaveLength(1);
    expect((await search({ status: 'closed' })).rows).toEqual([]);

    const lines = await repo.listPoLines(kit.db, po.id);
    expect(
      lines.map((l) => [l.line_no, l.quantity, l.rate, l.line_total, l.received_qty, l.removed]),
    ).toEqual([
      [1, '100.0000', '1250.5000', '125050.00', '0.0000', false],
      [2, '10.5000', '99.9999', '1050.00', '0.0000', false],
    ]);
    expect((await repo.findPoLine(kit.db, lines[0]!.id))?.id).toBe(lines[0]!.id);
    expect((await tx((db) => repo.findPoLine(db, lines[0]!.id, true)))?.id).toBe(lines[0]!.id);
    expect(await repo.findPoLine(kit.db, MISSING)).toBeUndefined();

    await tx(async (db) => {
      await repo.shiftPoLineNumbers(db, po.id, 3);
      await repo.updatePoLine(db, lines[0]!.id, {
        lineNo: 1,
        requisitionLineId: null,
        itemId: lines[0]!.item_id,
        description: 'changed',
        quantity: '90',
        unitCode: 'bag',
        rate: '2',
        lineTotal: '180.00',
        costCodeId: lines[0]!.cost_code_id,
      });
      await repo.insertPoLine(db, po.id, {
        id: uid(5201),
        lineNo: 2,
        requisitionLineId: null,
        itemId: lines[1]!.item_id,
        description: '',
        quantity: '1',
        unitCode: 'bag',
        rate: '1',
        lineTotal: '1.00',
        costCodeId: lines[1]!.cost_code_id,
      });
      await repo.markPoLineRemoved(db, lines[1]!.id);
    });
    expect((await repo.listPoLines(kit.db, po.id)).map((l) => [l.line_no, l.description])).toEqual([
      [1, 'changed'],
      [2, ''],
    ]);
    expect(await repo.listPoLines(kit.db, po.id, { withRemoved: true })).toHaveLength(3);
    await tx((db) => repo.deletePoLine(db, uid(5201)));
    expect(await repo.listPoLines(kit.db, po.id)).toHaveLength(1);

    await tx((db) => repo.setPoLineCommitment(db, lines[0]!.id, MISSING, 3));
    expect(await repo.findPoLine(kit.db, lines[0]!.id)).toMatchObject({
      commit_entry_id: MISSING,
      commit_seq: 3,
    });
    await tx((db) => repo.setPoLineCommitment(db, lines[0]!.id, null, 3));
    await tx((db) => repo.setPoLineReceived(db, lines[0]!.id, '12.5'));
    expect((await repo.findPoLine(kit.db, lines[0]!.id))?.received_qty).toBe('12.5000');
  });

  it('lists the open lines with filters, and finds receipts', async () => {
    const project = await kit.project();
    const id = await kit.approvedPo(project.id);
    const open = (over: object = {}) => repo.listOpenLines(kit.db, over);
    expect((await open({ projectId: project.id })).map((l) => l.line_no)).toEqual([1, 2]);
    expect(await open({ vendorId: MISSING })).toEqual([]);
    expect(await open({ storeId: STORE })).not.toContainEqual(
      expect.objectContaining({ project_id: project.id }),
    );

    expect(await repo.hasPostedReceipt(kit.db, id)).toBe(false);
    const lineId = (await repo.listPoLines(kit.db, id))[0]!.id;
    expect(await repo.hasGrnLines(kit.db, lineId)).toBe(false);
    expect(await repo.postedCostOfLine(kit.db, lineId)).toBe('0');
    const grnId = await kit.receive(id, { 1: '10' });
    expect(await repo.hasPostedReceipt(kit.db, id)).toBe(true);
    expect(await repo.hasGrnLines(kit.db, lineId)).toBe(true);
    expect(await repo.postedCostOfLine(kit.db, lineId)).toBe('12505.00');

    const grn = await repo.findGrn(kit.db, grnId);
    expect(grn).toMatchObject({
      status: 'posted',
      received_by: STOREKEEPER,
      received_on: '2026-10-26',
    });
    expect(await repo.findGrn(kit.db, MISSING)).toBeUndefined();
    expect(await tx((db) => repo.findGrn(db, grnId, true))).toEqual(grn);
    expect(
      await tx((db) => repo.updateGrn(db, grnId, 9, { status: 'cancelled' }, PM, at)),
    ).toBeUndefined();
    const lines = await repo.listGrnLines(kit.db, grnId);
    expect(lines).toHaveLength(1);
    await tx((db) =>
      repo.insertGrnLine(db, {
        id: uid(5301),
        grnId,
        poLineId: lineId,
        acceptedQty: '1',
        rejectedQty: '0',
        note: '',
        costAmount: '5.00',
        costEntryId: null,
      }),
    ).catch((error: { code: string }) => expect(error.code).toBe('23505'));

    const search = (over: object) => repo.searchGrns(kit.db, { limit: 10, offset: 0, ...over });
    expect((await search({ poId: id, status: 'posted' })).total).toBe(1);
    expect((await search({ projectIds: [project.id] })).rows.map((g) => g.id)).toEqual([grnId]);
    expect((await search({ projectIds: [] })).total).toBe(0);
    await tx((db) => repo.updateGrn(db, grnId, 1, { status: 'cancelled' }, PM, at));
    expect(await repo.postedCostOfLine(kit.db, lineId)).toBe('0');
    expect(await repo.hasPostedReceipt(kit.db, id)).toBe(false);
  });
});

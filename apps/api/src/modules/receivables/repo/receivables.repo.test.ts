import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceivablesKit, TODAY, uid, type ReceivablesKit } from '../test-support.js';
import {
  claimReminderRun,
  collectedForProject,
  findAdjustmentByApproval,
  findFollowup,
  findPdc,
  findPdcByReceipt,
  findReceipt,
  insertAdjustment,
  insertAllocation,
  insertFollowup,
  insertPdc,
  insertReceipt,
  listAdjustments,
  listAdvanceAllocations,
  listAllocations,
  listFollowups,
  listInvoiceFigures,
  listPdcs,
  listReceiptEvents,
  searchReceipts,
  softDeleteFollowup,
  unallocatedReceipts,
  updateFollowup,
  updatePdc,
  updateReceipt,
} from './receivables.repo.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
}, 120_000);
afterAll(() => kit.close());

const at = new Date('2026-11-18T10:00:00Z');
const BY = uid(3);
let n = 0;
const id = () => `018f7c7c-7777-7000-8000-${String(900_000 + ++n).padStart(12, '0')}`;

describe('receivables repository', () => {
  it('stores receipts, allocations and cheques and reads them back', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const receiptId = id();
    const row = await insertReceipt(
      kit.db,
      {
        id: receiptId,
        number: `RV-TEST-${n}`,
        party_id: party,
        receipt_date: TODAY,
        method: 'pdc',
        amount: '300',
        status: 'pending_clearing',
      },
      BY,
      at,
    );
    expect(row).toMatchObject({
      amount: '300.00',
      status: 'pending_clearing',
      withheld_amount: '0.00',
      version: 1,
    });
    expect(await findReceipt(kit.db, receiptId, true)).toMatchObject({ id: receiptId });
    expect(await findReceipt(kit.db, id())).toBeUndefined();

    const allocation = await insertAllocation(
      kit.db,
      { id: id(), receipt_id: receiptId, invoice_id: invoice.id, amount: '300', kind: 'invoice' },
      BY,
      at,
    );
    expect(allocation).toMatchObject({ amount: '300.00', kind: 'invoice', advance_id: null });
    expect(await listAllocations(kit.db, receiptId)).toHaveLength(1);

    const pdc = await insertPdc(
      kit.db,
      {
        id: id(),
        receipt_id: receiptId,
        cheque_number: 'T-1',
        bank_name: 'Bank',
        cheque_date: '2026-11-20',
        amount: '300',
      },
      BY,
      at,
    );
    expect(pdc).toMatchObject({ party_id: party, status: 'received', cheque_date: '2026-11-20' });
    expect(await findPdc(kit.db, pdc.id, true)).toMatchObject({ id: pdc.id });
    expect(await findPdcByReceipt(kit.db, receiptId)).toMatchObject({ id: pdc.id });
    expect(await findPdcByReceipt(kit.db, id())).toBeUndefined();
    expect(await updatePdc(kit.db, pdc.id, 1, { status: 'deposited' }, BY, at)).toMatchObject({
      status: 'deposited',
      version: 2,
    });
    expect(await updatePdc(kit.db, pdc.id, 1, { status: 'cleared' }, BY, at)).toBeUndefined();
    expect(
      await listPdcs(kit.db, { status: 'deposited', from: '2026-11-20', to: '2026-11-20' }),
    ).toHaveLength(1);
    expect(await listPdcs(kit.db, { status: 'cleared' })).toEqual([]);

    expect(
      await updateReceipt(kit.db, receiptId, 1, { status: 'cleared', cleared_on: TODAY }, BY, at),
    ).toMatchObject({
      status: 'cleared',
      cleared_on: TODAY,
    });
    const page = await searchReceipts(kit.db, { partyId: party, limit: 5, offset: 0 });
    expect(page.total).toBeGreaterThan(0);
    expect((await searchReceipts(kit.db, { limit: 1, offset: 0 })).rows).toHaveLength(1);
    expect(await listReceiptEvents(kit.db, party, TODAY)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ receipt_id: receiptId, cash: '300.00', withholding: '0.00' }),
      ]),
    );
  });

  it('counts a receipt only between its clearing and its cancellation (BR-8)', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const receiptId = id();
    await insertReceipt(
      kit.db,
      {
        id: receiptId,
        number: `RV-TEST-${n}`,
        party_id: party,
        receipt_date: '2026-11-17',
        method: 'cash',
        amount: '100',
        status: 'cancelled',
        cleared_on: '2026-11-17',
        cancelled_on: '2026-11-19',
        cancel_reason: 'Test',
      },
      BY,
      at,
    );
    await insertAllocation(
      kit.db,
      { id: id(), receipt_id: receiptId, invoice_id: invoice.id, amount: '100', kind: 'invoice' },
      BY,
      at,
    );
    const allocatedAt = async (asOf: string) =>
      (await listInvoiceFigures(kit.db, { asOf, invoiceIds: [invoice.id] }))[0]?.allocated;
    expect(await allocatedAt(TODAY)).toBe('100.00');
    expect(await allocatedAt('2026-11-19')).toBe('0.00');
    expect(await collectedForProject(kit.db, invoice.projectId, TODAY)).toBe('100.00');
    expect(await collectedForProject(kit.db, invoice.projectId, '2026-11-19')).toBe('0.00');
    expect(
      await listInvoiceFigures(kit.db, {
        asOf: TODAY,
        partyId: party,
        projectId: invoice.projectId,
      }),
    ).toHaveLength(1);
    expect(await listInvoiceFigures(kit.db, { asOf: TODAY, projectId: id() })).toEqual([]);
    // Unallocated money: the receipt above is fully allocated, so only other receipts count.
    expect(Number(await unallocatedReceipts(kit.db, party, TODAY))).toBeGreaterThanOrEqual(0);
    expect(await listAdvanceAllocations(kit.db, party, TODAY)).toEqual(expect.any(Array));
  });

  it('stores write-offs, follow-ups and the daily reminder claim', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const approval = id();
    const adjustment = await insertAdjustment(
      kit.db,
      {
        id: id(),
        party_id: party,
        invoice_id: invoice.id,
        adjustment_date: TODAY,
        amount: '5',
        reason: 'Rounding',
        approval_doc_id: approval,
        approved_by: BY,
      },
      BY,
      at,
    );
    expect(adjustment).toMatchObject({ amount: '5.00', approved_by: BY });
    expect(await listAdjustments(kit.db, party)).toHaveLength(1);
    expect(await findAdjustmentByApproval(kit.db, approval)).toEqual({ id: adjustment.id });
    expect(await findAdjustmentByApproval(kit.db, id())).toBeUndefined();

    const followup = await insertFollowup(
      kit.db,
      { id: id(), party_id: party, due_date: TODAY, note: 'Call', status: 'open' },
      BY,
      at,
    );
    expect(await findFollowup(kit.db, followup.id, true)).toMatchObject({ note: 'Call' });
    expect(await updateFollowup(kit.db, followup.id, 1, { status: 'done' }, BY, at)).toMatchObject({
      status: 'done',
    });
    expect(await listFollowups(kit.db, { partyId: party, status: 'done' })).toHaveLength(1);
    expect(await listFollowups(kit.db, { status: 'open' })).toEqual([]);
    expect(await softDeleteFollowup(kit.db, followup.id, 2, BY, at)).toBeDefined();
    expect(await findFollowup(kit.db, followup.id)).toBeUndefined();

    expect(await claimReminderRun(kit.db, '2040-01-01', 3)).toBe(true);
    expect(await claimReminderRun(kit.db, '2040-01-01', 9)).toBe(false);
  });
});

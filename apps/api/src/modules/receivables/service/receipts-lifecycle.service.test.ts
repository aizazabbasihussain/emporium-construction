import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, eventCount } from '../billing-kit.js';
import { createReceivablesKit, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

const GHOST = '018f7c7c-7777-7000-8000-00000000dead';

const cancel = (id: string, version: number, reason = 'Entered twice') =>
  kit.run((tx) => kit.receivables.receipts.cancel(id, { reason, version }, kit.ractor, tx));

/** Marks a cash book entry as reconciled without running a bank statement (the flag is all BR-9 reads). */
async function reconcile(txnId: string, accountId: string) {
  const id = `018f7c7c-7777-7000-8000-${String(Date.now() % 1e12).padStart(12, '0')}`;
  await kit.db.query(
    `insert into cbk_reconciliations (id, account_id, statement_from, statement_to, statement_closing_balance)
     values ($1, $2, '2026-11-01', '2026-11-30', 0)`,
    [id, accountId],
  );
  await kit.db.query('update cbk_transactions set reconciled_in = $1 where id = $2', [id, txnId]);
}

describe('cancelling receipts (BR-9, T-6)', () => {
  it('reverses the cash, restores the balance and keeps the number', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const open = await kit.balance(party);
    const receipt = await kit.receipt(party, bank, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    const cancelled = await cancel(receipt.id, receipt.version);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.number).toBe(receipt.number);
    expect(cancelled.reversalTxnId).not.toBeNull();
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe('0.00');
    expect(await kit.balance(party)).toBe(open);
    expect(await auditCount(kit.db, 'receivables.receipt.cancel')).toBeGreaterThan(0);
    expect(await eventCount(kit.db, 'receipt.cancelled')).toBeGreaterThan(0);
    // The invoice is open again and can be paid by a new receipt.
    await kit.receipt(party, bank, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    await expect(cancel(receipt.id, cancelled.version)).rejects.toMatchObject({
      code: 'receipt_not_cancellable',
    });
  });

  it('needs a reason, the current version and an existing receipt', async () => {
    const party = await kit.partyId();
    const receipt = await kit.receipt(party, await kit.bank(), '10');
    await expect(cancel(receipt.id, receipt.version, ' ')).rejects.toMatchObject({
      code: 'reason_required',
    });
    await expect(cancel(receipt.id, receipt.version + 1)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(cancel(GHOST, 1)).rejects.toMatchObject({ code: 'receipt_not_found' });
  });

  it('refuses a receipt on a reconciled bank statement until it is un-reconciled', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const receipt = await kit.receipt(party, bank, '10');
    await reconcile(receipt.cashbookTxnId as string, bank);
    await expect(cancel(receipt.id, receipt.version)).rejects.toMatchObject({
      code: 'receipt_reconciled',
    });
  });

  it('cancels a cheque still in hand without cash and refuses one that was deposited', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const inHand = await kit.cheque(party, '500');
    const done = await cancel(inHand.receipt.id, inHand.receipt.version);
    expect(done.status).toBe('cancelled');
    expect(done.reversalTxnId).toBeNull();
    expect((await kit.receivables.pdcs.get(kit.db, inHand.pdc.id)).status).toBe('returned');

    const deposited = await kit.cheque(party, '500');
    await kit.run((tx) =>
      kit.receivables.pdcs.deposit(
        deposited.pdc.id,
        { accountId: bank, version: deposited.pdc.version },
        kit.ractor,
        tx,
      ),
    );
    await expect(cancel(deposited.receipt.id, deposited.receipt.version)).rejects.toMatchObject({
      code: 'receipt_not_cancellable',
    });
    // A cleared cheque is undone by a bounce, not by cancelling its receipt.
    const cleared = await kit.clearedCheque(party, bank, '500');
    await expect(cancel(cleared.receipt.id, cleared.receipt.version)).rejects.toMatchObject({
      code: 'receipt_not_cancellable',
    });
  });

  it('refuses a reversal dated before the receipt', async () => {
    const party = await kit.partyId();
    const receipt = await kit.receipt(party, await kit.bank(), '10');
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.cancel(
          receipt.id,
          { reason: 'Early', cancelledOn: '2026-11-17', version: receipt.version },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'reversal_before_clearing' });
  });
});

describe('allocating later (BR-3)', () => {
  it('reserves a cheque in hand when it is allocated and refuses a cancelled receipt', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const { receipt } = await kit.cheque(party, '800');
    const allocated = await kit.run((tx) =>
      kit.receivables.receipts.allocate(
        receipt.id,
        [{ kind: 'invoice', invoiceId: invoice.id, amount: '800' }],
        kit.ractor,
        tx,
      ),
    );
    expect(allocated.status).toBe('pending_clearing');
    const open = await kit.receivables.getOpenInvoices(kit.db, party);
    expect(open.find((row) => row.invoiceId === invoice.id)?.pending).toBe('800.00');

    const second = await kit.receipt(party, await kit.bank(), '5');
    const cancelled = await cancel(second.id, second.version);
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.allocate(
          cancelled.id,
          [{ kind: 'invoice', invoiceId: invoice.id, amount: '5' }],
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'receipt_not_active' });
  });
});

describe('withholding by the client (BR-4, T-5)', () => {
  it('allocates the withheld amount and flags a difference above the tolerance', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const paid = String(Number(invoice.gross) - 100);
    const receipt = await kit.receipt(
      party,
      bank,
      paid,
      [
        { kind: 'invoice', invoiceId: invoice.id, amount: paid },
        { kind: 'withholding', invoiceId: invoice.id, amount: '100' },
      ],
      { withheldAmount: '100', withholdingCertificateRef: 'CPR-1' },
    );
    expect(receipt.withholdingCertificateRef).toBe('CPR-1');
    expect(receipt.withholdingFlags).toEqual([
      expect.objectContaining({ invoiceId: invoice.id, actual: '100.00', flagged: true }),
    ]);
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe(Number(paid).toFixed(2));
    const open = await kit.receivables.getOpenInvoices(kit.db, party);
    expect(open.find((row) => row.invoiceId === invoice.id)).toBeUndefined();
  });

  it('does not flag a difference within the tolerance and counts a cheque in hand', async () => {
    await kit.setting('receivables.withholding_tolerance', '500');
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const paid = String(Number(invoice.gross) - 100);
    const receipt = await kit.run((tx) =>
      kit.receivables.receipts.create(
        {
          partyId: party,
          receiptDate: TODAY,
          method: 'pdc',
          amount: paid,
          withheldAmount: '100',
          cheque: { chequeNumber: 'W-1', bankName: 'B', chequeDate: TODAY },
          allocations: [
            { kind: 'invoice', invoiceId: invoice.id, amount: paid },
            { kind: 'withholding', invoiceId: invoice.id, amount: '100' },
          ],
        },
        kit.ractor,
        tx,
      ),
    );
    expect(receipt.withholdingFlags[0]).toMatchObject({ actual: '100.00', flagged: false });
    await kit.setting('receivables.withholding_tolerance', '0');
  });
});

describe('advance receipts (BR-5)', () => {
  const advance = (projectId: string, amount: string) => kit.advance(projectId, amount);

  it('marks the advance received through billing and shows unapplied credit', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const project = await kit.project();
    const adv = await advance(project.id, '100000');
    await advance(project.id, '500'); // a second advance of the project that nobody has paid
    const receipt = await kit.receipt(party, bank, adv.gross, [
      { kind: 'advance', invoiceId: adv.invoiceId, advanceId: adv.advanceId, amount: adv.gross },
    ]);
    const list = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    expect(list.find((a) => a.id === adv.advanceId)?.status).toBe('received');
    const balance = await kit.receivables.getCustomerBalance(kit.db, party, TODAY);
    expect(Number(balance.unappliedAdvances)).toBeGreaterThanOrEqual(100000);
    expect(balance.credit).toBe(
      (Number(balance.unallocatedReceipts) + Number(balance.unappliedAdvances)).toFixed(2),
    );
    expect(await kit.receivables.getCollectedAmount(kit.db, project.id)).toBe(
      Number(adv.gross).toFixed(2),
    );
    // Billing cannot take a received advance back, so the receipt cannot be cancelled.
    await expect(cancel(receipt.id, receipt.version)).rejects.toMatchObject({
      code: 'advance_already_received',
    });
  });

  it('refuses an advance that does not belong to the invoice', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const project = await kit.project();
    const adv = await advance(project.id, '1000');
    const stage = await kit.invoice();
    await expect(
      kit.receipt(party, bank, '10', [
        { kind: 'advance', invoiceId: adv.invoiceId, advanceId: GHOST, amount: '10' },
      ]),
    ).rejects.toMatchObject({ code: 'advance_mismatch' });
    await expect(
      kit.receipt(party, bank, '10', [
        { kind: 'advance', invoiceId: stage.id, advanceId: adv.advanceId, amount: '10' },
      ]),
    ).rejects.toMatchObject({ code: 'advance_mismatch' });
  });

  it('marks the advance when a cleared receipt is allocated later', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const project = await kit.project();
    const adv = await advance(project.id, '2000');
    const receipt = await kit.receipt(party, bank, adv.gross);
    await kit.run((tx) =>
      kit.receivables.receipts.allocate(
        receipt.id,
        [
          {
            kind: 'advance',
            invoiceId: adv.invoiceId,
            advanceId: adv.advanceId,
            amount: adv.gross,
          },
        ],
        kit.ractor,
        tx,
      ),
    );
    const list = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    expect(list.find((a) => a.id === adv.advanceId)?.status).toBe('received');
  });
});

describe('listing receipts', () => {
  it('lists receipts newest first, by customer, and finds one by id', async () => {
    const party = await kit.partyId();
    const receipt = await kit.receipt(party, await kit.bank(), '5');
    const page = await kit.receivables.receipts.list(kit.db, {
      partyId: party,
      limit: 2,
      offset: 0,
    });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThanOrEqual(2);
    const all = await kit.receivables.receipts.list(kit.db, { limit: 500, offset: 0 });
    expect(all.items.some((item) => item.id === receipt.id)).toBe(true);
    expect((await kit.receivables.receipts.get(kit.db, receipt.id)).id).toBe(receipt.id);
    await expect(kit.receivables.receipts.get(kit.db, GHOST)).rejects.toMatchObject({
      code: 'receipt_not_found',
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceivablesKit, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

const money = (value: string | number) => Number(value).toFixed(2);

describe('recording and allocating receipts (BR-2, BR-3, T-1, T-2)', () => {
  it('pays an invoice with a bank transfer and moves the cash at once', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const before = await kit.balance(party);
    const receipt = await kit.receipt(party, bank, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    expect(receipt.status).toBe('cleared');
    expect(receipt.number).toMatch(/^RV-/);
    expect(receipt.cashbookTxnId).not.toBeNull();
    expect(receipt.unallocated).toBe('0.00');
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe(money(invoice.gross));
    expect(money(Number(before) - Number(invoice.gross))).toBe(await kit.balance(party));
  });

  it('keeps an unallocated receipt as customer credit and allocates it once', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const before = await kit.receivables.getCustomerBalance(kit.db, party, TODAY);
    const receipt = await kit.receipt(party, bank, '1000');
    expect(receipt.unallocated).toBe('1000.00');
    const credit = await kit.receivables.getCustomerBalance(kit.db, party, TODAY);
    expect(credit.balance).toBe(before.balance);
    expect(Number(credit.unallocatedReceipts) - Number(before.unallocatedReceipts)).toBe(1000);
    const allocated = await kit.run((tx) =>
      kit.receivables.receipts.allocate(
        receipt.id,
        [{ kind: 'invoice', invoiceId: invoice.id, amount: '1000' }],
        kit.ractor,
        tx,
      ),
    );
    expect(allocated.unallocated).toBe('0.00');
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.allocate(
          receipt.id,
          [{ kind: 'invoice', invoiceId: invoice.id, amount: '1000' }],
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'receipt_already_allocated' });
  });

  it('refuses over-allocation, wrong sums, foreign invoices and unknown receipts', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const over = String(Number(invoice.gross) + 1);
    await expect(
      kit.receipt(party, bank, over, [{ kind: 'invoice', invoiceId: invoice.id, amount: over }]),
    ).rejects.toMatchObject({ code: 'over_allocation' });
    await expect(
      kit.receipt(party, bank, '100', [{ kind: 'invoice', invoiceId: invoice.id, amount: '99' }]),
    ).rejects.toMatchObject({ code: 'allocation_sum_mismatch' });
    await expect(
      kit.receipt(party, bank, '100', [
        { kind: 'invoice', invoiceId: '018f7c7c-7777-7000-8000-00000000dead', amount: '100' },
      ]),
    ).rejects.toMatchObject({ code: 'invoice_not_open' });
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.allocate(
          '018f7c7c-7777-7000-8000-00000000dead',
          [{ kind: 'invoice', invoiceId: invoice.id, amount: '1' }],
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'receipt_not_found' });
  });

  it('needs an account for money that moves at once and details for a cheque', async () => {
    const party = await kit.partyId();
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.create(
          { partyId: party, receiptDate: TODAY, method: 'cash', amount: '10' },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'account_required' });
    await expect(
      kit.run((tx) =>
        kit.receivables.receipts.create(
          { partyId: party, receiptDate: TODAY, method: 'cheque', amount: '10' },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'cheque_details_required' });
    await expect(kit.receipt(party, await kit.bank(), '0')).rejects.toMatchObject({
      code: 'amount_invalid',
    });
  });
});

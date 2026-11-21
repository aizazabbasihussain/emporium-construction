import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayablesKit, TODAY, type PayablesKit } from '../test-support.js';

let kit: PayablesKit;
beforeAll(async () => {
  kit = await createPayablesKit();
}, 180_000);
afterAll(() => kit.close());

describe('AC-1: PO to GRN to bill to payment', () => {
  it('matches, approves, posts and pays a bill by cheque with correct balances', async () => {
    const received = await kit.receipt();
    const project = { type: 'project' as const, id: received.projectId };
    expect(await kit.totals(project)).toMatchObject({ approved: '5000.00', posted: '0.00' });

    const bill = await kit.postedBill(kit.billInput(received));
    expect(bill.status).toBe('posted');
    expect(bill.baseAmount).toBe('5000.00');
    expect(bill.taxTotal).toBe('500.00');
    expect(bill.grossTotal).toBe('5500.00');
    expect(await kit.totals(project)).toMatchObject({ approved: '0.00', posted: '5000.00' });

    const account = await kit.bank();
    await kit.setThreshold('1000000');
    const payment = await kit.approvedPayment({
      vendorPartyId: received.vendorId,
      paymentDate: TODAY,
      method: 'cheque',
      chequeNumber: 'CH-1',
      chequeDate: TODAY,
      accountId: account,
      allocations: [{ billId: bill.id, amount: '5500' }],
    });
    const paid = await kit.run((tx) =>
      kit.payables.payments.pay(payment.id, payment.version, kit.pactor, tx),
    );
    expect(paid.status).toBe('paid');
    expect((await kit.bill(bill.id)).status).toBe('paid');
    expect(await kit.paidTotal(account)).toBe('9994500.00');
    const balance = await kit.payables.getVendorBalance(kit.db, received.vendorId, TODAY);
    expect(balance.balance).toBe('0.00');
  });
});

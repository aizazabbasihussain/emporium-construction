import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSubcontractsKit, PM2, TODAY, type SubcontractsKit } from '../test-support.js';

let kit: SubcontractsKit;
beforeAll(async () => {
  kit = await createSubcontractsKit();
}, 180_000);
afterAll(() => kit.close());

describe('from commitment to certification to a posted, paid bill (AC-1, T-1, T-2)', () => {
  it('moves project cost committed, approved, posted and keeps the worked example exact', async () => {
    const order = await kit.activeOrder();
    // BR-1: the commitment of the contract amount is on the project ledger.
    expect(order.status).toBe('active');
    expect(order.committedAmount).toBe('1000000.00');
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '1000000.00',
      approved: '0.00',
      posted: '0.00',
    });

    // 30% certified: the commitment falls by the gross, which becomes approved cost.
    const first = await kit.certified(order.id, { cumulativePercent: '30' });
    expect(first).toMatchObject({
      status: 'certified',
      cumulativeAmount: '300000.00',
      thisCertificateAmount: '300000.00',
      netCertified: '300000.00',
      certifiedBy: PM2,
    });
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '700000.00',
      approved: '300000.00',
      posted: '0.00',
    });

    // A +100,000 variation raises the commitment; a 20,000 back-charge is a deduction only.
    const variation = await kit.run((tx) =>
      kit.subcontracts.orders.addVariation(
        order.id,
        { amount: '100000', reason: 'Extra length' },
        kit.pm,
        tx,
      ),
    );
    await kit.run((tx) =>
      kit.subcontracts.orders.decideVariation(
        variation.id,
        { decision: 'approved', version: variation.version },
        kit.owner,
        tx,
      ),
    );
    expect((await kit.order(order.id)).currentContractAmount).toBe('1100000.00');
    expect((await kit.projectTotals(order.projectId)).committed).toBe('800000.00');
    const draft = await kit.draftCertificate(order.id, { cumulativePercent: '70' });
    const charge = await kit.backCharge(order.id, { certificateId: draft.id });
    expect(charge.id).toBeDefined();
    const current = await kit.cert(draft.id);
    expect(current).toMatchObject({
      cumulativeAmount: '770000.00',
      thisCertificateAmount: '470000.00',
      deductions: '20000.00',
      netCertified: '450000.00',
    });
    await kit.run((tx) =>
      kit.subcontracts.certificates.submit(draft.id, current.version, kit.pm, tx),
    );
    await kit.decideAs('subcontract_certificate', draft.id, PM2, 'project_manager');
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '330000.00',
      approved: '770000.00',
      posted: '0.00',
    });

    // Billing the net certified: posting the bill moves the cost to posted through payables.
    const bill = await kit.postedBillOf(draft.id);
    expect(bill.baseAmount).toBe('450000.00');
    expect(bill.withholdingTotal).toBe('9000.00');
    expect(bill.taxTotal).toBe('45000.00');
    expect(await kit.projectTotals(order.projectId)).toEqual({
      committed: '330000.00',
      approved: '300000.00',
      posted: '470000.00',
    });
    expect((await kit.cert(draft.id)).status).toBe('billed');

    // The bill is paid: the ledger of the work order shows contract, certified, billed and paid.
    const account = await kit.bank();
    await kit.setThreshold('1000000000');
    const payment = await kit.approvedPayment({
      vendorPartyId: order.partyId,
      paymentDate: TODAY,
      method: 'cash',
      accountId: account,
      allocations: [{ billId: bill.id, amount: bill.netPayable }],
    });
    await kit.run((tx) => kit.payables.payments.pay(payment.id, payment.version, kit.pactor, tx));
    const ledger = await kit.subcontracts.ledger.workOrderLedger(kit.db, order.id, kit.owner);
    expect(ledger).toMatchObject({
      contract: '1100000.00',
      certified: '770000.00',
      deductions: '20000.00',
      billed: '450000.00',
      committed: '330000.00',
    });
    expect(Number(ledger.paid)).toBeGreaterThan(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSubcontractsKit, TODAY, type SubcontractsKit } from '../test-support.js';

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

describe('the work order ledger and the subcontractor statement (spec section 5)', () => {
  it('shows contract, certified, billed and paid of a work order', async () => {
    const order = await kit.activeOrder();
    const first = await kit.certified(order.id, { cumulativePercent: '30' });
    const second = await kit.certified(order.id, { cumulativePercent: '50' });
    const bill = await kit.postedBillOf(first.id);
    await kit.setThreshold('1000000000');
    const payment = await kit.approvedPayment({
      vendorPartyId: order.partyId,
      paymentDate: TODAY,
      method: 'cash',
      accountId: await kit.bank(),
      allocations: [{ billId: bill.id, amount: bill.netPayable }],
    });
    await kit.run((tx) => kit.payables.payments.pay(payment.id, payment.version, kit.pactor, tx));
    const ledger = await kit.subcontracts.ledger.workOrderLedger(kit.db, order.id, kit.owner);
    expect(ledger).toMatchObject({
      workOrderId: order.id,
      contract: '1000000.00',
      certified: '500000.00',
      deductions: '0.00',
      billed: '300000.00',
      committed: '500000.00',
    });
    expect(ledger.certificates.map((c) => [c.certificateId, c.status, c.net])).toEqual([
      [first.id, 'billed', '300000.00'],
      [second.id, 'certified', '200000.00'],
    ]);
    expect(ledger.certificates[1]?.paid).toBe('0.00');
    expect(Number(ledger.certificates[0]?.paid)).toBeGreaterThan(0);
    expect(ledger.paid).toBe(ledger.certificates[0]?.paid);
    await refused(
      kit.subcontracts.ledger.workOrderLedger(kit.db, order.id, kit.supervisorOf([])),
      'project_not_found',
    );
    await refused(
      kit.subcontracts.ledger.workOrderLedger(
        kit.db,
        '018f7c7c-0000-7000-8000-00000000dead',
        kit.owner,
      ),
      'work_order_not_found',
    );
  });

  it('adds up the orders of one subcontractor and leaves out drafts and cancelled orders', async () => {
    const project = await kit.locatedProject();
    const partyId = await kit.contractor();
    const make = async (amount: string) => {
      const draft = await kit.run((tx) =>
        kit.subcontracts.orders.create(
          kit.orderInput(project.id, partyId, { contractAmount: amount }),
          kit.pm,
          tx,
        ),
      );
      return draft;
    };
    const one = await make('100000');
    const two = await make('200000');
    const hidden = await make('300000');
    const cancelled = await make('400000');
    for (const draft of [one, two, cancelled]) {
      await kit.run((tx) => kit.subcontracts.orders.submit(draft.id, draft.version, kit.pm, tx));
      await kit.decide('subcontract_order', draft.id, 'approve');
    }
    const live = await kit.order(cancelled.id);
    await kit.run((tx) => kit.subcontracts.orders.cancel(cancelled.id, live.version, kit.pm, tx));
    await kit.certified(one.id, { cumulativePercent: '50' });
    expect(hidden.status).toBe('draft');
    const statement = await kit.subcontracts.ledger.statement(kit.db, partyId, kit.owner);
    expect(statement.partyId).toBe(partyId);
    expect(statement.orders.map((o) => [o.workOrderId, o.contract, o.certified])).toEqual([
      [one.id, '100000.00', '50000.00'],
      [two.id, '200000.00', '0.00'],
    ]);
    expect(statement.totals).toEqual({
      contract: '300000.00',
      certified: '50000.00',
      deductions: '0.00',
      billed: '0.00',
      paid: '0.00',
    });
    // A supervisor of one project sees only that project's orders (and never reaches here without amounts).
    const none = await kit.subcontracts.ledger.statement(kit.db, partyId, kit.supervisorOf([]));
    expect(none.orders).toEqual([]);
    const seen = await kit.subcontracts.ledger.statement(
      kit.db,
      partyId,
      kit.supervisorOf([project.id]),
    );
    expect(seen.orders).toHaveLength(2);
  });
});

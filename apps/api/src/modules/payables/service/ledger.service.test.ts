import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TODAY, createPayablesKit, type PayablesKit } from '../test-support.js';

let kit: PayablesKit;
let account: string;
beforeAll(async () => {
  kit = await createPayablesKit();
  account = await kit.bank();
  await kit.withholdingRule();
  await kit.setThreshold('1000000000');
}, 180_000);
afterAll(() => kit.close());

const pay = async (vendorId: string, billId: string, amount: string) => {
  const approved = await kit.approvedPayment({
    vendorPartyId: vendorId,
    paymentDate: TODAY,
    method: 'bank_transfer',
    accountId: account,
    allocations: [{ billId, amount }],
  });
  return kit.run((tx) => kit.payables.payments.pay(approved.id, approved.version, kit.pactor, tx));
};

const bill = async (over: { dueDate?: string; works?: boolean; vendorId?: string } = {}) => {
  const received = await kit.receipt({
    ...(over.vendorId === undefined ? {} : { vendorId: over.vendorId }),
  });
  const posted = await kit.postedBill(
    kit.billInput(received, {
      ...(over.dueDate === undefined ? {} : { dueDate: over.dueDate }),
      ...(over.works === true ? { nature: 'works' } : {}),
    }),
  );
  return { posted, vendorId: received.vendorId };
};

describe('vendor balance and open bills (BR-9)', () => {
  it('is the posted net payable plus withholding payable less the payments allocated', async () => {
    const { posted, vendorId } = await bill({ works: true });
    expect(await kit.payables.getVendorBalance(kit.db, vendorId)).toEqual({
      partyId: vendorId,
      date: TODAY,
      netPayable: '5400.00',
      withholdingPayable: '100.00',
      payments: '0.00',
      balance: '5500.00',
    });
    await pay(vendorId, posted.id, '2750');
    const after = await kit.payables.getVendorBalance(kit.db, vendorId, TODAY);
    expect(after).toMatchObject({ payments: '2750.00', balance: '2750.00' });
    const open = await kit.payables.getOpenBills(kit.db, vendorId);
    expect(open).toMatchObject([
      {
        billId: posted.id,
        gross: '5500.00',
        allocated: '2750.00',
        withheld: '50.00',
        outstanding: '2750.00',
        withholdingTotal: '100.00',
      },
    ]);
    expect(await kit.payables.getOpenBills(kit.db, vendorId, '2026-01-01')).toEqual([]);
    expect((await kit.payables.getVendorBalance(kit.db, vendorId, '2026-01-01')).balance).toBe(
      '0.00',
    );
  });

  it('drops a bill that is paid in full from the open bills', async () => {
    const { posted, vendorId } = await bill();
    await pay(vendorId, posted.id, '5500');
    expect(await kit.payables.getOpenBills(kit.db, vendorId)).toEqual([]);
  });
});

describe('the vendor ledger', () => {
  it('lists bills and payments with a running balance', async () => {
    const { posted, vendorId } = await bill();
    const payment = await pay(vendorId, posted.id, '1500');
    const overview = await kit.payables.ledger.overview(kit.db, vendorId);
    expect(overview.lines).toEqual([
      {
        date: TODAY,
        kind: 'bill',
        reference: posted.number,
        documentId: posted.id,
        debit: '0.00',
        credit: '5500.00',
        balance: '5500.00',
      },
      {
        date: TODAY,
        kind: 'payment',
        reference: payment.number,
        documentId: payment.id,
        debit: '1500.00',
        credit: '0.00',
        balance: '4000.00',
      },
    ]);
    expect(overview.balance.balance).toBe('4000.00');
    expect(overview.openBills).toHaveLength(1);
    const earlier = await kit.payables.ledger.overview(kit.db, vendorId, '2026-01-01');
    expect(earlier.lines).toEqual([]);
  });

  it('is published as the view pay_v_vendor_ledger', async () => {
    const { posted, vendorId } = await bill();
    const rows = await kit.db.query<Record<string, string>>(
      'select entry_type, number, credit::text as credit, status from pay_v_vendor_ledger where vendor_party_id = $1',
      [vendorId],
    );
    expect(rows).toEqual([
      { entry_type: 'bill', number: posted.number, credit: '5500.00', status: 'posted' },
    ]);
  });
});

describe('aging', () => {
  it('buckets open bills by due date in the receivables buckets', async () => {
    const recent = await bill({ dueDate: '2026-11-04' });
    const older = await bill({ dueDate: '2026-10-25' });
    const report = await kit.payables.ledger.aging(kit.db, '2026-12-30');
    expect(report.asOf).toBe('2026-12-30');
    expect(report.labels).toEqual(['current', '0-30', '31-60', '61-90', '90+']);
    const cells = (vendorId: string) => report.rows.find((row) => row.key === vendorId)?.buckets;
    expect(cells(recent.vendorId)).toEqual(['0.00', '0.00', '5500.00', '0.00', '0.00']);
    expect(cells(older.vendorId)).toEqual(['0.00', '0.00', '0.00', '5500.00', '0.00']);
    expect((await kit.payables.ledger.aging(kit.db)).asOf).toBe(TODAY);
  });
});

describe('what was paid against a source document (P2-06)', () => {
  it('sums the payments of the bills of one source document', async () => {
    const vendor = await kit.vendor();
    kit.payables.registerBillSource('subcontract', {
      async buildBill() {
        return {
          vendorPartyId: vendor,
          locationId: kit.islamabadId,
          lines: [
            {
              description: 'Certified work',
              quantity: '1',
              rate: '1000',
              costObject: { type: 'overhead', id: null },
              costCodeId: kit.codes['300'] as string,
            },
          ],
        };
      },
      async onPosted() {},
      async onCancelled() {},
    });
    const sourceId = '018f7c7c-0000-7000-8000-0000000000dd';
    const created = await kit.run((tx) =>
      kit.payables.bills.createFromSource(
        'subcontract',
        sourceId,
        { vendorInvoiceNo: 'SUB-1', billDate: TODAY, dueDate: '2026-11-25' },
        kit.pactor,
        tx,
      ),
    );
    const matched = await kit.run((tx) =>
      kit.payables.bills.match(created.id, { version: created.version }, kit.pactor, tx),
    );
    const submitted = await kit.run((tx) =>
      kit.payables.bills.submit(matched.id, matched.version, kit.pactor, tx),
    );
    await kit.decide('vendor_bill', submitted.id, 'approve');
    const approved = await kit.bill(created.id);
    const posted = await kit.run((tx) =>
      kit.payables.bills.post(approved.id, approved.version, kit.pactor, tx),
    );
    expect(await kit.payables.getPaidAmount(kit.db, { type: 'subcontract', id: sourceId })).toBe(
      '0.00',
    );
    await pay(vendor, posted.id, '400');
    expect(await kit.payables.getPaidAmount(kit.db, { type: 'subcontract', id: sourceId })).toBe(
      '400.00',
    );
    expect(
      await kit.payables.getPaidAmount(kit.db, { type: 'subcontract', id: sourceId }, '2026-01-01'),
    ).toBe('0.00');
  });
});

describe('what was paid for a project as of a date (P2-08)', () => {
  it('counts the whole payment of a bill whose lines are all on the project', async () => {
    const received = await kit.receipt();
    const posted = await kit.postedBill(kit.billInput(received));
    const project = received.projectId as string;
    const paid = (asOf: string) => kit.payables.getPaidForProject(kit.db, project, asOf);
    expect(await paid(TODAY)).toBe('0.00');
    await pay(received.vendorId, posted.id, '2750');
    expect(await paid(TODAY)).toBe('2750.00');
    // The payment is dated today: an earlier date does not see it.
    expect(await paid('2026-10-24')).toBe('0.00');
    // Another project has paid nothing.
    expect(await kit.payables.getPaidForProject(kit.db, (await kit.project()).id, TODAY)).toBe(
      '0.00',
    );
    await expect(paid('2026-02-30')).rejects.toMatchObject({ code: 'invalid_date' });
  });

  it("takes the project's share of a bill that is split with overhead", async () => {
    const vendor = await kit.vendor();
    const project = (await kit.project()).id;
    kit.payables.registerBillSource('subcontract', {
      async buildBill() {
        return {
          vendorPartyId: vendor,
          locationId: kit.islamabadId,
          lines: [
            {
              description: 'Certified work on the project',
              quantity: '1',
              rate: '600',
              costObject: { type: 'project', id: project },
              costCodeId: kit.codes['300'] as string,
            },
            {
              description: 'Share of site overhead',
              quantity: '1',
              rate: '400',
              costObject: { type: 'overhead', id: null },
              costCodeId: kit.codes['300'] as string,
            },
          ],
        };
      },
      async onPosted() {},
      async onCancelled() {},
    });
    const created = await kit.run((tx) =>
      kit.payables.bills.createFromSource(
        'subcontract',
        '018f7c7c-0000-7000-8000-0000000000ee',
        { vendorInvoiceNo: 'SPLIT-1', billDate: TODAY, dueDate: '2026-11-25' },
        kit.pactor,
        tx,
      ),
    );
    const matched = await kit.run((tx) =>
      kit.payables.bills.match(created.id, { version: created.version }, kit.pactor, tx),
    );
    const submitted = await kit.run((tx) =>
      kit.payables.bills.submit(matched.id, matched.version, kit.pactor, tx),
    );
    await kit.decide('vendor_bill', submitted.id, 'approve');
    const approved = await kit.bill(created.id);
    const posted = await kit.run((tx) =>
      kit.payables.bills.post(approved.id, approved.version, kit.pactor, tx),
    );
    await pay(vendor, posted.id, '500');
    // 500 paid on a bill of 600 (project) and 400 (overhead): the project's share is 60%.
    expect(await kit.payables.getPaidForProject(kit.db, project, TODAY)).toBe('300.00');
  });
});

describe('the withholding report (BR-8)', () => {
  it('totals the withholding deducted per authority and month with its certificate', async () => {
    const { posted, vendorId } = await bill({ works: true });
    const payment = await pay(vendorId, posted.id, '5500');
    await kit.run((tx) =>
      kit.payables.payments.setCertificate(
        payment.id,
        { certificateNo: 'WHT-77', version: payment.version },
        kit.pactor,
        tx,
      ),
    );
    const report = await kit.payables.ledger.withholdingReport(kit.db, { month: '2026-10' });
    const mine = report.rows.filter((row) => row.paymentId === payment.id);
    expect(mine).toEqual([
      {
        authorityCode: 'FBR',
        month: '2026-10',
        vendorPartyId: vendorId,
        paymentId: payment.id,
        paymentNumber: payment.number,
        billId: posted.id,
        billNumber: posted.number,
        amount: '100.00',
        certificateNo: 'WHT-77',
      },
    ]);
    const total = report.totals.find((t) => t.authorityCode === 'FBR' && t.month === '2026-10');
    expect(Number(total?.amount)).toBeGreaterThanOrEqual(100);
    const other = await kit.payables.ledger.withholdingReport(kit.db, {
      month: '2026-10',
      authorityCode: 'PRA',
    });
    expect(other).toEqual({ rows: [], totals: [] });
    expect(
      (await kit.payables.ledger.withholdingReport(kit.db, { month: '2026-02' })).rows,
    ).toEqual([]);
  });
});

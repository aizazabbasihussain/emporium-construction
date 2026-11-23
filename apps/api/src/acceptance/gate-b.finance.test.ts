import { createTestDb } from '@emporium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findUnauditedMoneyRows } from './audit.js';
import { dumpDatabase, fingerprint, restoreDatabase } from './backup.js';
import { expectedB as w } from './gate-b-expected.js';
import { createHarness, type Harness } from './harness.js';
import { runIntegrityChecks } from './integrity.js';
import {
  reconciliationChecks,
  runReconciliation,
  runReconciliations,
  type ReconciliationCheck,
} from './reconcile.js';
import { client, PNG_BASE64, val, type Client } from './scenario-kit.js';

/**
 * Gate B finance scenario (P2-10 BR-2). Steps run in order and share `s`. Every figure is read from
 * the hand-calculated worksheet docs/cutover/gate-b-expected.md through `w(id)`.
 */
describe('Gate B finance scenario', () => {
  let h: Harness;
  let c: Client;
  const s: Record<string, string> = {};

  beforeAll(async () => {
    h = await createHarness({ now: new Date('2026-11-02T05:00:00Z') });
    c = client(h);
  }, 60_000);
  afterAll(() => h.close());

  it('step 1: locations, registrations and tax rules as data', async () => {
    const isb = await c.send('admin', 'POST', '/master/locations', {
      name: 'Site Islamabad',
      region: 'islamabad',
      city: 'Islamabad',
    });
    s.isbLocationId = val(isb.body, 'id');
    const lhr = await c.send('admin', 'POST', '/master/locations', {
      name: 'Site Lahore',
      region: 'punjab',
      city: 'Lahore',
    });
    s.lhrLocationId = val(lhr.body, 'id');
    for (const authority of ['FBR', 'PRA']) {
      await c.send('admin', 'POST', '/master/tax-registrations', {
        authority,
        registrationType: 'strn',
        number: `SYNTH-${authority}-0001`,
        validFrom: '2020-01-01',
      });
    }
    // Synthetic rates: they exercise the engine and mean nothing for the real business (H-02, H-03).
    const rules = [
      ['FBR', 'services', '8', 'ST-FBR'],
      ['PRA', 'services', '16', 'ST-PRA'],
      ['FBR', 'goods', '18', 'ST-FBR-G'],
    ] as const;
    for (const [authorityCode, supplyKind, ratePercent, taxCode] of rules) {
      await c.send('accountant', 'POST', '/tax/rules', {
        authorityCode,
        supplyKind,
        ratePercent,
        taxCode,
        effectiveFrom: '2026-01-01',
      });
    }
    for (const [region, supplyKind, authorityCode] of [
      ['islamabad', 'services', 'FBR'],
      ['punjab', 'services', 'PRA'],
      ['islamabad', 'goods', 'FBR'],
      ['punjab', 'goods', 'FBR'],
    ] as const) {
      await c.send('accountant', 'POST', '/tax/region-map', {
        authorityCode,
        region,
        supplyKind,
        effectiveFrom: '2026-01-01',
      });
    }
    const withholding = [
      ['FBR', 'client_withholds', 'civil', '5', 'on_base'],
      ['PRA', 'client_withholds', 'civil', '2', 'on_tax_amount'],
      ['FBR', 'we_withhold', 'subcontract', '4', 'on_base'],
    ] as const;
    for (const [authorityCode, direction, nature, ratePercent, base] of withholding) {
      await c.send('accountant', 'POST', '/tax/withholding-rules', {
        authorityCode,
        direction,
        nature,
        ratePercent,
        base,
        effectiveFrom: '2026-01-01',
      });
    }
    // Three sales rules, four region entries and three withholding rules, each approved by the owner.
    expect(await c.approveInbox('owner')).toBe(10);
    const calc = await c.send('accountant', 'POST', '/tax/calculate', {
      locationId: s.lhrLocationId,
      supplyKind: 'services',
      date: '2026-11-02',
      lines: [{ id: 'x', amount: '100000.00', nature: 'civil' }],
    });
    expect(val(calc.body, 'taxTotal')).toBe(w('tax.praServices'));
  });

  it('step 2: parties, cash accounts, two projects with billing schedules', async () => {
    const party = async (name: string, roles: string[], city: string) =>
      val((await c.send('admin', 'POST', '/master/parties', { name, roles, city })).body, 'id');
    s.clientIsb = await party('Synthetic Client Islamabad', ['client'], 'Islamabad');
    s.clientLhr = await party('Synthetic Client Lahore', ['client'], 'Lahore');
    s.vendorId = await party('Synthetic Vendor', ['vendor'], 'Lahore');
    s.subId = await party('Synthetic Subcontractor', ['subcontractor'], 'Lahore');
    const codes = await c.send<{ items: { id: string; code: string }[] }>(
      'admin',
      'GET',
      '/master/cost-codes',
    );
    for (const code of codes.body.items) s[`code${code.code}`] = code.id;
    const cash = await c.send('accountant', 'POST', '/cashbook/accounts', {
      code: 'CASH-HO',
      kind: 'cash',
      name: 'Head office cash',
      openingBalance: '500000.00',
      openingDate: '2026-11-01',
    });
    s.cashId = val(cash.body, 'id');
    const bank = await c.send('accountant', 'POST', '/cashbook/accounts', {
      code: 'BANK-1',
      kind: 'bank',
      name: 'Synthetic Bank current',
      bankName: 'Synthetic Bank',
      openingBalance: '2000000.00',
      openingDate: '2026-11-01',
    });
    s.bankId = val(bank.body, 'id');
    for (const [key, name, partyId, locationId, value] of [
      ['isb', 'Islamabad villa', s.clientIsb, s.isbLocationId, '1000000.00'],
      ['lhr', 'Lahore office fit-out', s.clientLhr, s.lhrLocationId, '800000.00'],
    ] as const) {
      const project = await c.send('pm', 'POST', '/projects', {
        name,
        partyId,
        locationId,
        sector: 'private',
        originalContractValue: value,
        startDate: '2026-11-01',
      });
      const id = val(project.body, 'id');
      s[`${key}ProjectId`] = id;
      const url = `/projects/${id}`;
      await c.send('pm', 'POST', `${url}/status`, {
        status: 'active',
        version: await c.versionOf('pm', url),
      });
      await c.send('pm', 'PUT', `${url}/budget`, {
        version: await c.versionOf('pm', url),
        lines: [
          { costCodeId: s.code100, budgetAmount: '400000.00' },
          { costCodeId: s.code200, budgetAmount: '300000.00' },
        ],
      });
    }
    const sched = await c.send('accountant', 'PUT', `/billing/schedule/${s.isbProjectId}`, {
      stages: [
        { stageNo: 1, name: 'Foundation', amount: '400000.00' },
        { stageNo: 2, name: 'Structure', amount: '600000.00' },
      ],
    });
    s.isbStage1 = val(sched.body, 'stages.0.id');
    const sched2 = await c.send('accountant', 'PUT', `/billing/schedule/${s.lhrProjectId}`, {
      stages: [
        { stageNo: 1, name: 'Fit-out phase 1', amount: '500000.00' },
        { stageNo: 2, name: 'Fit-out phase 2', amount: '300000.00' },
      ],
    });
    s.lhrStage1 = val(sched2.body, 'stages.0.id');
    // A manual schedule is a controlled change: the owner approves it before anything is billed.
    expect(await c.approveInbox('owner')).toBe(2);
  });

  it('step 3: advance invoice and receipt', async () => {
    const advance = await c.send('accountant', 'POST', '/billing/advances', {
      projectId: s.lhrProjectId,
      amount: '100000.00',
      invoiceDate: '2026-11-02',
    });
    s.advInvoiceId = val(advance.body, 'invoice.id');
    s.advanceId = val(advance.body, 'advance.id');
    const url = `/billing/invoices/${s.advInvoiceId}`;
    await c.send('accountant', 'POST', `${url}/submit`, {
      version: await c.versionOf('accountant', url),
    });
    await c.approveInbox('owner');
    const issued = await c.send('accountant', 'POST', `${url}/issue`, {
      version: await c.versionOf('accountant', url),
    });
    expect(val(issued.body, 'number')).toBe('INV-2026-0001');
    expect(val(issued.body, 'grossTotal')).toBe(w('adv.invoice.gross'));
    const receipt = await c.send('accountant', 'POST', '/receivables/receipts', {
      partyId: s.clientLhr,
      receiptDate: '2026-11-02',
      method: 'bank_transfer',
      amount: w('adv.invoice.gross'),
      accountId: s.bankId,
      reference: 'TRF-ADV-1',
      allocations: [
        {
          kind: 'advance',
          invoiceId: s.advInvoiceId,
          advanceId: s.advanceId,
          amount: w('adv.invoice.gross'),
        },
      ],
    });
    expect(val(receipt.body, 'status')).toBe('cleared');
    const summary = await c.send(
      'accountant',
      'GET',
      `/billing/projects/${s.lhrProjectId}/summary`,
    );
    // The advance is net billing until a stage invoice recovers part of it.
    expect(val(summary.body, 'netBilled')).toBe(w('adv.netBilled'));
    expect(val(summary.body, 'unappliedAdvance')).toBe(w('adv.unapplied'));
  });

  it('step 4: stage invoices in both authorities', async () => {
    const issue = async (projectId: string, scheduleId: string, date: string) => {
      const created = await c.send('accountant', 'POST', '/billing/invoices', {
        projectId,
        scheduleIds: [scheduleId],
        invoiceDate: date,
        nature: 'civil',
        supplyKind: 'services',
      });
      const url = `/billing/invoices/${val(created.body, 'id')}`;
      await c.send('accountant', 'POST', `${url}/submit`, {
        version: await c.versionOf('accountant', url),
      });
      await c.approveInbox('owner');
      return c.send('accountant', 'POST', `${url}/issue`, {
        version: await c.versionOf('accountant', url),
      });
    };
    const isb = await issue(s.isbProjectId as string, s.isbStage1 as string, '2026-11-02');
    s.isbInvoiceId = val(isb.body, 'id');
    expect(val(isb.body, 'authorityCode')).toBe('FBR');
    expect(val(isb.body, 'taxTotal')).toBe(w('isb.stage.tax'));
    expect(val(isb.body, 'grossTotal')).toBe(w('isb.stage.gross'));
    expect(val(isb.body, 'withholdingExpected')).toBe(w('isb.stage.withholding'));
    const lhr = await issue(s.lhrProjectId as string, s.lhrStage1 as string, '2026-11-02');
    s.lhrInvoiceId = val(lhr.body, 'id');
    expect(val(lhr.body, 'authorityCode')).toBe('PRA');
    expect(val(lhr.body, 'taxTotal')).toBe(w('lhr.stage.tax'));
    expect(val(lhr.body, 'advanceRecovery')).toBe(w('lhr.stage.recovery'));
    expect(val(lhr.body, 'grossTotal')).toBe(w('lhr.stage.gross'));
    expect(val(lhr.body, 'withholdingExpected')).toBe(w('lhr.stage.withholding'));
  });

  it('step 5: receipts, one PDC cleared and one bounced, credit note', async () => {
    // ISB: a post-dated cheque plus the tax withheld by the client settles part of the invoice.
    const pdc1 = await c.send('accountant', 'POST', '/receivables/receipts', {
      partyId: s.clientIsb,
      receiptDate: '2026-11-02',
      method: 'pdc',
      amount: '192000.00',
      accountId: s.bankId,
      withheldAmount: w('isb.stage.withholding'),
      withholdingCertificateRef: 'WHT-CERT-ISB-1',
      cheque: {
        chequeNumber: 'CH-1001',
        bankName: 'Client Bank',
        drawer: 'Synthetic Client Islamabad',
        chequeDate: '2026-11-10',
      },
      allocations: [
        { kind: 'invoice', invoiceId: s.isbInvoiceId, amount: '192000.00' },
        { kind: 'withholding', invoiceId: s.isbInvoiceId, amount: w('isb.stage.withholding') },
      ],
    });
    expect(val(pdc1.body, 'status')).toBe('pending_clearing');
    // LHR: a second cheque of 300,000.00 that will bounce.
    const pdc2 = await c.send('accountant', 'POST', '/receivables/receipts', {
      partyId: s.clientLhr,
      receiptDate: '2026-11-02',
      method: 'pdc',
      amount: '300000.00',
      accountId: s.bankId,
      cheque: {
        chequeNumber: 'CH-2001',
        bankName: 'Client Bank',
        drawer: 'Synthetic Client Lahore',
        chequeDate: '2026-11-10',
      },
      allocations: [{ kind: 'invoice', invoiceId: s.lhrInvoiceId, amount: '300000.00' }],
    });
    expect(val(pdc2.body, 'status')).toBe('pending_clearing');
    const register = await c.send('accountant', 'GET', '/receivables/pdcs');
    expect(val(register.body, 'totalInHand')).toBe('492000.00');
    const pdcOf = (cheque: string) =>
      val<{ id: string; chequeNumber: string; version: number }[]>(register.body, 'items').find(
        (item) => item.chequeNumber === cheque,
      ) as { id: string; version: number };
    h.now.current = new Date('2026-11-10T05:00:00Z');
    const good = pdcOf('CH-1001');
    const bad = pdcOf('CH-2001');
    for (const pdc of [good, bad]) {
      await c.send('accountant', 'POST', `/receivables/pdcs/${pdc.id}/deposit`, {
        accountId: s.bankId,
        depositedOn: '2026-11-10',
        version: pdc.version,
      });
    }
    const afterDeposit = await c.send('accountant', 'GET', '/receivables/pdcs');
    const versionOfPdc = (id: string) =>
      val<{ id: string; version: number }[]>(afterDeposit.body, 'items').find(
        (item) => item.id === id,
      )?.version as number;
    await c.send('accountant', 'POST', `/receivables/pdcs/${good.id}/clear`, {
      clearedOn: '2026-11-10',
      version: versionOfPdc(good.id),
    });
    await c.send('accountant', 'POST', `/receivables/pdcs/${bad.id}/bounce`, {
      reason: 'Insufficient funds',
      bouncedOn: '2026-11-10',
      version: versionOfPdc(bad.id),
    });
    // The bounced cheque no longer counts: the whole invoice is open again.
    const afterBounce = await c.send(
      'accountant',
      'GET',
      `/receivables/customers/${s.clientLhr}/ledger`,
    );
    expect(val(afterBounce.body, 'balance.balance')).toBe(w('lhr.balance.afterBounce'));
    // The client then pays 217,500.00 by transfer, 1,600.00 of it withheld at source.
    await c.send('accountant', 'POST', '/receivables/receipts', {
      partyId: s.clientLhr,
      receiptDate: '2026-11-10',
      method: 'bank_transfer',
      amount: '215900.00',
      accountId: s.bankId,
      reference: 'TRF-LHR-1',
      withheldAmount: w('lhr.stage.withholding'),
      withholdingCertificateRef: 'WHT-CERT-LHR-1',
      allocations: [
        { kind: 'invoice', invoiceId: s.lhrInvoiceId, amount: '215900.00' },
        { kind: 'withholding', invoiceId: s.lhrInvoiceId, amount: w('lhr.stage.withholding') },
      ],
    });
    // Credit note on the Islamabad invoice: 10,000.00 base.
    const note = await c.send(
      'accountant',
      'POST',
      `/billing/invoices/${s.isbInvoiceId}/credit-notes`,
      { reason: 'Agreed deduction for a measurement difference', baseAmount: '10000.00' },
    );
    const nurl = `/billing/credit-notes/${val(note.body, 'id')}`;
    await c.send('accountant', 'POST', `${nurl}/submit`, {
      version: await c.versionOf('accountant', nurl),
    });
    await c.approveInbox('owner');
    const issued = await c.send('accountant', 'POST', `${nurl}/issue`, {
      version: await c.versionOf('accountant', nurl),
    });
    expect(val(issued.body, 'taxTotal')).toBe(w('cn.tax'));
    expect(val(issued.body, 'grossTotal')).toBe(w('cn.gross'));
    const isbLedger = await c.send(
      'accountant',
      'GET',
      `/receivables/customers/${s.clientIsb}/ledger`,
    );
    const lhrLedger = await c.send(
      'accountant',
      'GET',
      `/receivables/customers/${s.clientLhr}/ledger`,
    );
    expect(val(lhrLedger.body, 'balance.balance')).toBe(w('lhr.balance'));
    expect(val(isbLedger.body, 'balance.balance')).toBe(w('isb.balance'));
  });

  it('step 6: purchase order, receipt into the store, bill with a price variance', async () => {
    s.storeId = val(
      (
        await c.send('storekeeper', 'POST', '/inventory/stores', {
          code: 'WH-1',
          name: 'Main warehouse',
          kind: 'warehouse',
        })
      ).body,
      'id',
    );
    s.cementId = val(
      (
        await c.send('admin', 'POST', '/master/items', {
          code: 'CEM-OPC',
          name: 'Cement OPC 50kg bag',
          unitCode: 'bag',
          itemKind: 'material',
          defaultTaxKind: 'goods',
          defaultCostCodeId: s.code100,
        })
      ).body,
      'id',
    );
    const po = await c.send('procurement', 'POST', '/procurement/purchase-orders', {
      vendorId: s.vendorId,
      storeId: s.storeId,
      orderDate: '2026-11-10',
      lines: [{ itemId: s.cementId, quantity: '100', rate: '1200', costCodeId: s.code100 }],
    });
    s.poId = val(po.body, 'id');
    s.poLineId = val(po.body, 'lines.0.id');
    expect(val(po.body, 'total')).toBe(w('po.total'));
    const purl = `/procurement/purchase-orders/${s.poId}`;
    await c.send('procurement', 'POST', `${purl}/submit`, {
      version: await c.versionOf('procurement', purl),
    });
    await c.approveInbox('owner');
    const grn = await c.send('storekeeper', 'POST', '/procurement/grns', {
      poId: s.poId,
      receivedOn: '2026-11-10',
      lines: [{ poLineId: s.poLineId, acceptedQty: '100' }],
      photos: [{ fileName: 'challan.png', contentBase64: PNG_BASE64 }],
    });
    await c.deliver();
    s.grnId = val(grn.body, 'id');
    s.grnLineId = val(grn.body, 'lines.0.id');
    const bill = await c.send('accountant', 'POST', '/payables/bills', {
      vendorPartyId: s.vendorId,
      vendorInvoiceNo: 'VINV-5001',
      billDate: '2026-11-10',
      dueDate: '2026-12-10',
      sourceType: 'purchase',
      supplyKind: 'goods',
      locationId: s.lhrLocationId,
      lines: [
        {
          grnId: s.grnId,
          grnLineId: s.grnLineId,
          quantity: '100',
          rate: '1230',
          costObjectType: 'project',
          costObjectId: s.lhrProjectId,
          costCodeId: s.code100,
        },
      ],
    });
    expect(val(bill.body, 'baseAmount')).toBe(w('bill.base'));
    s.billId = val(bill.body, 'id');
    const burl = `/payables/bills/${s.billId}`;
    // The order was 100 x 1,200.00; the vendor billed 1,230.00. The match refuses without a reason.
    const refused = await h.call('accountant', 'POST', `${burl}/match`, {
      version: await c.versionOf('accountant', burl),
    });
    expect(refused.status).toBe(422);
    const matched = await c.send('accountant', 'POST', `${burl}/match`, {
      version: await c.versionOf('accountant', burl),
      overrideReason: 'Vendor price rise agreed by phone with procurement',
    });
    expect(val(matched.body, 'status')).toBe('matched');
    expect(val(matched.body, 'matches.0.rateVariance')).toBe(w('bill.rateVariance'));
    await c.send('accountant', 'POST', `${burl}/submit`, {
      version: await c.versionOf('accountant', burl),
    });
    await c.approveInbox('owner');
    const posted = await c.send('accountant', 'POST', `${burl}/post`, {
      version: await c.versionOf('accountant', burl),
    });
    // Goods bought for a Punjab site fall under the FBR goods rule; the 3,000.00 over the order
    // price (100 x 30.00) is booked as a price variance.
    expect(val(posted.body, 'taxTotal')).toBe(w('bill.tax'));
    expect(val(posted.body, 'grossTotal')).toBe(w('bill.gross'));
    expect(val(posted.body, 'variances.0.amount')).toBe(w('bill.variance'));
    await c.deliver();
  });

  it('step 7: subcontract certificate with a back-charge, billed and posted', async () => {
    const order = await c.send('pm', 'POST', '/subcontracts/work-orders', {
      projectId: s.isbProjectId,
      partyId: s.subId,
      title: 'Brickwork subcontract',
      contractAmount: '200000.00',
      costCodeId: s.code200,
    });
    s.workOrderId = val(order.body, 'id');
    const ourl = `/subcontracts/work-orders/${s.workOrderId}`;
    await c.send('pm', 'POST', `${ourl}/submit`, { version: await c.versionOf('pm', ourl) });
    await c.approveInbox('owner');
    expect(val((await c.send('pm', 'GET', ourl)).body, 'status')).toBe('active');
    const cert = await c.send('pm', 'POST', `${ourl}/certificates`, {
      certificateDate: '2026-11-10',
      basis: 'percent_complete',
      cumulativePercent: '50',
    });
    s.certId = val(cert.body, 'id');
    expect(val(cert.body, 'netCertified')).toBe(w('cert.net'));
    await c.send('pm', 'POST', `${ourl}/back-charges`, {
      description: 'Rework of misaligned wall',
      amount: '5000.00',
      recoversCost: true,
      costCodeId: s.code200,
      certificateId: s.certId,
    });
    const curl = `/subcontracts/certificates/${s.certId}`;
    await c.send('pm', 'POST', `${curl}/submit`, { version: await c.versionOf('pm', curl) });
    // The certificate is approved by a project manager other than its creator.
    await c.approveInbox('pm2');
    const billed = await c.send('accountant', 'POST', `${curl}/bill`, {
      vendorInvoiceNo: 'SUB-CERT-1',
      billDate: '2026-11-10',
      dueDate: '2026-12-10',
    });
    expect(val(billed.body, 'bill.baseAmount')).toBe(w('sub.base'));
    s.subBillId = val(billed.body, 'bill.id');
    const burl = `/payables/bills/${s.subBillId}`;
    await c.send('accountant', 'POST', `${burl}/match`, {
      version: await c.versionOf('accountant', burl),
    });
    await c.send('accountant', 'POST', `${burl}/submit`, {
      version: await c.versionOf('accountant', burl),
    });
    await c.approveInbox('owner');
    const posted = await c.send('accountant', 'POST', `${burl}/post`, {
      version: await c.versionOf('accountant', burl),
    });
    expect(val(posted.body, 'taxTotal')).toBe(w('sub.tax'));
    expect(val(posted.body, 'grossTotal')).toBe(w('sub.gross'));
    expect(val(posted.body, 'withholdingTotal')).toBe(w('sub.withholding'));
    expect(val(posted.body, 'netPayable')).toBe(w('sub.netPayable'));
    await c.deliver();
  });

  it('step 7b: the creator of a payment cannot approve it or pay it unapproved (BR-5)', async () => {
    h.now.current = new Date('2026-11-12T05:00:00Z');
    const created = await c.send('accountant', 'POST', '/payables/payments', {
      vendorPartyId: s.vendorId,
      paymentDate: '2026-11-12',
      method: 'cash',
      accountId: s.cashId,
      amount: '10.00',
      allocations: [{ billId: s.billId, amount: '10.00' }],
    });
    const url = `/payables/payments/${val(created.body, 'id')}`;
    await c.send('accountant', 'POST', `${url}/submit`, {
      version: await c.versionOf('accountant', url),
    });
    const inbox = await c.send<{ items: { id: string }[] }>('owner', 'GET', '/approvals/inbox');
    const own = inbox.body.items[0];
    expect(own).toBeDefined();
    const self = await h.call('accountant', 'POST', `/approvals/requests/${own?.id}/approve`, {});
    expect([403, 409, 422]).toContain(self.status);
    const early = await h.call('accountant', 'POST', `${url}/pay`, {
      version: await c.versionOf('accountant', url),
    });
    expect([403, 409, 422]).toContain(early.status);
    // Leave the books as they were: the owner rejects the request.
    await c.send('owner', 'POST', `/approvals/requests/${own?.id}/reject`, {
      comment: 'Separation of duties check',
    });
    await c.send('accountant', 'POST', `${url}/cancel`, {
      reason: 'Separation of duties check',
      version: await c.versionOf('accountant', url),
    });
  });

  it('step 8: payments by cheque, cash and bank transfer', async () => {
    h.now.current = new Date('2026-11-12T05:00:00Z');
    const pay = async (body: Record<string, unknown>) => {
      const created = await c.send('accountant', 'POST', '/payables/payments', body);
      const url = `/payables/payments/${val(created.body, 'id')}`;
      await c.send('accountant', 'POST', `${url}/submit`, {
        version: await c.versionOf('accountant', url),
      });
      await c.approveInbox('owner');
      return c.send('accountant', 'POST', `${url}/pay`, {
        version: await c.versionOf('accountant', url),
      });
    };
    const cheque = await pay({
      vendorPartyId: s.vendorId,
      paymentDate: '2026-11-12',
      method: 'cheque',
      accountId: s.bankId,
      chequeNumber: 'OUT-3001',
      chequeDate: '2026-11-12',
      amount: '100000.00',
      allocations: [{ billId: s.billId, amount: '100000.00' }],
    });
    expect(val(cheque.body, 'status')).toBe('paid');
    const cash = await pay({
      vendorPartyId: s.vendorId,
      paymentDate: '2026-11-12',
      method: 'cash',
      accountId: s.cashId,
      amount: '45140.00',
      allocations: [{ billId: s.billId, amount: '45140.00' }],
    });
    expect(val(cash.body, 'status')).toBe('paid');
    // The subcontractor bill is paid net of the tax withheld at source.
    const transfer = await pay({
      vendorPartyId: s.subId,
      paymentDate: '2026-11-12',
      method: 'bank_transfer',
      accountId: s.bankId,
      reference: 'TRF-SUB-1',
      withholdingCertificateNo: 'WHT-OUT-1',
      amount: w('sub.netPayable'),
      allocations: [{ billId: s.subBillId, amount: w('sub.gross') }],
    });
    expect(val(transfer.body, 'withholdingDeducted')).toBe(w('sub.withholding'));
  });

  it('step 9: attendance for a week, wage sheet approved', async () => {
    for (const [key, value] of [
      ['workforce.working_days_basis', 26],
      ['attendance.overtime_multiplier', '1.5'],
    ] as const) {
      const current = await c.send('admin', 'GET', `/admin/settings/${key}`);
      await c.send('admin', 'PUT', `/admin/settings/${key}`, {
        value,
        version: Number(val(current.body, 'version')),
      });
    }
    const workers = [
      ['W-001', 'Synthetic Mason', 'daily', 'daily_rate', '1500'],
      ['W-002', 'Synthetic Helper', 'daily', 'daily_rate', '1000'],
      ['W-003', 'Synthetic Foreman', 'permanent', 'monthly_salary', '39000'],
    ] as const;
    const ids: string[] = [];
    for (const [code, fullName, employmentType, payBasis, amount] of workers) {
      const worker = await c.send('owner', 'POST', '/workforce/workers', {
        code,
        fullName,
        cnic: `00000-000000${code.slice(-1)}-0`,
        tradeCode: 'mason',
        employmentType,
        joinedOn: '2026-01-01',
      });
      const workerId = val(worker.body, 'id');
      await c.send('owner', 'POST', `/workforce/workers/${workerId}/rates`, {
        payBasis,
        amount,
        effectiveFrom: '2026-01-01',
      });
      ids.push(workerId);
    }
    // Team membership counts from the day it is set, so it is set before the week starts.
    h.now.current = new Date('2026-11-01T05:00:00Z');
    const team = await c.send('pm', 'POST', '/workforce/teams', {
      name: 'Villa crew',
      supervisorUserId: h.userId('supervisor'),
    });
    s.teamId = val(team.body, 'id');
    await c.send('pm', 'PUT', `/workforce/teams/${s.teamId}/members`, {
      workerIds: ids,
      version: await c.versionOf('pm', `/workforce/teams/${s.teamId}`),
    });
    await c.send('pm', 'PUT', `/projects/${s.isbProjectId}/supervisors`, {
      supervisors: [{ userId: h.userId('supervisor'), fromDate: '2026-11-01' }],
    });
    const [w1, w2, w3] = ids;
    for (const date of [
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]) {
      h.now.current = new Date(`${date}T14:00:00Z`);
      const sheet = await c.send('supervisor', 'PUT', `/attendance/sheets/${s.teamId}/${date}`, {
        entries: [
          {
            workerId: w1,
            status: 'present',
            ...(date === '2026-11-03'
              ? { overtimeHours: '2', overtimeProjectId: s.isbProjectId }
              : {}),
            allocations: [{ projectId: s.isbProjectId, fraction: '1' }],
          },
          {
            workerId: w2,
            status: date === '2026-11-05' ? 'absent' : 'present',
            allocations:
              date === '2026-11-05' ? [] : [{ projectId: s.isbProjectId, fraction: '1' }],
          },
          {
            workerId: w3,
            status: date === '2026-11-07' ? 'half_day' : 'present',
            allocations: [{ projectId: s.isbProjectId, fraction: '1' }],
          },
        ],
      });
      const surl = `/attendance/sheets/${val(sheet.body, 'id')}`;
      await c.send('supervisor', 'POST', `${surl}/submit`, {
        version: await c.versionOf('supervisor', surl),
      });
    }
    h.now.current = new Date('2026-11-12T08:00:00Z');
    expect(await c.approveInbox('pm')).toBe(6);
    const period = await c.send('accountant', 'POST', '/wages/periods', { year: 2026, month: 11 });
    s.periodId = val(period.body, 'id');
    await c.send('accountant', 'POST', `/wages/periods/${s.periodId}/calculate`, {});
    const lines = await c.send('accountant', 'GET', `/wages/periods/${s.periodId}/lines`);
    expect(val(lines.body, 'totals.grossPay')).toBe(w('wage.gross'));
    expect(val(lines.body, 'totals.netPay')).toBe(w('wage.net'));
    const purl = `/wages/periods/${s.periodId}`;
    await c.send('accountant', 'POST', `${purl}/submit`, {
      version: await c.versionOf('accountant', purl),
      acknowledgeWarnings: true,
    });
    await c.approveInbox('owner');
    expect(val((await c.send('accountant', 'GET', purl)).body, 'status')).toBe('approved');
  });

  it('step 10: payroll run finalized and paid', async () => {
    const run = await c.send('accountant', 'POST', '/payroll/runs', { periodId: s.periodId });
    s.runId = val(run.body, 'id');
    const rurl = `/payroll/runs/${s.runId}`;
    expect(val(run.body, 'totalNet')).toBe(w('wage.net'));
    await c.send('accountant', 'POST', `${rurl}/finalize`, {
      version: await c.versionOf('accountant', rurl),
    });
    await c.deliver();
    const request = await c.send('accountant', 'POST', `${rurl}/payment-requests`, {});
    await c.approveInbox('owner');
    const paid = await c.send('accountant', 'POST', `${rurl}/pay`, {
      paymentDate: '2026-11-12',
      method: 'cash',
      accountId: s.cashId,
      approvalDocId: val(request.body, 'approvalDocId'),
      version: await c.versionOf('accountant', rurl),
    });
    expect(val(paid.body, 'amount')).toBe(w('wage.net'));
    expect(val(paid.body, 'status')).toBe('paid');
    await c.deliver();
  });

  it('step 11: cash book balances and bank reconciliation with a statement', async () => {
    const bank = await c.send(
      'accountant',
      'GET',
      `/cashbook/accounts/${s.bankId}/balance?date=2026-11-12`,
    );
    const cash = await c.send(
      'accountant',
      'GET',
      `/cashbook/accounts/${s.cashId}/balance?date=2026-11-12`,
    );
    expect(val(bank.body, 'balance')).toBe(w('bank.balance'));
    expect(val(cash.body, 'balance')).toBe(w('cash.balance'));
    // The statement shows the cheque not yet presented and a bank charge the books do not have.
    const rec = await c.send('accountant', 'POST', '/cashbook/reconciliations', {
      accountId: s.bankId,
      statementFrom: '2026-11-01',
      statementTo: '2026-11-12',
      statementClosingBalance: w('rec.statementClosing'),
    });
    s.recId = val(rec.body, 'id');
    const csv = [
      'Date,Description,Debit,Credit',
      '2026-11-02,Transfer advance,,116000.00',
      '2026-11-10,Cheque deposit,,192000.00',
      '2026-11-10,Transfer in,,215900.00',
      '2026-11-12,Transfer out,98800.00,',
      '2026-11-12,Bank charges,500.00,',
    ].join('\n');
    const imported = await c.send(
      'accountant',
      'POST',
      `/cashbook/reconciliations/${s.recId}/import`,
      { csv },
    );
    const lines = val<{ id: string; debit: string; credit: string }[]>(imported.body, 'lines');
    const candidates = val<{ id: string; direction: string; amount: string }[]>(
      imported.body,
      'candidates',
    );
    const matches = lines
      .map((line) => {
        const direction = Number(line.credit) > 0 ? 'in' : 'out';
        const amount = Number(line.credit) > 0 ? line.credit : line.debit;
        const found = candidates.find(
          (txn) => txn.direction === direction && txn.amount === amount,
        );
        return { lineId: line.id, transactionId: found?.id ?? null };
      })
      .filter((match) => match.transactionId !== null);
    // Four lines have a book entry; the bank charge has none.
    expect(matches).toHaveLength(4);
    await c.send('accountant', 'POST', `/cashbook/reconciliations/${s.recId}/match`, { matches });
    const recUrl = `/cashbook/reconciliations/${s.recId}`;
    const detail = await c.send('accountant', 'GET', recUrl);
    expect(val(detail.body, 'figures.difference')).toBe('0.00');
    const done = await c.send('accountant', 'POST', `${recUrl}/complete`, {
      version: await c.versionOf('accountant', recUrl),
    });
    expect(val(done.body, 'difference')).toBe('0.00');
    expect(val(done.body, 'status')).toBe('completed');
  });

  it('step 12: stock issue to a project', async () => {
    const issue = await c.send('storekeeper', 'POST', '/inventory/issues', {
      storeId: s.storeId,
      itemId: s.cementId,
      quantity: '40',
      costObject: { type: 'project', id: s.lhrProjectId },
      costCodeId: s.code100,
      businessDate: '2026-11-12',
    });
    expect(val(issue.body, 'value')).toBe(w('stock.issue'));
    await c.deliver();
  });

  it('step 12b: ledgers, tax report and project profitability against the worksheet', async () => {
    // Customer ledger = open invoices - allocated receipts, as the API reports it.
    for (const [party, balance] of [
      [s.clientIsb, w('isb.balance')],
      [s.clientLhr, w('lhr.balance')],
    ] as const) {
      const ledger = await c.send('accountant', 'GET', `/receivables/customers/${party}/ledger`);
      const open = val<{ outstanding: string }[]>(ledger.body, 'openInvoices');
      const cents = open.reduce(
        (total, invoice) => total + Math.round(Number(invoice.outstanding) * 100),
        0,
      );
      expect(val(ledger.body, 'balance.balance')).toBe(balance);
      expect((cents / 100).toFixed(2)).toBe(balance);
    }
    // Vendor ledger = posted bills - payments: both vendors are paid in full.
    for (const [party, billed] of [
      [s.vendorId, w('bill.gross')],
      [s.subId, w('sub.netPayable')],
    ] as const) {
      const ledger = await c.send('accountant', 'GET', `/payables/vendors/${party}/ledger`);
      expect(val(ledger.body, 'balance.balance')).toBe('0.00');
      expect(val(ledger.body, 'balance.netPayable')).toBe(billed);
    }
    // Tax report = the tax snapshots of the month's invoices, credit notes and bills.
    const fbr = await c.send('accountant', 'GET', '/tax/reports?authority=FBR&month=2026-11');
    expect(val(fbr.body, 'outputTax.base')).toBe(w('tax.fbr.output.base'));
    expect(val(fbr.body, 'outputTax.tax')).toBe(w('tax.fbr.output.tax'));
    expect(val(fbr.body, 'inputTax.base')).toBe(w('tax.fbr.input.base'));
    expect(val(fbr.body, 'inputTax.tax')).toBe(w('tax.fbr.input.tax'));
    expect(val(fbr.body, 'withholdingDeducted.tax')).toBe(w('sub.withholding'));
    const pra = await c.send('accountant', 'GET', '/tax/reports?authority=PRA&month=2026-11');
    expect(val(pra.body, 'outputTax.base')).toBe(w('tax.pra.output.base'));
    expect(val(pra.body, 'outputTax.tax')).toBe(w('tax.pra.output.tax'));
    // Project profitability against the hand-calculated worksheet.
    const isb = await c.send('accountant', 'GET', `/profitability/projects/${s.isbProjectId}`);
    for (const key of [
      'contractValue',
      'billedBase',
      'billedTax',
      'billedGross',
      'billedPercent',
      'collectedGross',
      'collectedBase',
      'withheldTax',
      'collectedPercent',
      'outstandingReceivable',
      'committed',
      'approved',
      'posted',
      'costToDate',
      'budget',
      'costPercentOfBudget',
      'costToComplete',
      'expectedMargin',
      'expectedMarginPercent',
      'currentMargin',
      'currentMarginPercent',
      'paidOutVendors',
      'paidOutWages',
      'paidOutExpenses',
      'paidOut',
      'cashPosition',
    ]) {
      expect([key, val(isb.body, key)]).toEqual([key, w(`pft.isb.${key}`)]);
    }
    // The Lahore project received an advance; its billed and collected base figures are an open
    // question (docs/cutover/gate-b-findings.md, Q-1) and are not asserted here.
    const lhr = await c.send('accountant', 'GET', `/profitability/projects/${s.lhrProjectId}`);
    for (const key of [
      'contractValue',
      'billedGross',
      'collectedGross',
      'outstandingReceivable',
      'committed',
      'approved',
      'posted',
      'costToDate',
      'budget',
      'costPercentOfBudget',
      'costToComplete',
      'expectedMargin',
      'expectedMarginPercent',
      'paidOutVendors',
      'paidOutWages',
      'paidOut',
      'cashPosition',
    ]) {
      expect([key, val(lhr.body, key)]).toEqual([key, w(`pft.lhr.${key}`)]);
    }
  });

  // BR-2: the accountant exports. Eleven of the fourteen tie out to their owning modules in this
  // scenario. Three do not, and each is a finding of this gate (docs/cutover/gate-b-findings.md,
  // F-1 to F-3). They are recorded as `it.fails`: the suite passes while the defect stands and
  // fails the day it is fixed, which is the signal to turn the test into a plain one.
  const exportRange = { from: '2026-11-01', to: '2026-11-30' };
  const tiedOut = [
    'purchase_register',
    'receipts_register',
    'cash_bank_book',
    'pdc_register',
    'customer_ledger',
    'vendor_ledger',
    'aging',
    'payroll_summary',
    'stock_valuation',
    'project_cost_profit',
    'subcontractor_statements',
  ];
  it('step 12c: eleven accountant exports tie out to their owning modules', async () => {
    const checksums: Record<string, string> = {};
    for (const code of tiedOut) {
      const run = await c.send('accountant', 'POST', `/exports/${code}/run`, exportRange);
      expect(val<number>(run.body, 'run.rowCount')).toBeGreaterThan(0);
      checksums[code] = val(run.body, 'run.checksumSha256');
      expect(checksums[code]).toMatch(/^[0-9a-f]{64}$/);
      if (code === 'purchase_register') {
        expect(val(run.body, 'totals.base')).toBe(w('tax.fbr.input.base'));
        expect(val(run.body, 'totals.tax')).toBe(w('tax.fbr.input.tax'));
        expect(val(run.body, 'totals.gross')).toBe(w('purchase.gross'));
        expect(val(run.body, 'totals.withholding')).toBe(w('sub.withholding'));
        expect(val(run.body, 'totals.net_payable')).toBe(w('purchase.netPayable'));
      }
      if (code === 'receipts_register') {
        expect(val(run.body, 'totals.amount')).toBe(w('receipts.amount'));
        expect(val(run.body, 'totals.withheld')).toBe(w('receipts.withheld'));
      }
    }
    // The same filters give the same file: the checksum is stable.
    const again = await c.send('accountant', 'POST', '/exports/purchase_register/run', exportRange);
    expect(val(again.body, 'run.checksumSha256')).toBe(checksums.purchase_register);
  });
  it.fails(
    'F-1: the sales register ties out when an advance invoice is in the period',
    async () => {
      const run = await h.call('accountant', 'POST', '/exports/sales_register/run', exportRange);
      expect(run.status).toBe(201);
    },
  );
  it.fails('F-2: the payments register ties out when tax was withheld from a payment', async () => {
    const run = await h.call('accountant', 'POST', '/exports/payments_register/run', exportRange);
    expect(run.status).toBe(201);
  });
  it.fails(
    'F-3: the tax report and withholding export include tax the clients withheld',
    async () => {
      const run = await h.call(
        'accountant',
        'POST',
        '/exports/withholding_report/run',
        exportRange,
      );
      expect(run.status).toBe(201);
      const fbr = await c.send('accountant', 'GET', '/tax/reports?authority=FBR&month=2026-11');
      // The Islamabad client withheld 20,000.00 against FBR, certificate WHT-CERT-ISB-1.
      expect(val(fbr.body, 'withholdingSuffered.tax')).toBe(w('tax.fbr.suffered'));
    },
  );

  it('step 13: every reconciliation of BR-3 holds to the paisa', async () => {
    await c.deliver();
    expect(await runReconciliations(h.db)).toEqual([]);
    expect(await runIntegrityChecks(h.db)).toEqual([]);
  });

  // T-2: each reconciliation as its own test, with a fault injected that it must catch. The fault
  // is written inside a transaction that is rolled back, so the next test sees the healthy books.
  const faults: Record<ReconciliationCheck, string> = {
    // A receipt allocates more than it received.
    customer_ledger: `update rcv_allocations set amount = amount + 1
                       where kind = 'invoice' and amount = 192000`,
    // A payment allocation that the ledger view does not know about.
    vendor_ledger: `update pay_payment_allocations set amount = amount + 1 where amount = 45140`,
    // The cash book entry of a payment differs from the payment.
    cash_book: `update cbk_transactions set amount = amount + 1
                 where direction = 'out' and amount = 45140`,
    // The statement no longer agrees with the books.
    bank_reconciliation: `update cbk_reconciliations
                             set statement_closing_balance = statement_closing_balance + 1`,
    // A cent of drift in the valuation state.
    stock_valuation: `update val_wa_state set total_value = total_value + 0.01;
                      update val_layers set remaining_value = remaining_value + 0.01`,
    // A posted cost that no source document supports.
    cost_ledger: `update prj_cost_entries set amount = amount + 1 where source_doc_type = 'stock_issue'`,
    // An invoice header that no longer matches its tax snapshot.
    tax_report: `update bil_invoices set tax_total = tax_total + 1, gross_total = gross_total + 1
                  where number = 'INV-2026-0002'`,
    // A payroll payment that is not in the cash book for the same amount.
    payroll_cash: `update pyr_payments set amount = amount + 1`,
  };
  class Rollback extends Error {}
  const withFault = async (sql: string, check: ReconciliationCheck) => {
    let found: string[] = [];
    try {
      await h.db.transaction(async (tx) => {
        // Triggers keep the ledgers append-only; the fault is written as a database fault would be.
        await tx.exec('set local session_replication_role = replica');
        await tx.exec(sql);
        found = (await runReconciliation(tx, check)).map((finding) => finding.detail);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return found;
  };
  for (const check of reconciliationChecks) {
    it(`reconciliation ${check}: holds on the healthy books and fails when a row is altered`, async () => {
      expect(await runReconciliation(h.db, check)).toEqual([]);
      expect((await withFault(faults[check], check)).length).toBeGreaterThan(0);
      expect(await runReconciliation(h.db, check)).toEqual([]);
    });
  }

  it('step 14: every money-changing row of the scenario has an audit entry (BR-5)', async () => {
    expect(await findUnauditedMoneyRows(h.db)).toEqual([]);
    const [row] = await h.db.query<{ n: string }>(
      `select count(*)::text as n from sys_audit_log where action like 'payables.%' or action like 'billing.%'
          or action like 'receivables.%' or action like 'payroll.%' or action like 'cashbook.%'`,
    );
    expect(Number(row?.n)).toBeGreaterThan(20);
  });

  it('step 14b: the audit check finds a row whose audit entries are gone', async () => {
    let gaps: string[] = [];
    class Undo extends Error {}
    try {
      await h.db.transaction(async (tx) => {
        await tx.exec('set local session_replication_role = replica');
        await tx.exec(
          `delete from sys_audit_log where entity_id in (select id::text from pay_payments)`,
        );
        gaps = await findUnauditedMoneyRows(tx);
        throw new Undo();
      });
    } catch (error) {
      if (!(error instanceof Undo)) throw error;
    }
    expect(gaps.filter((gap) => gap.startsWith('vendor payment')).length).toBeGreaterThan(0);
    expect(await findUnauditedMoneyRows(h.db)).toEqual([]);
  });

  it('step 15: backup and restore rehearsal on the finance dataset passes every check (BR-6)', async () => {
    const dump = await dumpDatabase(h.db);
    const fresh = await createTestDb();
    await restoreDatabase(fresh, dump);
    expect(await fingerprint(fresh)).toEqual(await fingerprint(h.db));
    expect(await runReconciliations(fresh)).toEqual([]);
    expect(await runIntegrityChecks(fresh)).toEqual([]);
    expect(await findUnauditedMoneyRows(fresh)).toEqual([]);
    // The restored books keep working: the next cash book number continues the series.
    const [before] = await fresh.query<{ top: string }>(
      'select max(number)::text as top from cbk_transactions',
    );
    expect(before?.top).toMatch(/^CB-2026-\d{5}$/);
  }, 120_000);
});

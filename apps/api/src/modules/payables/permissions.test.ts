import { findTablesWithoutRls } from '@emporium/db';
import { payablesPermissionGrants, payablesPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayablesKit, TODAY, type PayablesKit } from './test-support.js';

let kit: PayablesKit;
beforeAll(async () => {
  kit = await createPayablesKit();
}, 180_000);
afterAll(() => kit.close());

describe('payables permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(payablesPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...payablesPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: accountant works, procurement enters and reads, management reads the ledger', () => {
    for (const permission of Object.values(payablesPermissions)) {
      expect(payablesPermissionGrants[permission]).toContain('accountant');
    }
    expect(payablesPermissionGrants['payables.bill.create']).toContain('procurement');
    expect(payablesPermissionGrants['payables.bill.read']).toContain('procurement');
    expect(payablesPermissionGrants['payables.ledger.read']).toContain('management');
    for (const permission of [
      'payables.bill.post',
      'payables.bill.override_match',
      'payables.payment.create',
      'payables.payment.pay',
    ] as const) {
      expect(payablesPermissionGrants[permission]).not.toContain('procurement');
      expect(payablesPermissionGrants[permission]).not.toContain('management');
    }
  });
});

describe('the tax report source (P2-01 BR-8)', () => {
  it('reports the input tax of posted bills and the withholding of paid payments', async () => {
    await kit.withholdingRule();
    const received = await kit.receipt();
    const bill = await kit.postedBill(kit.billInput(received, { nature: 'works' }));
    await kit.setThreshold('1000000000');
    const approved = await kit.approvedPayment({
      vendorPartyId: received.vendorId,
      paymentDate: TODAY,
      method: 'cash',
      accountId: await kit.bank(),
      allocations: [{ billId: bill.id, amount: '5500' }],
    });
    await kit.run((tx) => kit.payables.payments.pay(approved.id, approved.version, kit.pactor, tx));
    const report = await kit.tax.taxReportData(kit.db, 'FBR', '2026-10');
    expect(Number(report.inputTax.tax)).toBeGreaterThanOrEqual(500);
    expect(Number(report.withholdingDeducted.tax)).toBeGreaterThanOrEqual(100);
    const later = await kit.receipt();
    const other = await kit.postedBill(kit.billInput(later));
    const posted = await kit.tax.taxReportData(kit.db, 'FBR', '2026-10');
    expect(Number(posted.inputTax.tax) - Number(report.inputTax.tax)).toBe(500);
    await kit.run((tx) =>
      kit.payables.bills.cancel(other.id, { reason: 'x', version: other.version }, kit.pactor, tx),
    );
    const after = await kit.tax.taxReportData(kit.db, 'FBR', '2026-10');
    expect(after.inputTax.tax).toBe(report.inputTax.tax);
  });
});

describe('payables schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('keeps payment allocations immutable', async () => {
    const received = await kit.receipt();
    const bill = await kit.postedBill(kit.billInput(received));
    await kit.setThreshold('1000000000');
    const payment = await kit.approvedPayment({
      vendorPartyId: received.vendorId,
      paymentDate: TODAY,
      method: 'cash',
      accountId: await kit.bank(),
      allocations: [{ billId: bill.id, amount: '100' }],
    });
    await expect(
      kit.db.query('update pay_payment_allocations set amount = 1 where payment_id = $1', [
        payment.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      kit.db.query('delete from pay_payment_allocations where payment_id = $1', [payment.id]),
    ).rejects.toThrow(/immutable/);
    await expect(kit.db.query('truncate pay_payment_allocations')).rejects.toThrow(/immutable/);
  });

  it('enforces one bill per vendor invoice number in the database (BR-2)', async () => {
    const received = await kit.receipt();
    const input = kit.billInput(received, { vendorInvoiceNo: 'DB-DUP' });
    const first = await kit.run((tx) => kit.payables.bills.create(input, kit.pactor, tx));
    await expect(
      kit.db.query(
        `insert into pay_bills (id, number, vendor_party_id, vendor_invoice_no, bill_date, due_date, source_type)
         values ('018f7c7c-0000-7000-8000-0000000000f1', 'X-1', $1, 'DB-DUP', $2, $2, 'purchase')`,
        [first.vendorPartyId, TODAY],
      ),
    ).rejects.toThrow(/unique/);
  });

  it('uses the vendor bill number series and the owner approval rule (H-27, H-09)', async () => {
    const series = await kit.db.query<{ prefix: string }>(
      "select prefix from sys_number_series where code = 'vendor_bill'",
    );
    expect(series).toEqual([{ prefix: 'VB' }]);
    const rule = await kit.db.query<{ role_code: string }>(
      `select s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'vendor_bill'`,
    );
    expect(rule).toEqual([{ role_code: 'management' }]);
  });

  it('refuses a cancelled bill or payment without a reason and a cheque without its number', async () => {
    await expect(
      kit.db.query(
        `insert into pay_bills (id, number, vendor_party_id, vendor_invoice_no, bill_date, due_date, source_type, status)
         values ('018f7c7c-0000-7000-8000-0000000000f2', 'X-2', '018f7c7c-0000-7000-8000-0000000000f3', 'C-1', $1, $1, 'purchase', 'cancelled')`,
        [TODAY],
      ),
    ).rejects.toThrow(/check/);
    await expect(
      kit.db.query(
        `insert into pay_payments (id, number, vendor_party_id, payment_date, method, amount, account_id)
         values ('018f7c7c-0000-7000-8000-0000000000f4', 'X-3', '018f7c7c-0000-7000-8000-0000000000f3', $1, 'cheque', 1, '018f7c7c-0000-7000-8000-0000000000f5')`,
        [TODAY],
      ),
    ).rejects.toThrow(/check/);
  });
});

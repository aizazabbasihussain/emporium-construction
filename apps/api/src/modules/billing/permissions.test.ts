import { findTablesWithoutRls } from '@emporium/db';
import { billingPermissionGrants, billingPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBillingKit, uid, type BillingKit } from './test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

describe('billing permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(billingPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...billingPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant works, management reads, nobody else holds a permission', () => {
    const holders = new Set(Object.values(billingPermissionGrants).flat());
    expect([...holders].sort()).toEqual(['accountant', 'admin', 'management']);
    for (const permission of Object.values(billingPermissions)) {
      expect(billingPermissionGrants[permission]).toContain('accountant');
    }
    for (const permission of ['billing.schedule.read', 'billing.invoice.read'] as const) {
      expect(billingPermissionGrants[permission]).toContain('management');
    }
    for (const permission of [
      'billing.schedule.manage',
      'billing.invoice.create',
      'billing.invoice.issue',
      'billing.creditnote.create',
      'billing.advance.manage',
    ] as const) {
      expect(billingPermissionGrants[permission]).not.toContain('management');
    }
  });
});

describe('billing schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('seeds the owner approval rules and the credit-note series, and exposes the view', async () => {
    const rules = await kit.db.query<{ doc_type: string; role_code: string }>(
      `select r.doc_type, s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type in ('invoice', 'credit_note', 'billing_schedule') order by r.doc_type`,
    );
    expect(rules).toEqual([
      { doc_type: 'billing_schedule', role_code: 'management' },
      { doc_type: 'credit_note', role_code: 'management' },
      { doc_type: 'invoice', role_code: 'management' },
    ]);
    const series = async () =>
      kit.db.query<{ code: string; gapless: boolean; prefix: string }>(
        "select code, gapless, prefix from sys_number_series where code in ('invoice', 'credit_note') order by code",
      );
    expect(await series()).toEqual([{ code: 'invoice', gapless: true, prefix: 'INV' }]);
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const view = await kit.db.query<Record<string, string | null>>(
      'select * from bil_v_invoices where id = $1',
      [invoice.id],
    );
    expect(view[0]).toMatchObject({
      number: invoice.number,
      status: 'issued',
      gross_total: '1650000.00',
      credited_total: '0.00',
      authority_code: 'FBR',
    });
  });

  it('refuses an issued invoice without a number or a snapshot, an advance above its amount, and a negative recovery', async () => {
    const insertInvoice = (values: string) =>
      kit.db.query(
        `insert into bil_invoices (id, source_type, project_id, party_id, invoice_date, due_date, status, ${values.split('|')[0]})
         values (gen_random_uuid(), 'project_stage', $1, $1, '2026-11-18', '2026-11-18', $2, ${values.split('|')[1]})`,
        [uid(1), values.split('|')[2]],
      );
    await expect(insertInvoice('base_amount|1|issued')).rejects.toThrow();
    await expect(insertInvoice('advance_recovery|-1|draft')).rejects.toThrow();
    await expect(
      kit.db.query(
        `insert into bil_advances (id, project_id, party_id, amount, applied)
         values (gen_random_uuid(), $1, $1, 10, 11)`,
        [uid(1)],
      ),
    ).rejects.toThrow();
    await expect(
      kit.db.query(
        `insert into bil_invoices (id, source_type, project_id, party_id, invoice_date, due_date)
         values (gen_random_uuid(), 'project_stage', $1, $1, '2026-11-18', '2026-11-17')`,
        [uid(1)],
      ),
    ).rejects.toThrow();
  });

  it('never gives two invoices the same number', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    await expect(
      kit.db.query(
        `insert into bil_invoices (id, number, source_type, project_id, party_id, invoice_date, due_date, status, tax_snapshot)
         values (gen_random_uuid(), $1, 'project_stage', $2, $2, '2026-11-18', '2026-11-18', 'issued', '{}')`,
        [invoice.number, uid(1)],
      ),
    ).rejects.toThrow();
  });
});

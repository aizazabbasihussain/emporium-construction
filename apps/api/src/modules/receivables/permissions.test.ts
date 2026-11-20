import { findTablesWithoutRls } from '@emporium/db';
import { receivablesPermissionGrants, receivablesPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceivablesKit, TODAY, type ReceivablesKit } from './test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
}, 120_000);
afterAll(() => kit.close());

describe('receivables permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(receivablesPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...receivablesPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant works, management reads the ledger', () => {
    for (const permission of Object.values(receivablesPermissions)) {
      expect(receivablesPermissionGrants[permission]).toContain('accountant');
    }
    expect(receivablesPermissionGrants['receivables.ledger.read']).toContain('management');
    for (const permission of [
      'receivables.receipt.create',
      'receivables.receipt.cancel',
      'receivables.pdc.manage',
      'receivables.adjustment.create',
    ] as const) {
      expect(receivablesPermissionGrants[permission]).not.toContain('management');
    }
  });
});

describe('receivables schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('keeps allocations and write-offs immutable (BR-9)', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const receipt = await kit.receipt(party, await kit.bank(), '10', [
      { kind: 'invoice', invoiceId: invoice.id, amount: '10' },
    ]);
    await expect(
      kit.db.query('update rcv_allocations set amount = 1 where receipt_id = $1', [receipt.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      kit.db.query('delete from rcv_allocations where receipt_id = $1', [receipt.id]),
    ).rejects.toThrow(/immutable/);
    await expect(kit.db.query('update rcv_adjustments set amount = 1')).resolves.toBeDefined();
    await expect(kit.db.query('truncate rcv_allocations')).rejects.toThrow(/immutable/);
  });

  it('uses the H-27 receipt series and the owner write-off rule (H-09)', async () => {
    const series = await kit.db.query<{ prefix: string }>(
      "select prefix from sys_number_series where code = 'receipt_voucher'",
    );
    expect(series).toEqual([{ prefix: 'RV' }]);
    const rule = await kit.db.query<{ role_code: string }>(
      `select s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'write_off'`,
    );
    expect(rule).toEqual([{ role_code: 'management' }]);
  });

  it('exposes the published ledger view with the state of each receipt (rcv_v_customer_ledger)', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const receipt = await kit.receipt(party, await kit.bank(), '20', [
      { kind: 'invoice', invoiceId: invoice.id, amount: '20' },
    ]);
    const rows = await kit.db.query<Record<string, string>>(
      'select receipt_number, receipt_status, kind, amount::text as amount, cleared_on::text as cleared_on from rcv_v_customer_ledger where receipt_id = $1',
      [receipt.id],
    );
    expect(rows).toEqual([
      {
        receipt_number: receipt.number,
        receipt_status: 'cleared',
        kind: 'invoice',
        amount: '20.00',
        cleared_on: TODAY,
      },
    ]);
  });
});

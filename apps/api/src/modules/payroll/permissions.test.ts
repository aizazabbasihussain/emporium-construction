import { findTablesWithoutRls } from '@emporium/db';
import { payrollPermissionGrants, payrollPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayrollKit, type PayrollKit } from './test-support.js';

let kit: PayrollKit;
beforeAll(async () => {
  kit = await createPayrollKit();
}, 180_000);
afterAll(() => kit.close());

describe('payroll permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(payrollPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...payrollPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant runs payroll, management reads, reverses and reopens', () => {
    for (const permission of ['payroll.run.create', 'payroll.run.finalize'] as const) {
      expect(payrollPermissionGrants[permission]).toContain('accountant');
      expect(payrollPermissionGrants[permission]).not.toContain('management');
    }
    expect(payrollPermissionGrants['payroll.payment.create']).toContain('accountant');
    expect(payrollPermissionGrants['payroll.payment.create']).not.toContain('management');
    for (const permission of ['payroll.payment.reverse', 'payroll.run.reopen'] as const) {
      expect(payrollPermissionGrants[permission]).toContain('management');
      expect(payrollPermissionGrants[permission]).not.toContain('accountant');
    }
    for (const permission of ['payroll.run.read', 'payroll.payslip.read'] as const) {
      expect(payrollPermissionGrants[permission]).toEqual(
        expect.arrayContaining(['accountant', 'management']),
      );
    }
  });
});

describe('payroll schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('stores no bank or wallet details (BR-8)', async () => {
    const rows = await kit.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name like 'pyr\\_%'`,
    );
    expect(
      rows.filter((r) => /iban|bank_account|wallet_no|account_number/.test(r.column_name)),
    ).toEqual([]);
  });
});

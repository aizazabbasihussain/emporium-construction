import { expensesPermissionGrants, expensesPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExpensesKit, type ExpensesKit } from './test-support.js';

let kit: ExpensesKit;
beforeAll(async () => {
  kit = await createExpensesKit();
}, 60_000);
afterAll(() => kit.close());

describe('expenses permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(expensesPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...expensesPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: claimants file, finance reads, posts and issues', () => {
    const grants = expensesPermissionGrants;
    for (const role of ['supervisor', 'project_manager', 'storekeeper']) {
      expect(grants['expenses.claim.create'], role).toContain(role);
      expect(grants['expenses.claim.read_own'], role).toContain(role);
      expect(grants['expenses.claim.read_all'], role).not.toContain(role);
    }
    expect(grants['expenses.claim.read_all']).toEqual(['accountant', 'management']);
    for (const permission of [
      'expenses.claim.post',
      'expenses.claim.reverse',
      'expenses.advance.issue',
      'expenses.category.manage',
    ] as const) {
      expect(grants[permission], permission).toEqual(['accountant']);
    }
    expect(grants['expenses.claim.create']).not.toContain('accountant');
  });

  it('every expenses table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'exp\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'exp_advances',
      'exp_categories',
      'exp_claim_lines',
      'exp_claims',
      'exp_custodians',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('seeds an approval rule for expense claims owned by management (H-09)', async () => {
    const rows = await kit.db.query<{ role_code: string; min_approvers: number }>(
      `select s.role_code, s.min_approvers from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'expense_claim'`,
    );
    expect(rows).toEqual([{ role_code: 'management', min_approvers: 1 }]);
  });

  it('seeds the number series of claims and advances', async () => {
    const rows = await kit.db.query<{ code: string; prefix: string; gapless: boolean }>(
      `select code, prefix, gapless from sys_number_series
        where code in ('expense_claim', 'expense_advance') order by code`,
    );
    expect(rows).toEqual([
      { code: 'expense_advance', prefix: 'ADV', gapless: false },
      { code: 'expense_claim', prefix: 'EXP', gapless: false },
    ]);
  });
});

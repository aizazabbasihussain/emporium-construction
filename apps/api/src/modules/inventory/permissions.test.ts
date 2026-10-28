import { inventoryPermissionGrants, inventoryPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInventoryKit, type InventoryKit } from './test-support.js';

let kit: InventoryKit;
beforeAll(async () => {
  kit = await createInventoryKit();
}, 60_000);
afterAll(() => kit.close());

describe('inventory permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(inventoryPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...inventoryPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the storekeeper moves stock, others read, a supervisor holds no issue right', () => {
    const grants = inventoryPermissionGrants;
    for (const role of [
      'storekeeper',
      'procurement',
      'project_manager',
      'management',
      'accountant',
    ]) {
      expect(grants['inventory.stock.read'], role).toContain(role);
    }
    expect(grants['inventory.stock.read']).toContain('supervisor');
    for (const permission of [
      'inventory.stock.issue',
      'inventory.stock.return',
      'inventory.stock.transfer',
      'inventory.stock.count',
    ] as const) {
      expect(grants[permission]).toEqual(['storekeeper']);
    }
    expect(grants['inventory.store.manage']).toEqual(['admin', 'storekeeper']);
    expect(grants['inventory.adjustment.approve']).toEqual(['management']);
  });

  it('seeds the approval rule of count adjustments for the owner', async () => {
    const rows = await kit.db.query<{ role_code: string }>(
      `select s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id where r.doc_type = 'stock_adjustment'`,
    );
    expect(rows).toEqual([{ role_code: 'management' }]);
  });

  it('every inventory table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'inv\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'inv_balances',
      'inv_count_lines',
      'inv_counts',
      'inv_issues',
      'inv_ledger',
      'inv_reorder_levels',
      'inv_stores',
      'inv_transfer_lines',
      'inv_transfers',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});

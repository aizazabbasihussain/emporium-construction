import { procurementPermissionGrants, procurementPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProcurementKit, type ProcurementKit } from './test-support.js';

let kit: ProcurementKit;
beforeAll(async () => {
  kit = await createProcurementKit();
}, 60_000);
afterAll(() => kit.close());

describe('procurement permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(procurementPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...procurementPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: procurement buys, the store keeper receives, management reads', () => {
    const grants = procurementPermissionGrants;
    for (const role of ['supervisor', 'project_manager', 'storekeeper', 'procurement']) {
      expect(grants['procurement.requisition.create'], role).toContain(role);
    }
    expect(grants['procurement.rfq.manage']).toEqual(['procurement']);
    expect(grants['procurement.po.create']).toEqual(['procurement']);
    expect(grants['procurement.po.amend']).toEqual(['procurement']);
    expect(grants['procurement.po.close']).toEqual(['procurement']);
    expect(grants['procurement.po.read']).toContain('management');
    expect(grants['procurement.po.read']).not.toContain('supervisor');
    expect(grants['procurement.grn.create']).toEqual(['storekeeper', 'supervisor']);
    expect(grants['procurement.grn.cancel']).toEqual(['storekeeper', 'supervisor']);
  });

  it('every procurement table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'prc\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'prc_counters',
      'prc_grn_lines',
      'prc_grns',
      'prc_po_lines',
      'prc_purchase_orders',
      'prc_quote_lines',
      'prc_quotes',
      'prc_requisition_lines',
      'prc_requisitions',
      'prc_rfq_vendors',
      'prc_rfqs',
      'prc_selections',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});

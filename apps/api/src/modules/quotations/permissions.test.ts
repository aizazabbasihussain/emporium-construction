import { quotationsPermissionGrants, quotationsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQuotationsKit, type QuotationsKit } from './test-support.js';

let kit: QuotationsKit;
beforeAll(async () => {
  kit = await createQuotationsKit();
}, 60_000);
afterAll(() => kit.close());

describe('quotations permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(quotationsPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...quotationsPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: management and project managers act, the accountant reads', () => {
    for (const [permission, roles] of Object.entries(quotationsPermissionGrants)) {
      if (permission === 'quotations.margin.read') continue;
      expect(roles, permission).toContain('management');
      expect(roles, permission).toContain('project_manager');
      expect(roles, permission).not.toContain('supervisor');
      if (permission !== 'quotations.quotation.read')
        expect(roles, permission).not.toContain('accountant');
    }
    expect(quotationsPermissionGrants['quotations.quotation.read']).toContain('accountant');
  });

  it('shows the margin to management and the accountant only', () => {
    expect([...quotationsPermissionGrants['quotations.margin.read']].sort()).toEqual([
      'accountant',
      'management',
    ]);
  });

  it('every quotations table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'qte\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'qte_quotations',
      'qte_stages',
      'qte_status_history',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});

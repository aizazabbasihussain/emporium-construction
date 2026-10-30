import { wagesPermissionGrants, wagesPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWagesKit, type WagesKit } from './test-support.js';

let kit: WagesKit;
beforeAll(async () => {
  kit = await createWagesKit();
}, 60_000);
afterAll(() => kit.close());

describe('wages permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(wagesPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...wagesPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: finance and management work on wages and supervisors have no access', () => {
    const grants = wagesPermissionGrants;
    expect(grants['wages.period.read']).toEqual(['accountant', 'management']);
    expect(grants['wages.period.calculate']).toEqual(['accountant', 'management']);
    expect(grants['wages.period.submit']).toEqual(['accountant', 'management']);
    expect(grants['wages.period.reopen']).toEqual(['management']);
    expect(grants['wages.adjustment.manage']).toEqual(['accountant']);
    expect(grants['wages.advance.manage']).toEqual(['accountant']);
    for (const roles of Object.values(grants)) {
      expect(roles).not.toContain('supervisor');
    }
  });

  it('every wages table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'wag\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'wag_adjustments',
      'wag_advance_recoveries',
      'wag_advances',
      'wag_lines',
      'wag_periods',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('seeds the approval rule: the owner (management) approves a wage period', async () => {
    const rules = await kit.db.query<{ role_code: string; min_approvers: number }>(
      `select s.role_code, s.min_approvers from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'wage_period'`,
    );
    expect(rules).toEqual([{ role_code: 'management', min_approvers: 1 }]);
  });

  it('knows the H-11 defaults as editable settings', async () => {
    const value = async (key: string) => (await kit.platform.settings.get(kit.db, key)).value;
    expect(await value('workforce.working_days_basis')).toBe(26);
    expect(await value('attendance.overtime_multiplier')).toBe('1.5');
    expect(await value('wages.round_net_to_rupee')).toBe(true);
    expect(await value('wages.pay_off_days_daily')).toBe(false);
  });
});

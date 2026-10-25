import { findTablesWithoutRls } from '@emporium/db';
import { valuationPermissionGrants, valuationPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createValuationKit, type ValuationKit } from './test-support.js';

let kit: ValuationKit;
beforeAll(async () => {
  kit = await createValuationKit();
}, 60_000);
afterAll(() => kit.close());

describe('valuation permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(valuationPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...valuationPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant requests, owner roles read, the storekeeper only reads policies', () => {
    expect(valuationPermissionGrants['valuation.policy.request']).toEqual(['accountant']);
    expect(valuationPermissionGrants['valuation.transition.run']).toEqual(
      expect.arrayContaining(['accountant', 'admin']),
    );
    expect(valuationPermissionGrants['valuation.report.read']).toEqual(
      expect.arrayContaining(['accountant', 'management']),
    );
    expect(valuationPermissionGrants['valuation.policy.read']).toContain('storekeeper');
    for (const permission of Object.values(valuationPermissions)) {
      if (permission !== 'valuation.policy.read') {
        expect(valuationPermissionGrants[permission]).not.toContain('storekeeper');
      }
    }
  });
});

describe('valuation schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('seeds one active company policy, weighted average (H-07 default)', async () => {
    const rows = await kit.db.query<{ method: string; scope: string }>(
      "select method, scope from val_policies where status = 'active'",
    );
    expect(rows).toEqual([{ method: 'weighted_average', scope: 'company' }]);
  });

  it('seeds the approval rule for policy changes: the owner approves (H-09)', async () => {
    const rows = await kit.db.query<{ role_code: string }>(
      `select s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'valuation_policy'`,
    );
    expect(rows).toEqual([{ role_code: 'management' }]);
  });

  it('allows only one active policy per scope key and start date', async () => {
    const insert = (id: string, status: string) =>
      kit.db.query(
        `insert into val_policies (id, scope, method, effective_from, status)
         values ($1, 'company', 'fifo', date '2030-01-01', $2)`,
        [id, status],
      );
    await insert('018f7c7c-7777-7000-8000-000000000001', 'active');
    await expect(insert('018f7c7c-7777-7000-8000-000000000002', 'active')).rejects.toThrow();
    await insert('018f7c7c-7777-7000-8000-000000000003', 'superseded');
  });

  it('keeps a key from holding negative quantity or value', async () => {
    await expect(
      kit.db.query(
        `insert into val_wa_state (store_id, item_id, quantity, total_value)
         values ('018f7c7c-7777-7000-8000-000000000010', '018f7c7c-7777-7000-8000-000000000011', -1, 0)`,
      ),
    ).rejects.toThrow();
  });
});

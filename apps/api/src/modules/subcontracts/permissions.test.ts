import { findTablesWithoutRls } from '@emporium/db';
import { subcontractsPermissionGrants, subcontractsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSubcontractsKit, type SubcontractsKit } from './test-support.js';

let kit: SubcontractsKit;
beforeAll(async () => {
  kit = await createSubcontractsKit();
}, 180_000);
afterAll(() => kit.close());

describe('subcontracts permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(subcontractsPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...subcontractsPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: managers work the orders, the accountant reads, supervisors draft', () => {
    for (const permission of [
      'subcontracts.order.read',
      'subcontracts.order.create',
      'subcontracts.order.update',
      'subcontracts.order.close',
    ] as const) {
      expect(subcontractsPermissionGrants[permission]).toContain('project_manager');
      expect(subcontractsPermissionGrants[permission]).toContain('management');
    }
    expect(subcontractsPermissionGrants['subcontracts.order.read']).toContain('accountant');
    expect(subcontractsPermissionGrants['subcontracts.order.create']).not.toContain('accountant');
    expect(subcontractsPermissionGrants['subcontracts.certificate.create']).toContain('supervisor');
    expect(subcontractsPermissionGrants['subcontracts.certificate.submit']).not.toContain(
      'supervisor',
    );
    // BR-9: a supervisor sees the orders but not the amounts.
    expect(subcontractsPermissionGrants['subcontracts.order.read']).toContain('supervisor');
    expect(subcontractsPermissionGrants['subcontracts.amount.read']).not.toContain('supervisor');
    expect(subcontractsPermissionGrants['subcontracts.amount.read'].slice().sort()).toEqual([
      'accountant',
      'admin',
      'management',
      'project_manager',
    ]);
  });
});

describe('subcontracts schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('keeps retention at zero in the database (BR-8)', async () => {
    await expect(
      kit.db.query(
        `insert into sub_work_orders (id, number, project_id, party_id, title, contract_amount, cost_code_id, retention_percent)
         values ('018f7c7c-0000-7000-8000-0000000000a1', 'X-1', '018f7c7c-0000-7000-8000-0000000000a2',
                 '018f7c7c-0000-7000-8000-0000000000a3', 't', 10, '018f7c7c-0000-7000-8000-0000000000a4', 5)`,
      ),
    ).rejects.toThrow(/check/);
  });

  it('uses its number series and approval rules (H-09, BR-1, BR-4)', async () => {
    const series = await kit.db.query<{ code: string; prefix: string }>(
      "select code, prefix from sys_number_series where code like 'subcontract_%' order by code",
    );
    expect(series).toEqual([
      { code: 'subcontract_certificate', prefix: 'SCC' },
      { code: 'subcontract_order', prefix: 'SCO' },
    ]);
    const rules = await kit.db.query<{ doc_type: string; role_code: string }>(
      `select r.doc_type, s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type like 'subcontract_%' order by r.doc_type`,
    );
    expect(rules).toEqual([
      { doc_type: 'subcontract_certificate', role_code: 'project_manager' },
      { doc_type: 'subcontract_order', role_code: 'management' },
    ]);
  });

  it('refuses a back-charge that recovers a cost without a cost code', async () => {
    await expect(
      kit.db.query(
        `insert into sub_back_charges (id, work_order_id, description, amount, recovers_cost)
         values ('018f7c7c-0000-7000-8000-0000000000b1', '018f7c7c-0000-7000-8000-0000000000b2', 'd', 1, true)`,
      ),
    ).rejects.toThrow();
  });
});

import { findTablesWithoutRls } from '@emporium/db';
import { taxPermissionGrants, taxPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaxKit, type TaxKit } from './test-support.js';

let kit: TaxKit;
beforeAll(async () => {
  kit = await createTaxKit();
}, 60_000);
afterAll(() => kit.close());

describe('tax permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(taxPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...taxPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: the accountant manages, the accountant and management read', () => {
    expect(taxPermissionGrants['tax.rule.manage']).toEqual(['accountant']);
    for (const permission of ['tax.rule.read', 'tax.report.read'] as const) {
      expect(taxPermissionGrants[permission]).toEqual(
        expect.arrayContaining(['accountant', 'management']),
      );
    }
  });
});

describe('tax schema', () => {
  it('has RLS deny-all on every table (constitution 7.7)', async () => {
    expect(await findTablesWithoutRls(kit.db)).toEqual([]);
  });

  it('seeds only the authorities and the settings, never a rule', async () => {
    const counts = await kit.db.query<{ t: string; n: string }>(
      `select 'rules' as t, count(*) as n from tax_rules
       union all select 'withholding', count(*) from tax_withholding_rules
       union all select 'region', count(*) from tax_region_map`,
    );
    expect(counts.map((c) => Number(c.n))).toEqual([0, 0, 0]);
    expect(
      (await kit.db.query<{ code: string }>('select code from tax_authorities order by code')).map(
        (r) => r.code,
      ),
    ).toEqual(['FBR', 'PRA']);
    expect(await kit.db.query('select key, value from tax_settings order by key')).toEqual([
      { key: 'prices_include_tax', value: 'false' },
      { key: 'rounding_mode', value: 'per_document' },
    ]);
  });

  it('seeds the approval rule: the owner approves rule changes (H-09)', async () => {
    const rows = await kit.db.query<{ role_code: string }>(
      `select s.role_code from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'tax_rule'`,
    );
    expect(rows).toEqual([{ role_code: 'management' }]);
  });

  it('refuses a rate outside 0 to 100 and a range that ends before it starts', async () => {
    const insert = (rate: string, from: string, to: string | null) =>
      kit.db.query(
        `insert into tax_rules (id, authority_code, supply_kind, rate_percent, tax_code, effective_from,
            effective_to, status)
         values (gen_random_uuid(), 'FBR', 'services', $1, 'X', $2, $3, 'pending_approval')`,
        [rate, from, to],
      );
    await expect(insert('100.0001', '2026-01-01', null)).rejects.toThrow();
    await expect(insert('-1', '2026-01-01', null)).rejects.toThrow();
    await expect(insert('5', '2026-02-01', '2026-01-01')).rejects.toThrow();
  });
});

describe('rule immutability (T-5, BR-5)', () => {
  const ruleId = '018f7c7c-4444-7000-8000-0000000fffff';
  beforeAll(async () => {
    await kit.db.query(
      `insert into tax_rules (id, authority_code, supply_kind, rate_percent, tax_code, effective_from, status)
       values ($1, 'FBR', 'services', 5, 'IMM', '2026-01-01', 'pending_approval')`,
      [ruleId],
    );
  });

  it('never lets a rate, date range start or code change in place', async () => {
    for (const set of ['rate_percent = 6', "effective_from = '2026-02-01'", "tax_code = 'Z'"]) {
      await expect(
        kit.db.query(`update tax_rules set ${set} where id = $1`, [ruleId]),
      ).rejects.toThrow('never edited in place');
    }
  });

  it('lets a pending rule be decided once, then fixes the status', async () => {
    await kit.db.query("update tax_rules set status = 'active' where id = $1", [ruleId]);
    await expect(
      kit.db.query("update tax_rules set status = 'rejected' where id = $1", [ruleId]),
    ).rejects.toThrow('final once decided');
  });

  it('lets a rule be closed once and never reopened or moved', async () => {
    await kit.db.query("update tax_rules set effective_to = '2026-06-30' where id = $1", [ruleId]);
    await expect(
      kit.db.query("update tax_rules set effective_to = '2026-07-31' where id = $1", [ruleId]),
    ).rejects.toThrow('final once set');
    await expect(
      kit.db.query('update tax_rules set effective_to = null where id = $1', [ruleId]),
    ).rejects.toThrow('final once set');
  });

  it('never deletes or truncates a rule of any kind, and never edits the others in place', async () => {
    const withholdingId = '018f7c7c-4444-7000-8000-0000000ffffe';
    const regionId = '018f7c7c-4444-7000-8000-0000000fffed';
    await kit.db.query(
      `insert into tax_withholding_rules (id, direction, authority_code, nature, rate_percent, base,
          effective_from, status)
       values ($1, 'we_withhold', 'FBR', 'imm', 2, 'on_base', '2026-01-01', 'pending_approval')`,
      [withholdingId],
    );
    await kit.db.query(
      `insert into tax_region_map (id, region, supply_kind, authority_code, effective_from, status)
       values ($1, 'punjab', 'goods', 'FBR', '2026-01-01', 'pending_approval')`,
      [regionId],
    );
    const attempts: [string, string][] = [
      ['tax_rules', ruleId],
      ['tax_withholding_rules', withholdingId],
      ['tax_region_map', regionId],
    ];
    for (const [table, id] of attempts) {
      await expect(kit.db.query('delete from ' + table + ' where id = $1', [id])).rejects.toThrow(
        'never deleted',
      );
      await expect(kit.db.query('truncate ' + table)).rejects.toThrow('never deleted');
    }
    await expect(
      kit.db.query('update tax_withholding_rules set rate_percent = 3 where id = $1', [
        withholdingId,
      ]),
    ).rejects.toThrow('never edited in place');
    await expect(
      kit.db.query("update tax_region_map set region = 'islamabad' where id = $1", [regionId]),
    ).rejects.toThrow('never edited in place');
  });

  it('has no route that edits or deletes a rule', () => {
    const urls = [
      '/tax/rules',
      '/tax/rules/:id',
      '/tax/withholding-rules',
      '/tax/withholding-rules/:id',
    ];
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of urls)
        expect(kit.app.hasRoute({ method, url }), method + ' ' + url).toBe(false);
    }
  });
});

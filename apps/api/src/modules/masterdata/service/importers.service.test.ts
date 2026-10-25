import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importerPermissions } from '@emporium/shared';
import { ADMIN, createMasterKit, type MasterKit } from '../test-support.js';
import { parentsFirst, requireFound } from './importers.service.js';

let kit: MasterKit;
const actor = { userId: ADMIN, requestId: null };
const permissions = new Set<string>(Object.values(importerPermissions));

const dryRun = (importerCode: string, ...lines: string[]) =>
  kit.importer.service.dryRun(
    {
      importerCode,
      fileName: `${importerCode}.csv`,
      content: Buffer.from(lines.join('\n') + '\n'),
    },
    actor,
    kit.db,
  );
const commit = async (importerCode: string, ...lines: string[]) => {
  const result = await dryRun(importerCode, ...lines);
  expect(result.errors).toEqual([]);
  return kit.importer.service.commit(result.batchId, { force: false, permissions }, actor, kit.db);
};

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

beforeAll(async () => {
  kit = await createMasterKit();
}, 60_000);
afterAll(() => kit.close());

describe('importers are registered (BR-10)', () => {
  it('registers one importer per master with a working template (T-8)', async () => {
    const codes = kit.importer.service.listImporters().map((i) => i.code);
    expect(codes).toEqual([
      'cost_codes',
      'item_categories',
      'items',
      'parties',
      'tax_registrations',
      'units',
      'vendor_prices',
    ]);
    for (const code of codes.filter((c) => c !== 'vendor_prices')) {
      const template = await kit.importer.service.template(code, 'csv');
      expect(String(template.body)).toContain('\n');
      const result = await kit.importer.service.dryRun(
        {
          importerCode: code,
          fileName: `${code}.csv`,
          content: Buffer.from(String(template.body)),
        },
        actor,
        kit.db,
      );
      // The template's example row passes the row rules of its importer.
      expect(result.errors.filter((e) => e.rowNo > 1)).toEqual([]);
    }
  });
});

describe('importing the masters (AC-3, T-8)', () => {
  it('imports units', async () => {
    const batch = await commit(
      'units',
      'code,name,kind',
      'pcs,Pieces,count',
      'bundle,Bundle,count',
    );
    expect(batch.status).toBe('committed');
    expect(await kit.masterData.catalog.getUnit(kit.db, 'bundle')).toMatchObject({
      name: 'Bundle',
    });
  });

  it('dry-runs and commits item categories, parents in any order', async () => {
    const dry = await dryRun(
      'item_categories',
      'code,name,parent_code',
      'C-CHILD,Child,C-ROOT',
      'C-ROOT,Root,',
    );
    expect(dry).toMatchObject({ status: 'dry_run_ok', rowCount: 2, errorCount: 0 });
    const batch = await commit(
      'item_categories',
      'code,name,parent_code',
      'C-CHILD,Child,C-ROOT',
      'C-ROOT,Root,',
    );
    expect(batch.status).toBe('committed');
    const categories = await kit.masterData.catalog.listCategories(kit.db);
    const root = categories.find((c) => c.code === 'C-ROOT');
    expect(categories.find((c) => c.code === 'C-CHILD')?.parentId).toBe(root?.id);
  });

  it('dry-runs and commits cost codes below the seeded codes', async () => {
    const lines = [
      'code,name,parent_code,kind,active',
      '101,Cement,100,material,yes',
      '1011,Grey cement,101,material,',
      '102,Steel,100,material,no',
      '700,Standalone,,overhead,',
    ];
    expect((await dryRun('cost_codes', ...lines)).status).toBe('dry_run_ok');
    await commit('cost_codes', ...lines);
    const codes = await kit.masterData.costing.listCostCodes(kit.db);
    const steel = codes.find((c) => c.code === '102');
    const grey = codes.find((c) => c.code === '1011');
    expect(steel?.active).toBe(false);
    expect(codes.find((c) => c.code === '101')?.id).toBe(grey?.parentId);
  });

  it('imports parties and reports invalid rows with their row and column', async () => {
    const header = 'name,legal_name,roles,ntn,strn,cnic,phone,email,address,city,status,notes';
    const bad = await dryRun(
      'parties',
      header,
      ',,vendor,,,,,,,,,',
      'No Role,,,,,,,,,,,',
      'Bad Roles,,boss,,,,,,,,,',
      'Bad CNIC,,client,,,123,,,,,,',
      'Bad Phone,,client,,,,+1 415 555 0100,,,,,',
      'Bad NTN,,client,!!,,,,,,,,',
      'Bad Status,,client,,,,,,,,gone,',
    );
    expect(bad.status).toBe('dry_run_failed');
    const where = bad.errors.map((e) => `${e.rowNo}:${e.column}`);
    expect(where).toEqual(
      expect.arrayContaining([
        '2:name',
        '3:roles',
        '4:roles',
        '5:cnic',
        '6:phone',
        '7:ntn',
        '8:status',
      ]),
    );

    const good = await commit(
      'parties',
      header,
      'Import Vendor,Import Vendor (Pvt) Ltd,vendor;subcontractor,1234567-8,,35202-1234567-1,0300 1234567,v@example.test,Road 1,Lahore,active,note',
      'Import Client,,client,,,,051-2345678,,,,,',
    );
    expect(batch(good)).toBe('committed');
    const found = await kit.masterData.parties.search(kit.db, {
      q: 'Import',
      sort: 'code',
      direction: 'asc',
      limit: 50,
      offset: 0,
    });
    expect(found.items.map((p) => [p.code.slice(0, 2), p.roles])).toEqual([
      ['CL', ['client']],
      ['VN', ['vendor', 'subcontractor']],
    ]);
    expect(found.items[1]).toMatchObject({
      cnic: '3520212345671',
      phone: '+923001234567',
      ntn: '12345678',
    });
  });

  it('rolls the whole file back when a row repeats an existing party', async () => {
    const header = 'name,legal_name,roles,ntn,strn,cnic,phone,email,address,city,status,notes';
    const result = await dryRun(
      'parties',
      header,
      'Fresh One,,client,,,,,,,,,',
      'Other Name,,client,12345678,,,,,,,,',
    );
    expect(result.status).toBe('dry_run_ok');
    const failed = await codeOf(
      kit.importer.service.commit(result.batchId, { force: false, permissions }, actor, kit.db),
    );
    expect(failed).toBe('duplicate_party');
    expect(
      (
        await kit.masterData.parties.search(kit.db, {
          q: 'Fresh One',
          sort: 'name',
          direction: 'asc',
          limit: 5,
          offset: 0,
        })
      ).total,
    ).toBe(0);
  });

  it('imports items with their category and unit, and stops on a bad reference', async () => {
    const header =
      'code,name,category_code,unit,item_kind,stockable,default_tax_kind,reorder_level,active';
    await commit(
      'items',
      header,
      'IMP-1,Cement bag,C-ROOT,bag,material,yes,goods,50,yes',
      'IMP-2,Site visit,,ls,service,,services,,',
    );
    const items = await kit.masterData.catalog.searchItems(kit.db, {
      q: 'IMP-',
      sort: 'code',
      direction: 'asc',
      limit: 50,
      offset: 0,
    });
    expect(items.items.map((i) => [i.code, i.stockable, i.reorderLevel])).toEqual([
      ['IMP-1', true, '50.0000'],
      ['IMP-2', false, null],
    ]);
    const missing = await dryRun('items', header, 'IMP-3,X,NO-SUCH,bag,material,,goods,,');
    expect(
      await codeOf(
        kit.importer.service.commit(missing.batchId, { force: false, permissions }, actor, kit.db),
      ),
    ).toBe('category_unknown');
    const unstockable = await dryRun('items', header, 'IMP-4,X,,ls,service,yes,services,,');
    expect(
      await codeOf(
        kit.importer.service.commit(
          unstockable.batchId,
          { force: false, permissions },
          actor,
          kit.db,
        ),
      ),
    ).toBe('item_not_stockable');
  });

  it('needs parties and items before vendor prices, then imports them', async () => {
    const header = 'vendor_code,item_code,unit,rate,valid_from,valid_to';
    const parties = await kit.masterData.parties.search(kit.db, {
      q: 'Import Vendor',
      sort: 'code',
      direction: 'asc',
      limit: 5,
      offset: 0,
    });
    const vendorCode = parties.items[0]?.code as string;
    await commit('vendor_prices', header, `${vendorCode},IMP-1,bag,1250.50,2026-01-01,`);
    const prices = await kit.masterData.costing.searchPrices(kit.db, { limit: 50, offset: 0 });
    expect(prices.items).toHaveLength(1);
    expect(prices.items[0]).toMatchObject({ rate: '1250.5000', validTo: null });
    const unknownVendor = await dryRun('vendor_prices', header, 'VN-9999,IMP-1,bag,1,2026-01-01,');
    expect(
      await codeOf(
        kit.importer.service.commit(
          unknownVendor.batchId,
          { force: false, permissions },
          actor,
          kit.db,
        ),
      ),
    ).toBe('vendor_unknown');
    const unknownItem = await dryRun(
      'vendor_prices',
      header,
      `${vendorCode},NOPE,bag,1,2026-01-01,`,
    );
    expect(
      await codeOf(
        kit.importer.service.commit(
          unknownItem.batchId,
          { force: false, permissions },
          actor,
          kit.db,
        ),
      ),
    ).toBe('item_unknown');
  });

  it('imports tax registrations and rejects an overlap', async () => {
    const header = 'authority,registration_type,number,valid_from,valid_to';
    await commit(
      'tax_registrations',
      header,
      'FBR,ntn,SYNTHETIC-1,01/01/2026,',
      'PRA,pra,SYNTHETIC-2,2026-03-01,2026-12-31',
    );
    expect((await kit.masterData.company.getRegistration(kit.db, 'FBR'))?.validFrom).toBe(
      '2026-01-01',
    );
    const overlap = await dryRun('tax_registrations', header, 'FBR,ntn,SYNTHETIC-3,2026-06-01,');
    expect(
      await codeOf(
        kit.importer.service.commit(overlap.batchId, { force: false, permissions }, actor, kit.db),
      ),
    ).toBe('registration_overlap');
  });

  it('stops on an unknown parent code in a hierarchy file', async () => {
    const result = await dryRun('item_categories', 'code,name,parent_code', 'LOST,Lost,NO-PARENT');
    expect(
      await codeOf(
        kit.importer.service.commit(result.batchId, { force: false, permissions }, actor, kit.db),
      ),
    ).toBe('parent_unknown');
    const costs = await dryRun(
      'cost_codes',
      'code,name,parent_code,kind,active',
      '910,Lost,NO-PARENT,labour,',
    );
    expect(
      await codeOf(
        kit.importer.service.commit(costs.batchId, { force: false, permissions }, actor, kit.db),
      ),
    ).toBe('parent_unknown');
  });
});

const batch = (value: { status: string }) => value.status;

describe('helpers', () => {
  it('orders parents before children and detects loops', () => {
    const rows = [
      { code: 'c', parent_code: 'b' },
      { code: 'b', parent_code: 'a' },
      { code: 'a', parent_code: null },
      { code: 'x', parent_code: 'outside' },
    ];
    expect(parentsFirst(rows).map((r) => r.code)).toEqual(['a', 'b', 'c', 'x']);
    expect(() =>
      parentsFirst([
        { code: 'p', parent_code: 'q' },
        { code: 'q', parent_code: 'p' },
      ]),
    ).toThrow(/loop/);
  });

  it('turns a missing reference into a validation error', () => {
    expect(requireFound({ id: 1 }, 'item', 'X')).toEqual({ id: 1 });
    expect(() => requireFound(undefined, 'item', 'X')).toThrow('item X does not exist');
  });
});

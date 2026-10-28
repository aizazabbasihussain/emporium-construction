import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, createMasterKit, eventCount, uid, type MasterKit } from '../test-support.js';
import type { ItemInput } from './catalog.service.js';

let kit: MasterKit;
const catalog = () => kit.masterData.catalog;
const tx = <T>(fn: (db: MasterKit['db']) => Promise<T>) => kit.db.transaction(fn);

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const item = (over: Partial<ItemInput> = {}): ItemInput => ({
  code: 'ITM-1',
  name: 'Cement bag',
  unitCode: 'bag',
  itemKind: 'material',
  defaultTaxKind: 'goods',
  ...over,
});

beforeAll(async () => {
  kit = await createMasterKit();
}, 60_000);
afterAll(() => kit.close());

describe('units (H-26)', () => {
  it('seeds the standard construction units', async () => {
    const codes = (await catalog().listUnits(kit.db)).map((u) => u.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'nos',
        'bag',
        'kg',
        'ton',
        'm',
        'ft',
        'sqft',
        'sqm',
        'cuft',
        'cum',
        'day',
        'hour',
        'ls',
      ]),
    );
    expect(await catalog().getUnit(kit.db, 'bag')).toMatchObject({ name: 'Bag', kind: 'count' });
    expect(await codeOf(catalog().getUnit(kit.db, 'nope'))).toBe('unit_not_found');
  });

  it('creates, updates and removes a unit', async () => {
    const unit = await tx((t) =>
      catalog().createUnit({ code: ' Pcs ', name: 'Pieces', kind: 'count' }, kit.actor, t),
    );
    expect(unit).toMatchObject({ code: 'pcs', version: 1 });
    const renamed = await tx((t) =>
      catalog().updateUnit('pcs', { name: 'Piece', kind: 'count' }, 1, kit.actor, t),
    );
    expect(renamed).toMatchObject({ name: 'Piece', version: 2 });
    expect(
      await codeOf(
        tx((t) => catalog().updateUnit('pcs', { name: 'X', kind: 'count' }, 1, kit.actor, t)),
      ),
    ).toBe('version_conflict');
    expect(
      await codeOf(
        tx((t) => catalog().updateUnit('zzz', { name: 'X', kind: 'count' }, 1, kit.actor, t)),
      ),
    ).toBe('unit_not_found');
    await tx((t) => catalog().removeUnit('pcs', 2, kit.actor, t));
    expect(await codeOf(catalog().getUnit(kit.db, 'pcs'))).toBe('unit_not_found');
    expect(await auditCount(kit.db, 'master.unit.delete')).toBe(1);
  });

  it.each([
    ['bad code', { code: '9x', name: 'N', kind: 'count' }, 'invalid_unit_code'],
    ['bad kind', { code: 'qq', name: 'N', kind: 'speed' }, 'invalid_unit_kind'],
    ['duplicate', { code: 'kg', name: 'N', kind: 'weight' }, 'code_taken'],
    ['no name', { code: 'qq', name: ' ', kind: 'count' }, 'name_required'],
  ])('rejects a unit with a %s', async (_label, input, code) => {
    expect(await codeOf(tx((t) => catalog().createUnit(input, kit.actor, t)))).toBe(code);
  });

  it('refuses to update with a bad kind and to remove a unit in use', async () => {
    expect(
      await codeOf(
        tx((t) => catalog().updateUnit('kg', { name: 'K', kind: 'speed' }, 1, kit.actor, t)),
      ),
    ).toBe('invalid_unit_kind');
    await tx((t) => catalog().createItem(item({ code: 'USE-1', unitCode: 'kg' }), kit.actor, t));
    expect(await codeOf(tx((t) => catalog().removeUnit('kg', 1, kit.actor, t)))).toBe(
      'unit_in_use',
    );
  });
});

describe('unit conversion (AC-2, T-4, BR-5)', () => {
  it('converts in both directions and fails for unrelated units', async () => {
    const pair = await tx((t) =>
      catalog().createConversion(
        { fromUnit: 'cum', toUnit: 'cuft', factor: '35.314667' },
        kit.actor,
        t,
      ),
    );
    expect(pair.factor).toBe('35.314667');
    expect(await catalog().convert(kit.db, '2', 'cum', 'cuft')).toBe('70.6293');
    expect(await catalog().convert(kit.db, '70.6293', 'cuft', 'cum')).toBe('2.0000');
    expect(await catalog().convert(kit.db, '1.23456', 'cum', 'cum')).toBe('1.2346');
    expect(await codeOf(catalog().convert(kit.db, '1', 'cum', 'kg'))).toBe('conversion_missing');
    expect(await codeOf(catalog().convert(kit.db, '1', 'cum', 'nope'))).toBe('unit_unknown');
    expect(await codeOf(catalog().convert(kit.db, '1', 'nope', 'cum'))).toBe('unit_unknown');
  });

  it('keeps one pair per two units, in either direction', async () => {
    await tx((t) =>
      catalog().createConversion({ fromUnit: 'ton', toUnit: 'kg', factor: '1000' }, kit.actor, t),
    );
    for (const [fromUnit, toUnit] of [
      ['ton', 'kg'],
      ['kg', 'ton'],
    ] as const) {
      expect(
        await codeOf(
          tx((t) => catalog().createConversion({ fromUnit, toUnit, factor: '2' }, kit.actor, t)),
        ),
      ).toBe('conversion_exists');
    }
    expect(
      await codeOf(
        tx((t) =>
          catalog().createConversion({ fromUnit: 'ton', toUnit: 'ton', factor: '1' }, kit.actor, t),
        ),
      ),
    ).toBe('conversion_same_unit');
    expect(
      await codeOf(
        tx((t) =>
          catalog().createConversion({ fromUnit: 'ton', toUnit: 'zz', factor: '1' }, kit.actor, t),
        ),
      ),
    ).toBe('unit_unknown');
    expect(
      await codeOf(
        tx((t) =>
          catalog().createConversion({ fromUnit: 'zz', toUnit: 'ton', factor: '1' }, kit.actor, t),
        ),
      ),
    ).toBe('unit_unknown');
  });

  it('updates and removes a pair with version checks', async () => {
    const pair = await tx((t) =>
      catalog().createConversion(
        { fromUnit: 'sqm', toUnit: 'sqft', factor: '10.76' },
        kit.actor,
        t,
      ),
    );
    expect((await catalog().listConversions(kit.db)).map((c) => c.id)).toContain(pair.id);
    const changed = await tx((t) =>
      catalog().updateConversion(pair.id, '10.763910', 1, kit.actor, t),
    );
    expect(changed).toMatchObject({ factor: '10.763910', version: 2 });
    expect(
      await codeOf(tx((t) => catalog().updateConversion(pair.id, '10', 1, kit.actor, t))),
    ).toBe('version_conflict');
    expect(await codeOf(tx((t) => catalog().updateConversion(pair.id, '0', 2, kit.actor, t)))).toBe(
      'conversion_factor_invalid',
    );
    expect(
      await codeOf(tx((t) => catalog().updateConversion(uid(9001), '1', 1, kit.actor, t))),
    ).toBe('conversion_not_found');
    expect(await codeOf(tx((t) => catalog().removeConversion(pair.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
    await tx((t) => catalog().removeConversion(pair.id, 2, kit.actor, t));
    expect(await codeOf(tx((t) => catalog().removeConversion(pair.id, 2, kit.actor, t)))).toBe(
      'conversion_not_found',
    );
  });
});

describe('item categories (T-5)', () => {
  it('builds a tree and rejects cycles and unknown parents', async () => {
    const root = await tx((t) =>
      catalog().createCategory({ code: 'CAT-ROOT', name: 'Root' }, kit.actor, t),
    );
    const child = await tx((t) =>
      catalog().createCategory(
        { code: 'CAT-CHILD', name: 'Child', parentId: root.id },
        kit.actor,
        t,
      ),
    );
    expect(child.parentId).toBe(root.id);
    expect((await catalog().listCategories(kit.db)).length).toBeGreaterThanOrEqual(2);
    expect(await catalog().getCategory(kit.db, child.id)).toEqual(child);
    expect(
      await codeOf(
        tx((t) =>
          catalog().updateCategory(
            root.id,
            { code: 'CAT-ROOT', name: 'Root', parentId: child.id },
            1,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('hierarchy_cycle');
    expect(
      await codeOf(
        tx((t) =>
          catalog().createCategory({ code: 'CAT-X', name: 'X', parentId: uid(9002) }, kit.actor, t),
        ),
      ),
    ).toBe('parent_unknown');
    expect(
      await codeOf(
        tx((t) => catalog().createCategory({ code: 'CAT-ROOT', name: 'Again' }, kit.actor, t)),
      ),
    ).toBe('code_taken');
    const renamed = await tx((t) =>
      catalog().updateCategory(
        child.id,
        { code: 'CAT-CHILD', name: 'Renamed', parentId: null },
        1,
        kit.actor,
        t,
      ),
    );
    expect(renamed).toMatchObject({ name: 'Renamed', parentId: null, version: 2 });
    expect(
      await codeOf(
        tx((t) => catalog().updateCategory(uid(9003), { code: 'Q', name: 'Q' }, 1, kit.actor, t)),
      ),
    ).toBe('category_not_found');
    expect(await codeOf(catalog().getCategory(kit.db, uid(9003)))).toBe('category_not_found');
  });

  it('refuses to remove a category that items or sub-categories use', async () => {
    const parent = await tx((t) =>
      catalog().createCategory({ code: 'CAT-P', name: 'P' }, kit.actor, t),
    );
    const leaf = await tx((t) =>
      catalog().createCategory({ code: 'CAT-L', name: 'L', parentId: parent.id }, kit.actor, t),
    );
    expect(await codeOf(tx((t) => catalog().removeCategory(parent.id, 1, kit.actor, t)))).toBe(
      'category_in_use',
    );
    await tx((t) =>
      catalog().createItem(item({ code: 'CAT-ITEM', categoryId: leaf.id }), kit.actor, t),
    );
    expect(await codeOf(tx((t) => catalog().removeCategory(leaf.id, 1, kit.actor, t)))).toBe(
      'category_in_use',
    );
    const free = await tx((t) =>
      catalog().createCategory({ code: 'CAT-F', name: 'F' }, kit.actor, t),
    );
    expect(await codeOf(tx((t) => catalog().removeCategory(free.id, 9, kit.actor, t)))).toBe(
      'version_conflict',
    );
    await tx((t) => catalog().removeCategory(free.id, 1, kit.actor, t));
    expect(await codeOf(tx((t) => catalog().removeCategory(free.id, 1, kit.actor, t)))).toBe(
      'category_not_found',
    );
  });
});

describe('items (T-3, BR-4)', () => {
  it('defaults stockable by kind', async () => {
    const material = await tx((t) => catalog().createItem(item({ code: 'D-1' }), kit.actor, t));
    expect(material).toMatchObject({ stockable: true, active: true, reorderLevel: null });
    const service = await tx((t) =>
      catalog().createItem(
        item({ code: 'D-2', itemKind: 'service', unitCode: 'ls', defaultTaxKind: 'services' }),
        kit.actor,
        t,
      ),
    );
    expect(service.stockable).toBe(false);
    const explicit = await tx((t) =>
      catalog().createItem(
        item({ code: 'D-3', stockable: false, reorderLevel: ' 12.5 ', active: false }),
        kit.actor,
        t,
      ),
    );
    expect(explicit).toMatchObject({ stockable: false, reorderLevel: '12.5000', active: false });
    expect(await eventCount(kit.db, 'master.item.changed')).toBeGreaterThan(0);
  });

  it('keeps a live default cost code and refuses an unknown or inactive one (BR-4)', async () => {
    const codes = await kit.masterData.costing.listCostCodes(kit.db);
    const root = codes.find((c) => c.code === '100');
    if (root === undefined) throw new Error('seed missing');
    const row = await tx((t) =>
      catalog().createItem(item({ code: 'DC-1', defaultCostCodeId: root.id }), kit.actor, t),
    );
    expect(row.defaultCostCodeId).toBe(root.id);
    expect(
      await codeOf(
        tx((t) =>
          catalog().createItem(item({ code: 'DC-2', defaultCostCodeId: uid(9005) }), kit.actor, t),
        ),
      ),
    ).toBe('default_cost_code_unknown');
    const dormant = await tx((t) =>
      kit.masterData.costing.createCostCode(
        { code: 'DC-OFF', name: 'Dormant', parentId: root.id, kind: 'material', active: false },
        kit.actor,
        t,
      ),
    );
    expect(
      await codeOf(
        tx((t) =>
          catalog().createItem(item({ code: 'DC-3', defaultCostCodeId: dormant.id }), kit.actor, t),
        ),
      ),
    ).toBe('default_cost_code_unknown');
  });

  it.each(['service', 'labour', 'equipment'])('rejects a stockable %s item', async (itemKind) => {
    expect(
      await codeOf(
        tx((t) =>
          catalog().createItem(
            item({ code: `S-${itemKind}`, itemKind, stockable: true }),
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('item_not_stockable');
  });

  it.each([
    ['unit', { unitCode: 'nope' }, 'unit_unknown'],
    ['category', { categoryId: uid(9004) }, 'category_unknown'],
    ['kind', { itemKind: 'gadget' }, 'invalid_item_kind'],
    ['tax kind', { defaultTaxKind: 'luxury' }, 'invalid_tax_kind'],
    ['reorder level', { reorderLevel: '-3' }, 'invalid_reorder_level'],
    ['name', { name: ' ' }, 'name_required'],
    ['code', { code: ' ' }, 'code_required'],
  ] as const)('rejects an unknown or invalid %s', async (_label, over, code) => {
    expect(
      await codeOf(tx((t) => catalog().createItem(item({ code: 'BAD-1', ...over }), kit.actor, t))),
    ).toBe(code);
  });

  it('keeps item codes unique and updates with version checks', async () => {
    const first = await tx((t) => catalog().createItem(item({ code: 'U-1' }), kit.actor, t));
    expect(await codeOf(tx((t) => catalog().createItem(item({ code: 'U-1' }), kit.actor, t)))).toBe(
      'code_taken',
    );
    const other = await tx((t) => catalog().createItem(item({ code: 'U-2' }), kit.actor, t));
    expect(
      await codeOf(
        tx((t) => catalog().updateItem(other.id, item({ code: 'U-1' }), 1, kit.actor, t)),
      ),
    ).toBe('code_taken');
    const updated = await tx((t) =>
      catalog().updateItem(first.id, item({ code: 'U-1', name: 'Renamed' }), 1, kit.actor, t),
    );
    expect(updated).toMatchObject({ name: 'Renamed', version: 2 });
    expect(
      await codeOf(
        tx((t) => catalog().updateItem(first.id, item({ code: 'U-1' }), 1, kit.actor, t)),
      ),
    ).toBe('version_conflict');
    expect(await codeOf(tx((t) => catalog().updateItem(uid(9005), item(), 1, kit.actor, t)))).toBe(
      'item_not_found',
    );
    expect(await catalog().getItem(kit.db, first.id)).toEqual(updated);
    expect((await catalog().findItem(kit.db, first.id))?.id).toBe(first.id);
    expect(await catalog().findItem(kit.db, uid(9005))).toBeUndefined();
    expect(await codeOf(catalog().getItem(kit.db, uid(9005)))).toBe('item_not_found');
  });

  it('searches, filters and sorts items', async () => {
    const category = await tx((t) =>
      catalog().createCategory({ code: 'SRCH', name: 'Search' }, kit.actor, t),
    );
    await tx((t) =>
      catalog().createItem(
        item({ code: 'SRCH-1', name: 'Steel bar 12mm', categoryId: category.id, unitCode: 'kg' }),
        kit.actor,
        t,
      ),
    );
    await tx((t) =>
      catalog().createItem(
        item({
          code: 'SRCH-2',
          name: 'Site labour',
          itemKind: 'labour',
          unitCode: 'day',
          defaultTaxKind: 'services',
          active: false,
        }),
        kit.actor,
        t,
      ),
    );
    const base = { sort: 'code', direction: 'asc', limit: 50, offset: 0 } as const;
    expect(
      (await catalog().searchItems(kit.db, { ...base, q: 'steel' })).items.map((i) => i.code),
    ).toEqual(['SRCH-1']);
    expect(
      (await catalog().searchItems(kit.db, { ...base, q: 'SRCH', categoryId: category.id })).total,
    ).toBe(1);
    expect(
      (await catalog().searchItems(kit.db, { ...base, q: 'SRCH', kind: 'labour' })).items.map(
        (i) => i.code,
      ),
    ).toEqual(['SRCH-2']);
    expect(
      (await catalog().searchItems(kit.db, { ...base, q: 'SRCH', active: false })).items.map(
        (i) => i.code,
      ),
    ).toEqual(['SRCH-2']);
    const byName = await catalog().searchItems(kit.db, {
      ...base,
      q: 'SRCH',
      sort: 'name',
      direction: 'desc',
      limit: 1,
      offset: 1,
    });
    expect(byName).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(
      (await catalog().searchItems(kit.db, { ...base, q: 'SRCH', sort: 'kind' })).items,
    ).toHaveLength(2);
  });

  it('soft-deletes an unreferenced item and refuses a referenced one (T-7, BR-8)', async () => {
    const free = await tx((t) => catalog().createItem(item({ code: 'DEL-1' }), kit.actor, t));
    await tx((t) => catalog().removeItem(free.id, 1, kit.actor, t));
    expect(await catalog().findItem(kit.db, free.id)).toBeUndefined();
    const used = await tx((t) => catalog().createItem(item({ code: 'DEL-2' }), kit.actor, t));
    kit.masterData.registerReferenceCheck('item', (_db, id) => Promise.resolve(id === used.id));
    expect(await codeOf(tx((t) => catalog().removeItem(used.id, 1, kit.actor, t)))).toBe(
      'item_referenced',
    );
    expect(await codeOf(tx((t) => catalog().removeItem(uid(9006), 1, kit.actor, t)))).toBe(
      'item_not_found',
    );
    const stale = await tx((t) => catalog().createItem(item({ code: 'DEL-3' }), kit.actor, t));
    expect(await codeOf(tx((t) => catalog().removeItem(stale.id, 4, kit.actor, t)))).toBe(
      'version_conflict',
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMasterKit, uid, type MasterKit } from '../test-support.js';
import type { PriceInput } from './costing.service.js';

let kit: MasterKit;
const costing = () => kit.masterData.costing;
const tx = <T>(fn: (db: MasterKit['db']) => Promise<T>) => kit.db.transaction(fn);

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

let vendorId: string;
let itemId: string;

beforeAll(async () => {
  kit = await createMasterKit();
  const vendor = await tx((t) =>
    kit.masterData.parties.create({ name: 'Price Vendor', roles: ['vendor'] }, kit.actor, t),
  );
  const item = await tx((t) =>
    kit.masterData.catalog.createItem(
      {
        code: 'PRICE-1',
        name: 'Cement',
        unitCode: 'bag',
        itemKind: 'material',
        defaultTaxKind: 'goods',
      },
      kit.actor,
      t,
    ),
  );
  vendorId = vendor.id;
  itemId = item.id;
}, 60_000);
afterAll(() => kit.close());

describe('cost codes (H-25, T-5, BR-6)', () => {
  it('seeds the six top-level codes', async () => {
    const codes = await costing().listCostCodes(kit.db);
    expect(codes.filter((c) => c.parentId === null).map((c) => [c.code, c.name])).toEqual([
      ['100', 'Materials'],
      ['200', 'Labour'],
      ['300', 'Subcontractors'],
      ['400', 'Equipment and tools'],
      ['500', 'Site expenses'],
      ['600', 'Other'],
    ]);
  });

  it('adds sub-codes, finds them and rejects cycles', async () => {
    const root = (await costing().listCostCodes(kit.db)).find((c) => c.code === '100');
    if (root === undefined) throw new Error('seed missing');
    const cement = await tx((t) =>
      costing().createCostCode(
        { code: '101', name: 'Cement', parentId: root.id, kind: 'material' },
        kit.actor,
        t,
      ),
    );
    expect(cement).toMatchObject({ parentId: root.id, active: true });
    expect(await costing().getCostCode(kit.db, cement.id)).toEqual(cement);
    expect(
      await codeOf(
        tx((t) =>
          costing().updateCostCode(
            root.id,
            { code: '100', name: 'Materials', parentId: cement.id, kind: 'material' },
            root.version,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('hierarchy_cycle');
    expect(
      await codeOf(
        tx((t) =>
          costing().updateCostCode(
            root.id,
            { code: '100', name: 'Materials', parentId: root.id, kind: 'material' },
            root.version,
            kit.actor,
            t,
          ),
        ),
      ),
    ).toBe('hierarchy_cycle');
    const renamed = await tx((t) =>
      costing().updateCostCode(
        cement.id,
        { code: '101', name: 'Cement and lime', parentId: root.id, kind: 'material' },
        1,
        kit.actor,
        t,
      ),
    );
    expect(renamed).toMatchObject({ name: 'Cement and lime', version: 2 });
  });

  it.each([
    ['duplicate code', { code: '100', name: 'X', kind: 'material' }, 'code_taken'],
    ['unknown kind', { code: '901', name: 'X', kind: 'magic' }, 'invalid_cost_code_kind'],
    [
      'unknown parent',
      { code: '902', name: 'X', kind: 'labour', parentId: uid(9101) },
      'parent_unknown',
    ],
    ['no name', { code: '903', name: ' ', kind: 'labour' }, 'name_required'],
  ])('rejects a cost code with %s', async (_label, input, code) => {
    expect(await codeOf(tx((t) => costing().createCostCode(input, kit.actor, t)))).toBe(code);
  });

  it('reports missing codes and stale versions', async () => {
    const input = { code: '777', name: 'Temp', kind: 'overhead' };
    expect(
      await codeOf(tx((t) => costing().updateCostCode(uid(9102), input, 1, kit.actor, t))),
    ).toBe('cost_code_not_found');
    expect(await codeOf(costing().getCostCode(kit.db, uid(9102)))).toBe('cost_code_not_found');
    const temp = await tx((t) => costing().createCostCode(input, kit.actor, t));
    expect(await codeOf(tx((t) => costing().updateCostCode(temp.id, input, 5, kit.actor, t)))).toBe(
      'version_conflict',
    );
    expect(await codeOf(tx((t) => costing().removeCostCode(temp.id, 5, kit.actor, t)))).toBe(
      'version_conflict',
    );
    expect(await codeOf(tx((t) => costing().removeCostCode(uid(9102), 1, kit.actor, t)))).toBe(
      'cost_code_not_found',
    );
    await tx((t) => costing().removeCostCode(temp.id, 1, kit.actor, t));
  });

  it('refuses to remove a code with sub-codes', async () => {
    const parent = await tx((t) =>
      costing().createCostCode({ code: '800', name: 'Parent', kind: 'overhead' }, kit.actor, t),
    );
    await tx((t) =>
      costing().createCostCode(
        { code: '801', name: 'Child', kind: 'overhead', parentId: parent.id },
        kit.actor,
        t,
      ),
    );
    expect(await codeOf(tx((t) => costing().removeCostCode(parent.id, 1, kit.actor, t)))).toBe(
      'cost_code_has_children',
    );
  });

  it('deactivates freely until the ledger reports posted costs and open budget lines', async () => {
    const code = await tx((t) =>
      costing().createCostCode({ code: '810', name: 'Guarded', kind: 'material' }, kit.actor, t),
    );
    const state = { postedCosts: false, openBudgetLines: false };
    kit.masterData.registerCostCodeUsage((_db, id) =>
      Promise.resolve(id === code.id ? state : { postedCosts: false, openBudgetLines: false }),
    );
    expect(() =>
      kit.masterData.registerCostCodeUsage(() => Promise.reject(new Error('x'))),
    ).toThrow();
    const input = (active: boolean) => ({ code: '810', name: 'Guarded', kind: 'material', active });

    state.postedCosts = true;
    state.openBudgetLines = true;
    expect(
      await codeOf(tx((t) => costing().updateCostCode(code.id, input(false), 1, kit.actor, t))),
    ).toBe('cost_code_in_use');
    // Staying active is never blocked.
    const stillActive = await tx((t) =>
      costing().updateCostCode(code.id, input(true), 1, kit.actor, t),
    );
    expect(stillActive.version).toBe(2);
    expect(await codeOf(tx((t) => costing().removeCostCode(code.id, 2, kit.actor, t)))).toBe(
      'cost_code_in_use',
    );

    state.openBudgetLines = false;
    const off = await tx((t) => costing().updateCostCode(code.id, input(false), 2, kit.actor, t));
    expect(off.active).toBe(false);
    // An already inactive code can be edited without asking the ledger again.
    state.openBudgetLines = true;
    const edited = await tx((t) =>
      costing().updateCostCode(code.id, input(false), 3, kit.actor, t),
    );
    expect(edited.version).toBe(4);
    state.postedCosts = false;
    state.openBudgetLines = false;
    await tx((t) => costing().removeCostCode(code.id, 4, kit.actor, t));
  });
});

describe('vendor prices', () => {
  const price = (over: Partial<PriceInput> = {}): PriceInput => ({
    vendorId,
    itemId,
    unitCode: 'bag',
    rate: '1250.5',
    validFrom: '2026-01-01',
    ...over,
  });

  it('creates, searches by date and vendor, updates and removes', async () => {
    const created = await tx((t) => costing().createPrice(price(), kit.actor, t));
    expect(created).toMatchObject({ rate: '1250.5000', validFrom: '2026-01-01', validTo: null });
    const later = await tx((t) =>
      costing().createPrice(
        price({ rate: '1300', validFrom: '2027-01-01', validTo: '2027-12-31' }),
        kit.actor,
        t,
      ),
    );
    const page = { limit: 50, offset: 0 };
    expect((await costing().searchPrices(kit.db, { ...page, vendorId, itemId })).total).toBe(2);
    expect(
      (await costing().searchPrices(kit.db, { ...page, onDate: '2026-06-01' })).items.map(
        (p) => p.id,
      ),
    ).toEqual([created.id]);
    expect(
      (await costing().searchPrices(kit.db, { ...page, onDate: '2027-06-01' })).items.map(
        (p) => p.id,
      ),
    ).toEqual([later.id, created.id]);
    expect((await costing().searchPrices(kit.db, { limit: 1, offset: 1 })).items).toHaveLength(1);
    const changed = await tx((t) =>
      costing().updatePrice(created.id, price({ rate: '1400' }), 1, kit.actor, t),
    );
    expect(changed).toMatchObject({ rate: '1400.0000', version: 2 });
    expect(
      await codeOf(tx((t) => costing().updatePrice(created.id, price(), 1, kit.actor, t))),
    ).toBe('version_conflict');
    expect(
      await codeOf(tx((t) => costing().updatePrice(uid(9201), price(), 1, kit.actor, t))),
    ).toBe('price_not_found');
    expect(await codeOf(tx((t) => costing().removePrice(created.id, 1, kit.actor, t)))).toBe(
      'version_conflict',
    );
    await tx((t) => costing().removePrice(created.id, 2, kit.actor, t));
    expect(await codeOf(tx((t) => costing().removePrice(created.id, 2, kit.actor, t)))).toBe(
      'price_not_found',
    );
  });

  it.each([
    ['vendor', { vendorId: uid(9202) }, 'vendor_unknown'],
    ['item', { itemId: uid(9203) }, 'item_unknown'],
    ['unit', { unitCode: 'nope' }, 'unit_unknown'],
    ['rate', { rate: '-5' }, 'invalid_rate'],
    ['range', { validTo: '2025-12-31' }, 'invalid_date_range'],
  ])('rejects an unknown or invalid %s', async (_label, over, code) => {
    expect(await codeOf(tx((t) => costing().createPrice(price(over), kit.actor, t)))).toBe(code);
  });
});

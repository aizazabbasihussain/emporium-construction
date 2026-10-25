import { createTestDb, type SqlDb } from '@emporium/db';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deleteCategory,
  deleteConversion,
  deleteItem,
  deleteUnit,
  findCategory,
  findCategoryByCode,
  findConversion,
  findConversionBetween,
  findItem,
  findItemByCode,
  findUnit,
  insertCategory,
  insertConversion,
  insertItem,
  insertUnit,
  isCategoryUsed,
  isUnitUsed,
  listCategories,
  listConversions,
  listUnits,
  searchItems,
  updateCategory,
  updateConversion,
  updateItem,
  updateUnit,
} from './catalog.repo.js';
import {
  deleteLocation,
  deleteRegistration,
  findLocation,
  findRegistration,
  getCompany,
  insertCompany,
  insertLocation,
  insertRegistration,
  listLocations,
  listRegistrations,
  listRegistrationsOfAuthority,
  listRegistrationsOfKind,
  updateCompany,
  updateLocation,
  updateRegistration,
} from './company.repo.js';
import { countOf, findRow, insertRow, likePattern, softDeleteRow, updateRow } from './crud.js';
import {
  deleteCostCode,
  deletePrice,
  findCostCode,
  findCostCodeByCode,
  findPrice,
  hasCostCodeChildren,
  insertCostCode,
  insertPrice,
  listCostCodes,
  searchPrices,
  updateCostCode,
  updatePrice,
} from './costing.repo.js';
import {
  deleteParty,
  findDuplicateCandidates,
  findParty,
  findPartyByCode,
  insertParty,
  listContacts,
  listContactsForParties,
  replaceContacts,
  searchParties,
  updateParty,
} from './parties.repo.js';

let db: SqlDb;
const id = (n: number) => `018f6a6a-3333-7000-8000-${String(n).padStart(12, '0')}`;
const by = id(900);
const at = new Date('2026-10-25T10:00:00Z');
const later = new Date('2026-10-26T10:00:00Z');

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

const party = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  code: `P-${n}`,
  name: `Party ${n}`,
  kind: { json: ['vendor'] },
  ...over,
});

describe('crud helpers', () => {
  it('inserts, finds, updates with a version, and soft-deletes', async () => {
    const row = await insertRow<{ id: string; version: number }>(
      db,
      'mst_locations',
      'id, name, region, city, version',
      { id: id(1), name: 'Yard', region: 'punjab', city: 'Lahore' },
      by,
      at,
    );
    expect(row.version).toBe(1);
    const key = { column: 'id', value: id(1) };
    expect(await findRow(db, 'mst_locations', 'id', key, true)).toEqual({ id: id(1) });
    expect(
      await updateRow(db, 'mst_locations', 'name, version', key, 9, { name: 'X' }, by, later),
    ).toBeUndefined();
    expect(
      await updateRow(db, 'mst_locations', 'name, version', key, 1, { name: 'Depot' }, by, later),
    ).toEqual({ name: 'Depot', version: 2 });
    expect(await softDeleteRow(db, 'mst_locations', key, 1, by, later)).toBe(false);
    expect(await softDeleteRow(db, 'mst_locations', key, 2, by, later)).toBe(true);
    expect(await findRow(db, 'mst_locations', 'id', key)).toBeUndefined();
  });

  it('escapes search text and counts', () => {
    expect(likePattern('50%_\\x')).toBe('%50\\%\\_\\\\x%');
    expect(countOf([{ total: '7' }])).toBe(7);
    expect(countOf([])).toBe(0);
  });
});

describe('company, registrations and locations', () => {
  it('keeps the company profile to one row', async () => {
    expect(await getCompany(db)).toBeUndefined();
    const row = await insertCompany(db, { id: id(10), name: 'Example Co' }, by, at);
    expect(row).toMatchObject({ name: 'Example Co', logo_file_id: null, version: 1 });
    await expect(insertCompany(db, { id: id(11), name: 'Second' }, by, at)).rejects.toThrow();
    expect(await updateCompany(db, id(10), 3, { name: 'X' }, by, later)).toBeUndefined();
    expect(await updateCompany(db, id(10), 1, { name: 'Renamed' }, by, later)).toMatchObject({
      name: 'Renamed',
      version: 2,
    });
    expect((await getCompany(db))?.name).toBe('Renamed');
  });

  it('stores registrations with date-only values and finds them by authority and type', async () => {
    const reg = (n: number, authority: string, type: string, from: string, to: string | null) =>
      insertRegistration(
        db,
        {
          id: id(n),
          authority,
          registration_type: type,
          number: `N-${n}`,
          valid_from: from,
          valid_to: to,
        },
        by,
        at,
      );
    const first = await reg(20, 'FBR', 'ntn', '2026-01-01', null);
    await reg(21, 'FBR', 'strn', '2026-02-01', '2026-12-31');
    await reg(22, 'PRA', 'pra', '2026-03-01', null);
    expect(first).toMatchObject({ valid_from: '2026-01-01', valid_to: null });
    expect((await listRegistrations(db)).map((r) => r.id)).toEqual([id(20), id(21), id(22)]);
    expect((await listRegistrationsOfKind(db, 'FBR', 'strn')).map((r) => r.id)).toEqual([id(21)]);
    expect((await listRegistrationsOfAuthority(db, 'FBR')).map((r) => r.registration_type)).toEqual(
      ['ntn', 'strn'],
    );
    expect((await findRegistration(db, id(21), true))?.valid_to).toBe('2026-12-31');
    expect(await updateRegistration(db, id(20), 1, { number: 'N-NEW' }, by, later)).toMatchObject({
      number: 'N-NEW',
      version: 2,
    });
    expect(await deleteRegistration(db, id(20), 1, by, later)).toBe(false);
    expect(await deleteRegistration(db, id(20), 2, by, later)).toBe(true);
    expect(await findRegistration(db, id(20))).toBeUndefined();
  });

  it('stores locations and filters by region', async () => {
    await insertLocation(
      db,
      { id: id(30), name: 'HQ', region: 'islamabad', city: 'Islamabad' },
      by,
      at,
    );
    await insertLocation(
      db,
      { id: id(31), name: 'Yard', region: 'punjab', city: 'Lahore' },
      by,
      at,
    );
    expect((await listLocations(db)).map((l) => l.id)).toEqual([id(30), id(31)]);
    expect((await listLocations(db, 'punjab')).map((l) => l.id)).toEqual([id(31)]);
    expect(await updateLocation(db, id(30), 1, { name: 'Head office' }, by, later)).toMatchObject({
      name: 'Head office',
    });
    expect((await findLocation(db, id(30)))?.version).toBe(2);
    expect(await deleteLocation(db, id(30), 2, by, later)).toBe(true);
    expect(await findLocation(db, id(30), true)).toBeUndefined();
  });
});

describe('parties', () => {
  it('inserts, updates, finds and soft-deletes a party', async () => {
    const row = await insertParty(
      db,
      party(40, { phone: '+923001234567', cnic: '3520212345671' }),
      by,
      at,
    );
    expect(row).toMatchObject({ code: 'P-40', kind: ['vendor'], status: 'active', version: 1 });
    expect((await findParty(db, id(40), true))?.cnic).toBe('3520212345671');
    expect((await findPartyByCode(db, 'P-40'))?.id).toBe(id(40));
    expect(await findPartyByCode(db, 'NOPE')).toBeUndefined();
    expect(await updateParty(db, id(40), 5, { name: 'X' }, by, later)).toBeUndefined();
    expect(
      await updateParty(db, id(40), 1, { kind: { json: ['client', 'vendor'] } }, by, later),
    ).toMatchObject({ kind: ['client', 'vendor'], version: 2 });
    await insertParty(db, party(41), by, at);
    expect(await deleteParty(db, id(41), 2, by, later)).toBe(false);
    expect(await deleteParty(db, id(41), 1, by, later)).toBe(true);
    expect(await findParty(db, id(41))).toBeUndefined();
  });

  it('enforces unique NTN and CNIC among active parties only', async () => {
    await insertParty(db, party(42, { ntn: '111', cnic: '3520200000001' }), by, at);
    await expect(insertParty(db, party(43, { ntn: '111' }), by, at)).rejects.toThrow();
    await expect(insertParty(db, party(44, { cnic: '3520200000001' }), by, at)).rejects.toThrow();
    await insertParty(db, party(45, { ntn: '111', status: 'inactive' }), by, at);
    await expect(insertParty(db, party(46, { cnic: '123' }), by, at)).rejects.toThrow();
    await expect(insertParty(db, party(47, { phone: '03001234567' }), by, at)).rejects.toThrow();
  });

  it('replaces and lists contacts, one party or many', async () => {
    await replaceContacts(
      db,
      id(40),
      [{ id: id(50), name: 'A', phone: null, email: null, role: 'boss' }],
      at,
    );
    await replaceContacts(
      db,
      id(40),
      [
        { id: id(51), name: 'B', phone: '+923001112223', email: 'b@example.test', role: null },
        { id: id(52), name: 'C', phone: null, email: null, role: null },
      ],
      at,
    );
    await replaceContacts(
      db,
      id(42),
      [{ id: id(53), name: 'D', phone: null, email: null, role: null }],
      at,
    );
    expect((await listContacts(db, id(40))).map((c) => c.name)).toEqual(['B', 'C']);
    const grouped = await listContactsForParties(db, [id(40), id(42), id(43)]);
    expect([...grouped.keys()].sort()).toEqual([id(40), id(42)]);
    expect(grouped.get(id(40))).toHaveLength(2);
    expect((await listContactsForParties(db, [])).size).toBe(0);
  });

  it('searches by text, role, status and sorts and pages', async () => {
    const run = (over = {}) =>
      searchParties(db, { sort: 'code', direction: 'asc', limit: 50, offset: 0, ...over });
    expect((await run({ q: 'Party 40' })).rows.map((p) => p.id)).toEqual([id(40)]);
    expect((await run({ q: '3520212345671' })).rows.map((p) => p.id)).toEqual([id(40)]);
    expect((await run({ q: '300 1234567' })).rows.map((p) => p.id)).toEqual([id(40)]);
    expect((await run({ q: '111' })).rows.length).toBeGreaterThanOrEqual(2);
    expect((await run({ q: 'part_' })).total).toBe(0);
    expect((await run({ role: 'client' })).rows.map((p) => p.id)).toEqual([id(40)]);
    expect((await run({ status: 'inactive' })).rows.map((p) => p.id)).toEqual([id(45)]);
    const paged = await run({ sort: 'name', direction: 'desc', limit: 1, offset: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBeGreaterThan(2);
    for (const sort of ['city', 'status'] as const)
      expect((await run({ sort })).rows.length).toBeGreaterThan(0);
  });

  it('finds duplicate candidates by name plus phone, NTN or CNIC', async () => {
    const find = (over = {}) =>
      findDuplicateCandidates(db, {
        nameKey: 'nobody',
        phone: null,
        ntn: null,
        cnic: null,
        ...over,
      });
    expect(await find()).toEqual([]);
    expect((await find({ nameKey: 'party 40', phone: '+923001234567' })).map((p) => p.id)).toEqual([
      id(40),
    ]);
    expect(await find({ nameKey: 'other', phone: '+923001234567' })).toEqual([]);
    expect((await find({ ntn: '111' })).length).toBe(2);
    expect((await find({ cnic: '3520212345671' })).map((p) => p.id)).toEqual([id(40)]);
  });
});

describe('units and conversions', () => {
  it('manages units and knows when one is used', async () => {
    expect((await listUnits(db)).length).toBeGreaterThanOrEqual(13);
    await insertUnit(db, { code: 'pcs', name: 'Pieces', kind: 'count' }, by, at);
    expect((await findUnit(db, 'pcs', true))?.name).toBe('Pieces');
    expect(await updateUnit(db, 'pcs', 1, { name: 'Piece' }, by, later)).toMatchObject({
      version: 2,
    });
    expect(await updateUnit(db, 'pcs', 1, { name: 'X' }, by, later)).toBeUndefined();
    expect(await isUnitUsed(db, 'pcs')).toBe(false);
    expect(await isUnitUsed(db, 'bag')).toBe(false);
    await insertItem(
      db,
      {
        id: id(60),
        code: 'I-60',
        name: 'Item',
        unit_code: 'bag',
        item_kind: 'material',
        stockable: true,
        default_tax_kind: 'goods',
      },
      by,
      at,
    );
    expect(await isUnitUsed(db, 'bag')).toBe(true);
    expect(await deleteUnit(db, 'pcs', 1, by, later)).toBe(false);
    expect(await deleteUnit(db, 'pcs', 2, by, later)).toBe(true);
    expect(await findUnit(db, 'pcs')).toBeUndefined();
  });

  it('keeps one directed pair per two units', async () => {
    const pair = await insertConversion(
      db,
      { id: id(70), from_unit: 'ton', to_unit: 'kg', factor: '1000' },
      by,
      at,
    );
    expect(pair.factor).toBe('1000.000000');
    await expect(
      insertConversion(db, { id: id(71), from_unit: 'ton', to_unit: 'kg', factor: '2' }, by, at),
    ).rejects.toThrow();
    await expect(
      insertConversion(db, { id: id(72), from_unit: 'kg', to_unit: 'kg', factor: '1' }, by, at),
    ).rejects.toThrow();
    expect((await findConversionBetween(db, 'kg', 'ton')).map((c) => c.id)).toEqual([id(70)]);
    expect(await findConversionBetween(db, 'kg', 'm')).toEqual([]);
    expect((await listConversions(db)).map((c) => c.id)).toEqual([id(70)]);
    expect((await findConversion(db, id(70)))?.from_unit).toBe('ton');
    expect(await findConversion(db, id(79))).toBeUndefined();
    expect(await isUnitUsed(db, 'ton')).toBe(true);
    expect(await updateConversion(db, id(70), 9, '2', by, later)).toBeUndefined();
    expect(await updateConversion(db, id(70), 1, '907.185', by, later)).toMatchObject({
      factor: '907.185000',
      version: 2,
    });
    expect(await deleteConversion(db, id(70), 1)).toBe(false);
    expect(await deleteConversion(db, id(70), 2)).toBe(true);
  });
});

describe('item categories and items', () => {
  it('manages a category tree', async () => {
    await insertCategory(db, { id: id(80), code: 'CAT', name: 'Cat' }, by, at);
    await insertCategory(db, { id: id(81), code: 'SUB', name: 'Sub', parent_id: id(80) }, by, at);
    expect((await listCategories(db)).map((c) => c.code)).toEqual(['CAT', 'SUB']);
    expect((await findCategory(db, id(81), true))?.parent_id).toBe(id(80));
    expect((await findCategoryByCode(db, 'CAT'))?.id).toBe(id(80));
    expect(await findCategoryByCode(db, 'NOPE')).toBeUndefined();
    expect(await updateCategory(db, id(81), 1, { name: 'Sub 2' }, by, later)).toMatchObject({
      name: 'Sub 2',
    });
    expect(await isCategoryUsed(db, id(80))).toBe(true);
    expect(await isCategoryUsed(db, id(81))).toBe(false);
    expect(await deleteCategory(db, id(81), 1, by, later)).toBe(false);
    expect(await deleteCategory(db, id(81), 2, by, later)).toBe(true);
    expect(await isCategoryUsed(db, id(80))).toBe(false);
  });

  it('stores items, enforces the stockable rule in the database and searches', async () => {
    const item = (n: number, over: Record<string, unknown> = {}) => ({
      id: id(n),
      code: `I-${n}`,
      name: `Item ${n}`,
      unit_code: 'kg',
      item_kind: 'material',
      stockable: true,
      default_tax_kind: 'goods',
      ...over,
    });
    await expect(
      insertItem(db, item(61, { item_kind: 'service', stockable: true }), by, at),
    ).rejects.toThrow();
    await insertItem(db, item(62, { category_id: id(80), reorder_level: '12.5' }), by, at);
    await insertItem(
      db,
      item(63, { item_kind: 'labour', stockable: false, active: false }),
      by,
      at,
    );
    expect((await findItem(db, id(62), true))?.reorder_level).toBe('12.5000');
    expect((await findItemByCode(db, 'I-62'))?.id).toBe(id(62));
    expect(await findItemByCode(db, 'NOPE')).toBeUndefined();
    expect(await updateItem(db, id(62), 4, { name: 'X' }, by, later)).toBeUndefined();
    expect(await updateItem(db, id(62), 1, { name: 'Renamed' }, by, later)).toMatchObject({
      version: 2,
    });
    const run = (over = {}) =>
      searchItems(db, { sort: 'code', direction: 'asc', limit: 50, offset: 0, ...over });
    expect((await run({ q: 'Renamed' })).rows.map((i) => i.id)).toEqual([id(62)]);
    expect((await run({ categoryId: id(80) })).total).toBe(1);
    expect((await run({ kind: 'labour' })).rows.map((i) => i.id)).toEqual([id(63)]);
    expect((await run({ active: false })).rows.map((i) => i.id)).toEqual([id(63)]);
    expect((await run({ sort: 'name', direction: 'desc', limit: 1 })).rows).toHaveLength(1);
    expect((await run({ sort: 'kind' })).rows.length).toBeGreaterThan(1);
    expect(await deleteItem(db, id(63), 2, by, later)).toBe(false);
    expect(await deleteItem(db, id(63), 1, by, later)).toBe(true);
  });
});

describe('cost codes and vendor prices', () => {
  it('manages a cost code tree starting from the seeded codes', async () => {
    expect((await listCostCodes(db)).map((c) => c.code)).toEqual([
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
    ]);
    const root = await findCostCodeByCode(db, '100');
    expect(await findCostCodeByCode(db, 'NOPE')).toBeUndefined();
    await insertCostCode(
      db,
      { id: id(90), code: '101', name: 'Cement', parent_id: root?.id, kind: 'material' },
      by,
      at,
    );
    expect(await hasCostCodeChildren(db, root?.id as string)).toBe(true);
    expect(await hasCostCodeChildren(db, id(90))).toBe(false);
    expect((await findCostCode(db, id(90), true))?.parent_id).toBe(root?.id);
    expect(await updateCostCode(db, id(90), 1, { active: false }, by, later)).toMatchObject({
      active: false,
      version: 2,
    });
    expect(await updateCostCode(db, id(90), 1, { active: true }, by, later)).toBeUndefined();
    expect(await deleteCostCode(db, id(90), 1, by, later)).toBe(false);
    expect(await deleteCostCode(db, id(90), 2, by, later)).toBe(true);
    expect(await hasCostCodeChildren(db, root?.id as string)).toBe(false);
  });

  it('stores vendor prices and searches them by vendor, item and date', async () => {
    const price = (n: number, from: string, to: string | null, vendor = id(40)) => ({
      id: id(n),
      vendor_id: vendor,
      item_id: id(62),
      unit_code: 'kg',
      rate: '10.5',
      valid_from: from,
      valid_to: to,
    });
    const first = await insertPrice(db, price(100, '2026-01-01', '2026-06-30'), by, at);
    expect(first).toMatchObject({
      rate: '10.5000',
      valid_from: '2026-01-01',
      valid_to: '2026-06-30',
    });
    await insertPrice(db, price(101, '2026-07-01', null, id(42)), by, at);
    await expect(
      insertPrice(db, { ...price(102, '2026-02-01', '2026-01-01') }, by, at),
    ).rejects.toThrow();
    const run = (over = {}) => searchPrices(db, { limit: 50, offset: 0, ...over });
    expect((await run()).total).toBe(2);
    expect((await run({ vendorId: id(42) })).rows.map((p) => p.id)).toEqual([id(101)]);
    expect((await run({ itemId: id(62) })).total).toBe(2);
    expect((await run({ onDate: '2026-03-01' })).rows.map((p) => p.id)).toEqual([id(100)]);
    expect((await run({ onDate: '2030-01-01' })).rows.map((p) => p.id)).toEqual([id(101)]);
    expect((await run({ limit: 1, offset: 1 })).rows).toHaveLength(1);
    expect((await findPrice(db, id(100), true))?.rate).toBe('10.5000');
    expect(await updatePrice(db, id(100), 3, { rate: '1' }, by, later)).toBeUndefined();
    expect(await updatePrice(db, id(100), 1, { rate: '11' }, by, later)).toMatchObject({
      rate: '11.0000',
      version: 2,
    });
    expect(await deletePrice(db, id(100), 1, by, later)).toBe(false);
    expect(await deletePrice(db, id(100), 2, by, later)).toBe(true);
  });
});

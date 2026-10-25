import { ConflictError, ValidationError } from '@emporium/domain';
import type { Clock } from '@emporium/domain/kernel';
import {
  assertConversionPair,
  assertDecimal,
  assertNoCycle,
  assertStockableRule,
  convertQuantity,
  defaultStockable,
} from '@emporium/domain/masterdata';
import {
  itemKinds,
  taxKinds,
  unitKinds,
  type DefaultTaxKind,
  type ItemKind,
  type UnitKind,
} from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertFound,
  assertNotReferenced,
  assertUnused,
  assertUpdated,
} from '../policy/masterdata.policy.js';
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
  type CategoryRow,
  type ConversionRow,
  type ItemRow,
  type ItemSearch,
  type UnitRow,
} from '../repo/catalog.repo.js';
import type {
  Actor,
  CategoryDto,
  ConversionDto,
  Db,
  ItemDto,
  PageResult,
  UnitDto,
} from '../types.js';
import type { References } from './references.service.js';
import { createRecorder, pageOf, requiredText, textOrNull } from './support.js';

const oneOf = <T extends string>(allowed: readonly T[], value: string, code: string): T => {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(code, `${value} is not one of: ${allowed.join(', ')}`);
  }
  return value as T;
};

const unitDto = (row: UnitRow): UnitDto => ({
  code: row.code,
  name: row.name,
  kind: row.kind as UnitKind,
  version: row.version,
});

const conversionDto = (row: ConversionRow): ConversionDto => ({
  id: row.id,
  fromUnit: row.from_unit,
  toUnit: row.to_unit,
  factor: row.factor,
  version: row.version,
});

const categoryDto = (row: CategoryRow): CategoryDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  parentId: row.parent_id,
  version: row.version,
});

export const toItemDto = (row: ItemRow): ItemDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  categoryId: row.category_id,
  unitCode: row.unit_code,
  itemKind: row.item_kind as ItemKind,
  stockable: row.stockable,
  defaultTaxKind: row.default_tax_kind as DefaultTaxKind,
  reorderLevel: row.reorder_level,
  active: row.active,
  version: row.version,
});

export interface UnitInput {
  code: string;
  name: string;
  kind: string;
}

export interface CategoryInput {
  code: string;
  name: string;
  parentId?: string | null | undefined;
}

export interface ItemInput {
  code: string;
  name: string;
  categoryId?: string | null | undefined;
  unitCode: string;
  itemKind: string;
  stockable?: boolean | undefined;
  defaultTaxKind: string;
  reorderLevel?: string | null | undefined;
  active?: boolean | undefined;
}

export type ItemSearchQuery = ItemSearch;

export interface CatalogService {
  listUnits(db: Db): Promise<UnitDto[]>;
  getUnit(db: Db, code: string): Promise<UnitDto>;
  createUnit(input: UnitInput, actor: Actor, tx: Db): Promise<UnitDto>;
  updateUnit(
    code: string,
    input: { name: string; kind: string },
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<UnitDto>;
  removeUnit(code: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;

  listConversions(db: Db): Promise<ConversionDto[]>;
  createConversion(
    input: { fromUnit: string; toUnit: string; factor: string },
    actor: Actor,
    tx: Db,
  ): Promise<ConversionDto>;
  updateConversion(
    id: string,
    factor: string,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ConversionDto>;
  removeConversion(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
  /** BR-5: direct pair or its inverse, four decimals half-up. */
  convert(db: Db, quantity: string, fromUnit: string, toUnit: string): Promise<string>;

  listCategories(db: Db): Promise<CategoryDto[]>;
  getCategory(db: Db, id: string): Promise<CategoryDto>;
  createCategory(input: CategoryInput, actor: Actor, tx: Db): Promise<CategoryDto>;
  updateCategory(
    id: string,
    input: CategoryInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<CategoryDto>;
  removeCategory(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;

  getItem(db: Db, id: string): Promise<ItemDto>;
  findItem(db: Db, id: string): Promise<ItemDto | undefined>;
  searchItems(db: Db, query: ItemSearchQuery): Promise<PageResult<ItemDto>>;
  createItem(input: ItemInput, actor: Actor, tx: Db): Promise<ItemDto>;
  updateItem(
    id: string,
    input: ItemInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<ItemDto>;
  removeItem(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
}

export function createCatalogService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  references: References;
}): CatalogService {
  const { platform, clock, newId, references } = deps;
  const record = createRecorder(platform);

  const requireUnit = async (db: Db, code: string): Promise<UnitRow> => {
    const row = await findUnit(db, code);
    if (row === undefined) throw new ValidationError('unit_unknown', `Unit ${code} does not exist`);
    return row;
  };

  async function categoryParents(db: Db): Promise<Map<string, string | null>> {
    return new Map((await listCategories(db)).map((row) => [row.id, row.parent_id]));
  }

  async function checkCategory(
    tx: Db,
    input: CategoryInput,
    selfId: string,
  ): Promise<{ code: string; name: string; parentId: string | null }> {
    const code = requiredText(input.code, 'code');
    const taken = await findCategoryByCode(tx, code);
    if (taken !== undefined && taken.id !== selfId) {
      throw new ConflictError('code_taken', `Category code ${code} is already used`);
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if ((await findCategory(tx, parentId)) === undefined) {
        throw new ValidationError('parent_unknown', 'The parent category does not exist');
      }
      assertNoCycle(selfId, parentId, await categoryParents(tx));
    }
    return { code, name: requiredText(input.name, 'name'), parentId };
  }

  async function itemValues(tx: Db, input: ItemInput, selfId: string) {
    const code = requiredText(input.code, 'code');
    const taken = await findItemByCode(tx, code);
    if (taken !== undefined && taken.id !== selfId) {
      throw new ConflictError('code_taken', `Item code ${code} is already used`);
    }
    const itemKind = oneOf(itemKinds, input.itemKind, 'invalid_item_kind');
    const stockable = input.stockable ?? defaultStockable(itemKind);
    assertStockableRule(itemKind, stockable);
    await requireUnit(tx, input.unitCode);
    const categoryId = input.categoryId ?? null;
    if (categoryId !== null && (await findCategory(tx, categoryId)) === undefined) {
      throw new ValidationError('category_unknown', 'The item category does not exist');
    }
    const reorder = textOrNull(input.reorderLevel);
    return {
      code,
      name: requiredText(input.name, 'name'),
      category_id: categoryId,
      unit_code: input.unitCode,
      item_kind: itemKind,
      stockable,
      default_tax_kind: oneOf(taxKinds, input.defaultTaxKind, 'invalid_tax_kind'),
      reorder_level: reorder === null ? null : assertDecimal(reorder, 4, 'invalid_reorder_level'),
      active: input.active ?? true,
    };
  }

  const itemSummary = (row: ItemRow) => ({
    code: row.code,
    name: row.name,
    kind: row.item_kind,
    unit: row.unit_code,
    active: row.active,
  });

  const itemEvent = (row: ItemRow, change: string) => ({
    type: 'master.item.changed',
    payload: { itemId: row.id, code: row.code, change },
  });

  return {
    listUnits: async (db) => (await listUnits(db)).map(unitDto),

    async getUnit(db, code) {
      return unitDto(assertFound(await findUnit(db, code), 'unit'));
    },

    async createUnit(input, actor, tx) {
      const code = requiredText(input.code, 'code').toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,15}$/.test(code)) {
        throw new ValidationError('invalid_unit_code', 'Use lowercase letters, digits and _');
      }
      if ((await findUnit(tx, code)) !== undefined) {
        throw new ConflictError('code_taken', `Unit ${code} already exists`);
      }
      const row = await insertUnit(
        tx,
        {
          code,
          name: requiredText(input.name, 'name'),
          kind: oneOf(unitKinds, input.kind, 'invalid_unit_kind'),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'master.unit.create',
        entityType: 'master_unit',
        entityId: row.code,
        after: unitDto(row),
      });
      return unitDto(row);
    },

    async updateUnit(code, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findUnit(tx, code, true), 'unit');
      const row = assertUpdated(
        await updateUnit(
          tx,
          code,
          expectedVersion,
          {
            name: requiredText(input.name, 'name'),
            kind: oneOf(unitKinds, input.kind, 'invalid_unit_kind'),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'master.unit.update',
        entityType: 'master_unit',
        entityId: code,
        before: unitDto(existing),
        after: unitDto(row),
      });
      return unitDto(row);
    },

    async removeUnit(code, expectedVersion, actor, tx) {
      const existing = assertFound(await findUnit(tx, code, true), 'unit');
      assertUnused(
        await isUnitUsed(tx, code),
        'unit_in_use',
        'Items, prices or conversions use this unit',
      );
      assertApplied(await deleteUnit(tx, code, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.unit.delete',
        entityType: 'master_unit',
        entityId: code,
        before: unitDto(existing),
      });
    },

    listConversions: async (db) => (await listConversions(db)).map(conversionDto),

    async createConversion(input, actor, tx) {
      assertConversionPair(input);
      await requireUnit(tx, input.fromUnit);
      await requireUnit(tx, input.toUnit);
      if ((await findConversionBetween(tx, input.fromUnit, input.toUnit)).length > 0) {
        throw new ConflictError('conversion_exists', 'These units already have a conversion');
      }
      const row = await insertConversion(
        tx,
        { id: newId(), from_unit: input.fromUnit, to_unit: input.toUnit, factor: input.factor },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'master.conversion.create',
        entityType: 'master_unit_conversion',
        entityId: row.id,
        after: conversionDto(row),
      });
      return conversionDto(row);
    },

    async updateConversion(id, factor, expectedVersion, actor, tx) {
      const existing = assertFound(await findConversion(tx, id), 'conversion');
      assertConversionPair({ fromUnit: existing.from_unit, toUnit: existing.to_unit, factor });
      const row = assertUpdated(
        await updateConversion(tx, id, expectedVersion, factor, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'master.conversion.update',
        entityType: 'master_unit_conversion',
        entityId: id,
        before: conversionDto(existing),
        after: conversionDto(row),
      });
      return conversionDto(row);
    },

    async removeConversion(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findConversion(tx, id), 'conversion');
      assertApplied(await deleteConversion(tx, id, expectedVersion));
      await record(tx, actor, {
        action: 'master.conversion.delete',
        entityType: 'master_unit_conversion',
        entityId: id,
        before: conversionDto(existing),
      });
    },

    async convert(db, quantity, fromUnit, toUnit) {
      await requireUnit(db, fromUnit);
      await requireUnit(db, toUnit);
      const pairs = (await findConversionBetween(db, fromUnit, toUnit)).map((row) => ({
        fromUnit: row.from_unit,
        toUnit: row.to_unit,
        factor: row.factor,
      }));
      return convertQuantity(quantity, fromUnit, toUnit, pairs);
    },

    listCategories: async (db) => (await listCategories(db)).map(categoryDto),

    async getCategory(db, id) {
      return categoryDto(assertFound(await findCategory(db, id), 'category'));
    },

    async createCategory(input, actor, tx) {
      const id = newId();
      const values = await checkCategory(tx, input, id);
      const row = await insertCategory(
        tx,
        { id, code: values.code, name: values.name, parent_id: values.parentId },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'master.category.create',
        entityType: 'master_item_category',
        entityId: id,
        after: categoryDto(row),
      });
      return categoryDto(row);
    },

    async updateCategory(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findCategory(tx, id, true), 'category');
      const values = await checkCategory(tx, input, id);
      const row = assertUpdated(
        await updateCategory(
          tx,
          id,
          expectedVersion,
          { code: values.code, name: values.name, parent_id: values.parentId },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'master.category.update',
        entityType: 'master_item_category',
        entityId: id,
        before: categoryDto(existing),
        after: categoryDto(row),
      });
      return categoryDto(row);
    },

    async removeCategory(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findCategory(tx, id, true), 'category');
      assertUnused(
        await isCategoryUsed(tx, id),
        'category_in_use',
        'Items or sub-categories use this category',
      );
      assertApplied(await deleteCategory(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.category.delete',
        entityType: 'master_item_category',
        entityId: id,
        before: categoryDto(existing),
      });
    },

    async getItem(db, id) {
      return toItemDto(assertFound(await findItem(db, id), 'item'));
    },

    async findItem(db, id) {
      const row = await findItem(db, id);
      return row === undefined ? undefined : toItemDto(row);
    },

    async searchItems(db, query) {
      const { rows, total } = await searchItems(db, query);
      return pageOf(rows.map(toItemDto), total, query);
    },

    async createItem(input, actor, tx) {
      const id = newId();
      const values = await itemValues(tx, input, id);
      const row = await insertItem(tx, { id, ...values }, actor.userId, clock.now());
      await record(tx, actor, {
        action: 'master.item.create',
        entityType: 'master_item',
        entityId: id,
        after: itemSummary(row),
        event: itemEvent(row, 'created'),
      });
      return toItemDto(row);
    },

    async updateItem(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findItem(tx, id, true), 'item');
      const values = await itemValues(tx, input, id);
      const row = assertUpdated(
        await updateItem(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'master.item.update',
        entityType: 'master_item',
        entityId: id,
        before: itemSummary(existing),
        after: itemSummary(row),
        event: itemEvent(row, 'updated'),
      });
      return toItemDto(row);
    },

    async removeItem(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findItem(tx, id, true), 'item');
      assertNotReferenced(await references.isReferenced(tx, 'item', id), 'item');
      assertApplied(await deleteItem(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.item.delete',
        entityType: 'master_item',
        entityId: id,
        before: itemSummary(existing),
        event: itemEvent(existing, 'deleted'),
      });
    },
  };
}

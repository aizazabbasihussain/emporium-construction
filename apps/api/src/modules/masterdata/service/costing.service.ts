import { ConflictError, ValidationError } from '@emporium/domain';
import type { Clock } from '@emporium/domain/kernel';
import { assertDecimal, assertNoCycle, assertValidRange } from '@emporium/domain/masterdata';
import { costCodeKinds, type CostCodeKind } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import {
  assertApplied,
  assertCostCodeMayDeactivate,
  assertFound,
  assertUnused,
  assertUpdated,
} from '../policy/masterdata.policy.js';
import { findParty } from '../repo/parties.repo.js';
import { findItem, findUnit } from '../repo/catalog.repo.js';
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
  type CostCodeRow,
  type PriceRow,
  type PriceSearch,
} from '../repo/costing.repo.js';
import type { Actor, CostCodeDto, Db, PageResult, VendorPriceDto } from '../types.js';
import type { References } from './references.service.js';
import { createRecorder, pageOf, requiredText } from './support.js';

const costCodeDto = (row: CostCodeRow): CostCodeDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  parentId: row.parent_id,
  kind: row.kind as CostCodeKind,
  active: row.active,
  version: row.version,
});

const priceDto = (row: PriceRow): VendorPriceDto => ({
  id: row.id,
  vendorId: row.vendor_id,
  itemId: row.item_id,
  unitCode: row.unit_code,
  rate: row.rate,
  validFrom: row.valid_from,
  validTo: row.valid_to,
  version: row.version,
});

export interface CostCodeInput {
  code: string;
  name: string;
  parentId?: string | null | undefined;
  kind: string;
  active?: boolean | undefined;
}

export interface PriceInput {
  vendorId: string;
  itemId: string;
  unitCode: string;
  rate: string;
  validFrom: string;
  validTo?: string | null | undefined;
}

export interface CostingService {
  listCostCodes(db: Db): Promise<CostCodeDto[]>;
  getCostCode(db: Db, id: string): Promise<CostCodeDto>;
  createCostCode(input: CostCodeInput, actor: Actor, tx: Db): Promise<CostCodeDto>;
  updateCostCode(
    id: string,
    input: CostCodeInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<CostCodeDto>;
  removeCostCode(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;

  searchPrices(db: Db, query: PriceSearch): Promise<PageResult<VendorPriceDto>>;
  createPrice(input: PriceInput, actor: Actor, tx: Db): Promise<VendorPriceDto>;
  updatePrice(
    id: string,
    input: PriceInput,
    expectedVersion: number,
    actor: Actor,
    tx: Db,
  ): Promise<VendorPriceDto>;
  removePrice(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void>;
}

export function createCostingService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  references: References;
}): CostingService {
  const { platform, clock, newId, references } = deps;
  const record = createRecorder(platform);

  async function costCodeValues(tx: Db, input: CostCodeInput, selfId: string) {
    const code = requiredText(input.code, 'code');
    const taken = await findCostCodeByCode(tx, code);
    if (taken !== undefined && taken.id !== selfId) {
      throw new ConflictError('code_taken', `Cost code ${code} is already used`);
    }
    if (!(costCodeKinds as readonly string[]).includes(input.kind)) {
      throw new ValidationError('invalid_cost_code_kind', `${input.kind} is not a cost code kind`);
    }
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if ((await findCostCode(tx, parentId)) === undefined) {
        throw new ValidationError('parent_unknown', 'The parent cost code does not exist');
      }
      const parents = new Map((await listCostCodes(tx)).map((row) => [row.id, row.parent_id]));
      assertNoCycle(selfId, parentId, parents);
    }
    return {
      code,
      name: requiredText(input.name, 'name'),
      parent_id: parentId,
      kind: input.kind,
      active: input.active ?? true,
    };
  }

  async function priceValues(tx: Db, input: PriceInput) {
    if ((await findParty(tx, input.vendorId)) === undefined) {
      throw new ValidationError('vendor_unknown', 'The vendor does not exist');
    }
    if ((await findItem(tx, input.itemId)) === undefined) {
      throw new ValidationError('item_unknown', 'The item does not exist');
    }
    if ((await findUnit(tx, input.unitCode)) === undefined) {
      throw new ValidationError('unit_unknown', `Unit ${input.unitCode} does not exist`);
    }
    const validTo = input.validTo ?? null;
    assertValidRange({ validFrom: input.validFrom, validTo });
    return {
      vendor_id: input.vendorId,
      item_id: input.itemId,
      unit_code: input.unitCode,
      rate: assertDecimal(input.rate, 4, 'invalid_rate'),
      valid_from: input.validFrom,
      valid_to: validTo,
    };
  }

  return {
    listCostCodes: async (db) => (await listCostCodes(db)).map(costCodeDto),

    async getCostCode(db, id) {
      return costCodeDto(assertFound(await findCostCode(db, id), 'cost_code'));
    },

    async createCostCode(input, actor, tx) {
      const id = newId();
      const values = await costCodeValues(tx, input, id);
      const row = await insertCostCode(tx, { id, ...values }, actor.userId, clock.now());
      await record(tx, actor, {
        action: 'master.costcode.create',
        entityType: 'master_cost_code',
        entityId: id,
        after: costCodeDto(row),
      });
      return costCodeDto(row);
    },

    async updateCostCode(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findCostCode(tx, id, true), 'cost_code');
      const values = await costCodeValues(tx, input, id);
      // BR-6: switching a code off is checked against the cost ledger.
      if (existing.active && !values.active) {
        assertCostCodeMayDeactivate(await references.costCodeUsage(tx, id));
      }
      const row = assertUpdated(
        await updateCostCode(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'master.costcode.update',
        entityType: 'master_cost_code',
        entityId: id,
        before: costCodeDto(existing),
        after: costCodeDto(row),
      });
      return costCodeDto(row);
    },

    async removeCostCode(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findCostCode(tx, id, true), 'cost_code');
      assertUnused(
        await hasCostCodeChildren(tx, id),
        'cost_code_has_children',
        'Remove or move the sub-codes first',
      );
      const usage = await references.costCodeUsage(tx, id);
      assertUnused(
        usage.postedCosts || usage.openBudgetLines,
        'cost_code_in_use',
        'Costs or budget lines use this cost code; set it inactive instead',
      );
      assertApplied(await deleteCostCode(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.costcode.delete',
        entityType: 'master_cost_code',
        entityId: id,
        before: costCodeDto(existing),
      });
    },

    async searchPrices(db, query) {
      const { rows, total } = await searchPrices(db, query);
      return pageOf(rows.map(priceDto), total, query);
    },

    async createPrice(input, actor, tx) {
      const id = newId();
      const values = await priceValues(tx, input);
      const row = await insertPrice(tx, { id, ...values }, actor.userId, clock.now());
      await record(tx, actor, {
        action: 'master.price.create',
        entityType: 'master_vendor_price',
        entityId: id,
        after: priceDto(row),
      });
      return priceDto(row);
    },

    async updatePrice(id, input, expectedVersion, actor, tx) {
      const existing = assertFound(await findPrice(tx, id, true), 'price');
      const values = await priceValues(tx, input);
      const row = assertUpdated(
        await updatePrice(tx, id, expectedVersion, values, actor.userId, clock.now()),
      );
      await record(tx, actor, {
        action: 'master.price.update',
        entityType: 'master_vendor_price',
        entityId: id,
        before: priceDto(existing),
        after: priceDto(row),
      });
      return priceDto(row);
    },

    async removePrice(id, expectedVersion, actor, tx) {
      const existing = assertFound(await findPrice(tx, id, true), 'price');
      assertApplied(await deletePrice(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'master.price.delete',
        entityType: 'master_vendor_price',
        entityId: id,
        before: priceDto(existing),
      });
    },
  };
}

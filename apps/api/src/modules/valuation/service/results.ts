import type { MovementType, ValuationMethod } from '@emporium/shared';
import { listConsumptions, type MovementRow } from '../repo/valuation.repo.js';
import type { Db, MovementResult, PartDto } from '../types.js';

/** The result of a movement as inventory sees it: totals plus the parts that make up an issue. */
export async function resultOf(db: Db, row: MovementRow): Promise<MovementResult> {
  const parts: PartDto[] = (await listConsumptions(db, row.id)).map((part) => ({
    layerId: part.layer_id,
    quantity: part.quantity,
    unitCost: part.unit_cost,
    value: part.value,
  }));
  return {
    movementId: row.id,
    seq: Number(row.seq),
    type: row.type as MovementType,
    storeId: row.store_id,
    itemId: row.item_id,
    quantity: row.quantity,
    value: row.value,
    unitCost: row.unit_cost,
    method: row.method_used as ValuationMethod,
    parts,
  };
}

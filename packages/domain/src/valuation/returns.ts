import { RuleViolationError } from '../errors.js';
import { D, fmtQty, money, ZERO, type Dec } from './amounts.js';

/** What an issue consumed and how much of it has already come back (BR-9). */
export interface ReturnablePart {
  consumptionId: string;
  layerReceivedSeq: number | null;
  quantity: Dec;
  unitCost: Dec;
  value: Dec;
  returnedQty: Dec;
  returnedValue: Dec;
}

export interface ReturnAllocation {
  consumptionId: string;
  layerReceivedSeq: number | null;
  quantity: Dec;
  unitCost: Dec;
  value: Dec;
}

/**
 * BR-9: a return restores quantity at the cost the issue took it at. The last part consumed comes
 * back first. The final piece of a part restores exactly what is left of the part's value, so a
 * full return restores the full issue value to the paisa.
 */
export function planReturn(parts: readonly ReturnablePart[], quantity: Dec): ReturnAllocation[] {
  const available = parts.reduce(
    (sum, part) => sum.plus(part.quantity.minus(part.returnedQty)),
    ZERO,
  );
  if (quantity.greaterThan(available)) {
    throw new RuleViolationError(
      'return_exceeds_issue',
      `Cannot return ${fmtQty(quantity)}: only ${fmtQty(available)} of the issue is still out`,
    );
  }
  const allocations: ReturnAllocation[] = [];
  let need = quantity;
  for (const part of [...parts].reverse()) {
    if (need.isZero()) break;
    const open = part.quantity.minus(part.returnedQty);
    if (open.isZero()) continue;
    const taken = D.min(need, open);
    const left = part.value.minus(part.returnedValue);
    const value = taken.equals(open)
      ? left
      : D.min(money(taken.times(part.value).dividedBy(part.quantity)), left);
    allocations.push({
      consumptionId: part.consumptionId,
      layerReceivedSeq: part.layerReceivedSeq,
      quantity: taken,
      unitCost: part.unitCost,
      value,
    });
    need = need.minus(taken);
  }
  return allocations;
}

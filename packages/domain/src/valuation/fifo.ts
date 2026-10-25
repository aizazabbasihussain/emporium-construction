import { assertEnough, D, money, rate, ZERO, type Dec } from './amounts.js';

/**
 * BR-5: a FIFO layer. The value is tracked beside the quantity and reduced by what is consumed,
 * so layer values never drift from rounding.
 */
export interface Layer {
  id: string;
  receivedSeq: number;
  remainingQty: Dec;
  remainingValue: Dec;
  unitCost: Dec;
}

/** One part of an issue: a layer (FIFO) or the whole issue (weighted average, no layer). */
export interface IssuePart {
  layerId: string | null;
  layerReceivedSeq: number | null;
  quantity: Dec;
  unitCost: Dec;
  value: Dec;
}

export interface FifoIssue {
  value: Dec;
  parts: IssuePart[];
  /** The layers that changed, with their new remaining quantity and value. */
  layers: Layer[];
}

/** A receipt creates a layer at the stated value; the unit cost is for display and partial takes. */
export function newLayer(input: {
  id: string;
  receivedSeq: number;
  quantity: Dec;
  value: Dec;
  unitCost: Dec;
}): Layer {
  return {
    id: input.id,
    receivedSeq: input.receivedSeq,
    remainingQty: input.quantity,
    remainingValue: input.value,
    unitCost: input.unitCost,
  };
}

/** The unit cost of an amount spread over a quantity, to 4 decimals. */
export const unitCostOf = (value: Dec, quantity: Dec): Dec => rate(value.dividedBy(quantity));

/**
 * BR-5: consumes layers oldest first. A part that takes a whole layer uses the layer's remaining
 * value; a partial take is `round(taken x unit cost, 2)`, never more than the layer still holds.
 */
export function fifoIssue(layers: readonly Layer[], quantity: Dec): FifoIssue {
  const open = layers
    .filter((layer) => layer.remainingQty.greaterThan(0))
    .sort((a, b) => a.receivedSeq - b.receivedSeq || a.id.localeCompare(b.id));
  assertEnough(layersQuantity(open), quantity);
  const parts: IssuePart[] = [];
  const changed: Layer[] = [];
  let need = quantity;
  for (const layer of open) {
    if (need.isZero()) break;
    const taken = D.min(need, layer.remainingQty);
    const value = taken.equals(layer.remainingQty)
      ? layer.remainingValue
      : D.min(money(taken.times(layer.unitCost)), layer.remainingValue);
    parts.push({
      layerId: layer.id,
      layerReceivedSeq: layer.receivedSeq,
      quantity: taken,
      unitCost: layer.unitCost,
      value,
    });
    changed.push({
      ...layer,
      remainingQty: layer.remainingQty.minus(taken),
      remainingValue: layer.remainingValue.minus(value),
    });
    need = need.minus(taken);
  }
  return {
    value: parts.reduce((sum, part) => sum.plus(part.value), ZERO),
    parts,
    layers: changed,
  };
}

export const layersValue = (layers: readonly Layer[]): Dec =>
  layers.reduce((sum, layer) => sum.plus(layer.remainingValue), ZERO);

export const layersQuantity = (layers: readonly Layer[]): Dec =>
  layers.reduce((sum, layer) => sum.plus(layer.remainingQty), ZERO);

import { assertEnough, money, ZERO, type Dec } from './amounts.js';

/** BR-4: the stored state is the quantity and the total value; the average is for display only. */
export interface WaState {
  quantity: Dec;
  totalValue: Dec;
}

export const emptyWa: WaState = { quantity: ZERO, totalValue: ZERO };

/** BR-4: a receipt adds its quantity and its (already rounded) value. */
export function waReceive(state: WaState, quantity: Dec, value: Dec): WaState {
  return { quantity: state.quantity.plus(quantity), totalValue: state.totalValue.plus(value) };
}

export interface WaIssue {
  value: Dec;
  state: WaState;
}

/**
 * BR-4: issuing the whole quantity takes the whole value (clearing rounding residue); otherwise
 * `round(q x total / quantity, 2)`.
 */
export function waIssue(state: WaState, quantity: Dec): WaIssue {
  assertEnough(state.quantity, quantity);
  const value = quantity.equals(state.quantity)
    ? state.totalValue
    : money(quantity.times(state.totalValue).dividedBy(state.quantity));
  return {
    value,
    state: { quantity: state.quantity.minus(quantity), totalValue: state.totalValue.minus(value) },
  };
}

/** The moving average for display, to 4 decimals. */
export function waAverage(state: WaState): string {
  return state.quantity.isZero() ? '0.0000' : state.totalValue.dividedBy(state.quantity).toFixed(4);
}

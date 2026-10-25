import { RuleViolationError, ValidationError } from '../errors.js';
import { fmtMoney, rate, type Dec } from './amounts.js';
import { layersQuantity, layersValue, newLayer, type Layer } from './fifo.js';
import type { WaState } from './weighted-average.js';

export type Method = 'weighted_average' | 'fifo';

export interface PolicyRef {
  id: string;
  scope: 'company' | 'category';
  categoryId: string | null;
  method: Method;
  /** yyyy-mm-dd */
  effectiveFrom: string;
}

const latest = (policies: readonly PolicyRef[]): PolicyRef | undefined =>
  [...policies].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];

/**
 * BR-1: the nearest category in the item's category chain that has an approved policy in force on
 * the date wins; otherwise the company policy. `chain` lists the item's category first and its
 * ancestors after it.
 */
export function resolvePolicy(
  chain: readonly string[],
  policies: readonly PolicyRef[],
  date: string,
): PolicyRef {
  const inForce = policies.filter((policy) => policy.effectiveFrom <= date);
  for (const categoryId of chain) {
    const found = latest(
      inForce.filter((policy) => policy.scope === 'category' && policy.categoryId === categoryId),
    );
    if (found) return found;
  }
  const company = latest(inForce.filter((policy) => policy.scope === 'company'));
  if (!company) {
    throw new RuleViolationError(
      'no_company_policy',
      `No company valuation policy is in force on ${date}`,
    );
  }
  return company;
}

export interface PolicyRequest {
  scope: string;
  categoryId: string | null;
  effectiveFrom: string;
}

/** BR-2: a policy is for the company or for one category, and may not be back-dated. */
export function assertPolicyRequest(request: PolicyRequest, today: string): void {
  if (request.scope === 'category' && request.categoryId === null) {
    throw new ValidationError('category_required', 'A category policy needs a category');
  }
  if (request.scope === 'company' && request.categoryId !== null) {
    throw new ValidationError('category_not_allowed', 'A company policy has no category');
  }
  if (request.effectiveFrom < today) {
    throw new RuleViolationError(
      'policy_back_dated',
      'A valuation policy cannot start in the past',
    );
  }
}

/**
 * BR-2, BR-3: when approval comes after the requested start, the policy starts on the day it was
 * approved, so past movements keep their valuation.
 */
export const effectiveOnApproval = (effectiveFrom: string, today: string): string =>
  effectiveFrom < today ? today : effectiveFrom;

/** BR-10: weighted average to FIFO is one layer holding the whole value. Empty stock has no layer. */
export function waToFifo(input: {
  state: WaState;
  layerId: string;
  transitionSeq: number;
}): Layer[] {
  const { state } = input;
  if (state.quantity.isZero()) return [];
  return [
    newLayer({
      id: input.layerId,
      receivedSeq: input.transitionSeq,
      quantity: state.quantity,
      value: state.totalValue,
      unitCost: rate(state.totalValue.dividedBy(state.quantity)),
    }),
  ];
}

/** BR-10: FIFO to weighted average sums the open layers. */
export const fifoToWa = (layers: readonly Layer[]): WaState => ({
  quantity: layersQuantity(layers),
  totalValue: layersValue(layers),
});

/** BR-10: a transition may not change the total value; if it would, it is aborted. */
export function assertValueHeld(before: Dec, after: Dec): void {
  if (!before.equals(after)) {
    throw new RuleViolationError(
      'transition_value_mismatch',
      `Transition would change stock value from ${fmtMoney(before)} to ${fmtMoney(after)}`,
    );
  }
}

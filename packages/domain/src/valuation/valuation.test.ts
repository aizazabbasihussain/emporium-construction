import { describe, expect, it } from 'vitest';
import { RuleViolationError, ValidationError } from '../errors.js';
import {
  assertConserved,
  assertEnough,
  assertPolicyRequest,
  assertValueHeld,
  D,
  effectiveOnApproval,
  emptyWa,
  fifoIssue,
  fifoToWa,
  fmtMoney,
  fmtQty,
  fmtRate,
  newLayer,
  nonNegative,
  parseDecimal,
  planReturn,
  positiveQuantity,
  resolvePolicy,
  unitCostOf,
  waAverage,
  waIssue,
  waReceive,
  waToFifo,
  type Layer,
  type PolicyRef,
  type ReturnablePart,
  type WaState,
} from './index.js';

const d = (text: string) => new D(text);
const layer = (id: string, seq: number, qty: string, cost: string, value?: string): Layer =>
  newLayer({
    id,
    receivedSeq: seq,
    quantity: d(qty),
    value: d(value ?? d(qty).times(cost).toFixed(2)),
    unitCost: d(cost),
  });

describe('amounts', () => {
  it('parses exact decimals and rejects floats, text and excess precision', () => {
    expect(parseDecimal('12.5', 4, 'Quantity').toString()).toBe('12.5');
    expect(() => parseDecimal('1e3', 4, 'Quantity')).toThrow(ValidationError);
    expect(() => parseDecimal('abc', 4, 'Quantity')).toThrow(/valid decimal/);
    expect(() => parseDecimal('1.12345', 4, 'Quantity')).toThrow(/at most 4/);
  });

  it('requires positive quantities and non-negative amounts', () => {
    expect(positiveQuantity('2').toString()).toBe('2');
    expect(() => positiveQuantity('0')).toThrow(/greater than zero/);
    expect(() => positiveQuantity('-1')).toThrow(ValidationError);
    expect(nonNegative('0', 2, 'Value').toString()).toBe('0');
    expect(() => nonNegative('-0.01', 2, 'Value')).toThrow(/negative/);
  });

  it('formats to fixed places', () => {
    expect(fmtMoney(d('1'))).toBe('1.00');
    expect(fmtQty(d('1'))).toBe('1.0000');
    expect(fmtRate(d('1.5'))).toBe('1.5000');
  });

  it('refuses to issue more than is known (BR-7)', () => {
    expect(() => assertEnough(d('5'), d('5.0001'))).toThrow(RuleViolationError);
    expect(() => assertEnough(d('5'), d('5'))).not.toThrow();
  });

  it('asserts conservation to the paisa (BR-6)', () => {
    expect(() =>
      assertConserved({ before: d('10'), receipts: d('5'), issues: d('3'), after: d('12') }),
    ).not.toThrow();
    expect(() =>
      assertConserved({ before: d('10'), receipts: d('5'), issues: d('3'), after: d('12.01') }),
    ).toThrow(/conservation|differs/);
  });
});

describe('weighted average (BR-4)', () => {
  const receive = (state: WaState, qty: string, cost: string) =>
    waReceive(state, d(qty), d(qty).times(cost).toDecimalPlaces(2));

  it('T-1: the cement example issues 50 at 62,500 and leaves 187,500', () => {
    let state = receive(emptyWa, '100', '1200');
    state = receive(state, '100', '1300');
    expect(waAverage(state)).toBe('1250.0000');
    const issue = waIssue(state, d('50'));
    expect(fmtMoney(issue.value)).toBe('62500.00');
    expect(fmtMoney(issue.state.totalValue)).toBe('187500.00');
    expect(fmtQty(issue.state.quantity)).toBe('150.0000');
  });

  it('T-2: issuing everything clears the rounding residue exactly', () => {
    let state = receive(emptyWa, '3', '0.3333');
    expect(fmtMoney(state.totalValue)).toBe('1.00');
    const issued: string[] = [];
    for (let i = 0; i < 3; i++) {
      const issue = waIssue(state, d('1'));
      issued.push(fmtMoney(issue.value));
      state = issue.state;
    }
    expect(issued).toEqual(['0.33', '0.34', '0.33']);
    expect(state.quantity.isZero()).toBe(true);
    expect(state.totalValue.isZero()).toBe(true);
  });

  it('shows a zero average for an empty state and refuses an over-issue', () => {
    expect(waAverage(emptyWa)).toBe('0.0000');
    expect(() => waIssue(emptyWa, d('1'))).toThrow(/insufficient|only/);
  });
});

describe('FIFO (BR-5)', () => {
  it('T-1: the cement example issues 50 at 60,000 and leaves 190,000', () => {
    const layers = [layer('b', 2, '100', '1300'), layer('a', 1, '100', '1200')];
    const issue = fifoIssue(layers, d('50'));
    expect(fmtMoney(issue.value)).toBe('60000.00');
    expect(issue.parts).toHaveLength(1);
    expect(issue.layers.map((l) => fmtMoney(l.remainingValue))).toEqual(['60000.00']);
    const remaining = [issue.layers[0] as Layer, layers[0] as Layer];
    expect(remaining.reduce((sum, l) => sum.plus(l.remainingValue), d('0')).toFixed(2)).toBe(
      '190000.00',
    );
  });

  it('T-3: an issue spanning layers lists each part and stops when satisfied', () => {
    const layers = [layer('a', 1, '10', '1.5'), layer('b', 2, '10', '2'), layer('c', 3, '10', '3')];
    const issue = fifoIssue(layers, d('15'));
    expect(issue.parts.map((p) => [p.layerId, fmtQty(p.quantity), fmtMoney(p.value)])).toEqual([
      ['a', '10.0000', '15.00'],
      ['b', '5.0000', '10.00'],
    ]);
    expect(fmtMoney(issue.value)).toBe('25.00');
    expect(issue.layers).toHaveLength(2);
    expect(fifoIssue(layers, d('10')).parts).toHaveLength(1);
    expect(fifoIssue(layers, d('30')).parts).toHaveLength(3);
  });

  it('T-3: a layer taken in pieces never drifts; the last piece uses what is left', () => {
    let layers = [layer('a', 1, '4', '0.0050', '0.02')];
    const values: string[] = [];
    for (let i = 0; i < 4; i++) {
      const issue = fifoIssue(layers, d('1'));
      values.push(fmtMoney(issue.value));
      layers = layers.map((l) => issue.layers.find((c) => c.id === l.id) ?? l);
    }
    // The third piece is capped at what the layer still holds.
    expect(values).toEqual(['0.01', '0.01', '0.00', '0.00']);
    expect(layers[0]?.remainingValue.isZero()).toBe(true);
  });

  it('orders layers by sequence, then id, and skips empty ones', () => {
    const layers = [
      layer('b', 1, '1', '5'),
      layer('a', 1, '1', '4'),
      { ...layer('z', 0, '1', '1'), remainingQty: d('0'), remainingValue: d('0') },
    ];
    expect(fifoIssue(layers, d('2')).parts.map((p) => p.layerId)).toEqual(['a', 'b']);
  });

  it('refuses an issue beyond the open layers (BR-7)', () => {
    expect(() => fifoIssue([layer('a', 1, '1', '1')], d('2'))).toThrow(RuleViolationError);
  });

  it('computes a unit cost to 4 decimals', () => {
    expect(fmtRate(unitCostOf(d('10'), d('3')))).toBe('3.3333');
  });
});

describe('returns (BR-9)', () => {
  const part = (id: string, qty: string, value: string, returned = '0', back = '0') =>
    ({
      consumptionId: id,
      layerReceivedSeq: null,
      quantity: d(qty),
      unitCost: d('1'),
      value: d(value),
      returnedQty: d(returned),
      returnedValue: d(back),
    }) satisfies ReturnablePart;

  it('gives back the last part first, with the exact value of the final piece', () => {
    const parts = [part('p1', '10', '15.00'), part('p2', '5', '10.00')];
    const all = planReturn(parts, d('15'));
    expect(all.map((a) => [a.consumptionId, fmtMoney(a.value)])).toEqual([
      ['p2', '10.00'],
      ['p1', '15.00'],
    ]);
    const some = planReturn(parts, d('2'));
    expect(some).toHaveLength(1);
    expect(fmtMoney(some[0]?.value ?? d('0'))).toBe('4.00');
  });

  it('skips parts that are fully returned and stops when satisfied', () => {
    const parts = [part('p1', '10', '15.00'), part('p2', '5', '10.00', '5', '10.00')];
    expect(planReturn(parts, d('1')).map((a) => a.consumptionId)).toEqual(['p1']);
    expect(planReturn(parts, d('0'))).toEqual([]);
  });

  it('never restores more than the part still holds', () => {
    const parts = [part('p1', '4', '0.02', '2', '0.02')];
    expect(fmtMoney(planReturn(parts, d('1'))[0]?.value ?? d('9'))).toBe('0.00');
  });

  it('refuses to return more than is out', () => {
    expect(() => planReturn([part('p1', '2', '2.00', '1', '1.00')], d('2'))).toThrow(/still out/);
  });
});

describe('policy resolution (BR-1, T-6)', () => {
  const policy = (
    id: string,
    scope: 'company' | 'category',
    categoryId: string | null,
    method: 'fifo' | 'weighted_average',
    effectiveFrom: string,
  ): PolicyRef => ({ id, scope, categoryId, method, effectiveFrom });
  const company = policy('c1', 'company', null, 'weighted_average', '2000-01-01');

  it('uses the company policy when no category has one', () => {
    expect(resolvePolicy(['cat'], [company], '2026-10-25').id).toBe('c1');
    expect(resolvePolicy([], [company], '2026-10-25').id).toBe('c1');
  });

  it('lets the nearest category in the chain win over farther ones and the company', () => {
    const parent = policy('p', 'category', 'parent', 'fifo', '2026-01-01');
    const child = policy('k', 'category', 'child', 'weighted_average', '2026-01-01');
    const other = policy('o', 'category', 'other', 'fifo', '2026-01-01');
    const all = [company, parent, child, other];
    expect(resolvePolicy(['child', 'parent'], all, '2026-10-25').id).toBe('k');
    expect(resolvePolicy(['grandchild', 'parent'], all, '2026-10-25').id).toBe('p');
    expect(resolvePolicy(['unrelated'], all, '2026-10-25').id).toBe('c1');
  });

  it('honours effective dates and picks the latest one in force', () => {
    const later = policy('c2', 'company', null, 'fifo', '2026-10-26');
    expect(resolvePolicy([], [company, later], '2026-10-25').id).toBe('c1');
    expect(resolvePolicy([], [company, later], '2026-10-26').id).toBe('c2');
    expect(resolvePolicy([], [later, company], '2026-12-01').id).toBe('c2');
  });

  it('fails when no company policy is in force', () => {
    expect(() => resolvePolicy([], [], '2026-10-25')).toThrow(RuleViolationError);
  });

  it('validates policy requests: scope shape and no back-dating (BR-2)', () => {
    const base = { scope: 'company', categoryId: null, effectiveFrom: '2026-10-26' };
    expect(() => assertPolicyRequest(base, '2026-10-25')).not.toThrow();
    expect(() =>
      assertPolicyRequest({ ...base, effectiveFrom: '2026-10-25' }, '2026-10-25'),
    ).not.toThrow();
    expect(() =>
      assertPolicyRequest({ ...base, effectiveFrom: '2026-10-24' }, '2026-10-25'),
    ).toThrow(/past/);
    expect(() => assertPolicyRequest({ ...base, scope: 'category' }, '2026-10-25')).toThrow(
      /needs a category/,
    );
    expect(() => assertPolicyRequest({ ...base, categoryId: 'x' }, '2026-10-25')).toThrow(
      /no category/,
    );
    expect(() =>
      assertPolicyRequest({ ...base, scope: 'category', categoryId: 'x' }, '2026-10-25'),
    ).not.toThrow();
  });

  it('starts a late-approved policy on the approval day', () => {
    expect(effectiveOnApproval('2026-10-26', '2026-10-25')).toBe('2026-10-26');
    expect(effectiveOnApproval('2026-10-24', '2026-10-25')).toBe('2026-10-25');
  });
});

describe('transitions (BR-10)', () => {
  it('holds the value exactly from weighted average to FIFO and back', () => {
    const state: WaState = { quantity: d('3'), totalValue: d('10.00') };
    const layers = waToFifo({ state, layerId: 'L', transitionSeq: 9 });
    expect(layers).toHaveLength(1);
    expect(fmtRate(layers[0]?.unitCost ?? d('0'))).toBe('3.3333');
    expect(fmtMoney(layers[0]?.remainingValue ?? d('0'))).toBe('10.00');
    const back = fifoToWa(layers);
    expect(fmtQty(back.quantity)).toBe('3.0000');
    expect(fmtMoney(back.totalValue)).toBe('10.00');
    expect(waToFifo({ state: emptyWa, layerId: 'L', transitionSeq: 9 })).toEqual([]);
    expect(fifoToWa([])).toEqual(emptyWa);
  });

  it('aborts when the value would change', () => {
    expect(() => assertValueHeld(d('10'), d('10.00'))).not.toThrow();
    expect(() => assertValueHeld(d('10'), d('10.01'))).toThrow(/change stock value/);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertConserved,
  D,
  emptyWa,
  fifoIssue,
  fifoToWa,
  layersQuantity,
  layersValue,
  newLayer,
  planReturn,
  waIssue,
  waReceive,
  waToFifo,
  type Layer,
  type ReturnablePart,
  type WaState,
} from '../src/valuation/index.js';

// Spec P1-13 T-4, T-5, T-8: conservation and non-negativity under random sequences.

const RUNS = { numRuns: 1000 };
const qty = fc.integer({ min: 1, max: 5000 }).map((n) => new D(n).dividedBy(10).toFixed(4));
const cost = fc.integer({ min: 0, max: 200000 }).map((n) => new D(n).dividedBy(10000).toFixed(4));

type Step = { kind: 'receipt'; qty: string; cost: string } | { kind: 'issue'; qty: string };
const step = fc.oneof(
  fc.record({ kind: fc.constant('receipt' as const), qty, cost }),
  fc.record({ kind: fc.constant('issue' as const), qty }),
);

interface Run {
  value: InstanceType<typeof D>;
  quantity: InstanceType<typeof D>;
}

function runWa(steps: Step[]): Run {
  let state: WaState = emptyWa;
  let receipts = new D(0);
  let issues = new D(0);
  for (const s of steps) {
    const before = state.totalValue;
    if (s.kind === 'receipt') {
      const value = new D(s.qty).times(s.cost).toDecimalPlaces(2);
      state = waReceive(state, new D(s.qty), value);
      receipts = receipts.plus(value);
      assertConserved({ before, receipts: value, issues: new D(0), after: state.totalValue });
    } else if (new D(s.qty).lessThanOrEqualTo(state.quantity)) {
      const issue = waIssue(state, new D(s.qty));
      expect(issue.value.lessThanOrEqualTo(state.totalValue)).toBe(true);
      state = issue.state;
      issues = issues.plus(issue.value);
      assertConserved({ before, receipts: new D(0), issues: issue.value, after: state.totalValue });
    }
    expect(state.quantity.isNegative()).toBe(false);
    expect(state.totalValue.isNegative()).toBe(false);
    if (state.quantity.isZero()) expect(state.totalValue.isZero()).toBe(true);
  }
  expect(state.totalValue.equals(receipts.minus(issues))).toBe(true);
  return { value: state.totalValue, quantity: state.quantity };
}

function runFifo(steps: Step[]): { layers: Layer[]; run: Run } {
  let layers: Layer[] = [];
  let receipts = new D(0);
  let issues = new D(0);
  let seq = 0;
  for (const s of steps) {
    if (s.kind === 'receipt') {
      const value = new D(s.qty).times(s.cost).toDecimalPlaces(2);
      layers = [
        ...layers,
        newLayer({
          id: `L${++seq}`,
          receivedSeq: seq,
          quantity: new D(s.qty),
          value,
          unitCost: new D(s.cost),
        }),
      ];
      receipts = receipts.plus(value);
    } else if (new D(s.qty).lessThanOrEqualTo(layersQuantity(layers))) {
      const before = layersValue(layers);
      const issue = fifoIssue(layers, new D(s.qty));
      layers = layers.map((l) => issue.layers.find((c) => c.id === l.id) ?? l);
      issues = issues.plus(issue.value);
      expect(issue.value.lessThanOrEqualTo(before)).toBe(true);
      assertConserved({
        before,
        receipts: new D(0),
        issues: issue.value,
        after: layersValue(layers),
      });
    }
    for (const l of layers) {
      expect(l.remainingQty.isNegative()).toBe(false);
      expect(l.remainingValue.isNegative()).toBe(false);
    }
  }
  expect(layersValue(layers).equals(receipts.minus(issues))).toBe(true);
  return {
    layers,
    run: { value: layersValue(layers), quantity: layersQuantity(layers) },
  };
}

describe('valuation conservation (T-4, AC-3)', () => {
  it('weighted average: value after = value before + receipts - issues, never negative', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => void runWa(steps)),
      RUNS,
    );
  });

  it('FIFO: layers conserve value and never go negative', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => void runFifo(steps)),
      RUNS,
    );
  });

  it('both methods issue the same quantity and agree on what is left in total quantity', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        expect(runWa(steps).quantity.equals(runFifo(steps).run.quantity)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('transitions hold value (T-5)', () => {
  it('weighted average to FIFO and back keeps quantity and value exactly', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        let state: WaState = emptyWa;
        for (const s of steps) {
          if (s.kind === 'receipt') {
            state = waReceive(state, new D(s.qty), new D(s.qty).times(s.cost).toDecimalPlaces(2));
          } else if (new D(s.qty).lessThanOrEqualTo(state.quantity)) {
            state = waIssue(state, new D(s.qty)).state;
          }
        }
        const layers = waToFifo({ state, layerId: 'T', transitionSeq: 1 });
        expect(layersValue(layers).equals(state.totalValue)).toBe(true);
        const back = fifoToWa(layers);
        expect(back.quantity.equals(state.quantity)).toBe(true);
        expect(back.totalValue.equals(state.totalValue)).toBe(true);
      }),
      RUNS,
    );
  });

  it('FIFO to weighted average keeps quantity and value exactly', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        const { layers, run } = runFifo(steps);
        const state = fifoToWa(layers);
        expect(state.totalValue.equals(run.value)).toBe(true);
        expect(state.quantity.equals(run.quantity)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('returns restore the issue value (T-8)', () => {
  it('returning in pieces restores exactly the issue value and quantity', () => {
    fc.assert(
      fc.property(
        fc.array(step, { minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 6 }),
        (steps, pieces) => {
          const { layers } = runFifo(steps.filter((s) => s.kind === 'receipt'));
          const total = layersQuantity(layers);
          const issue = fifoIssue(layers, total);
          let parts: ReturnablePart[] = issue.parts.map((p, i) => ({
            consumptionId: `c${i}`,
            layerReceivedSeq: p.layerReceivedSeq,
            quantity: p.quantity,
            unitCost: p.unitCost,
            value: p.value,
            returnedQty: new D(0),
            returnedValue: new D(0),
          }));
          let restored = new D(0);
          let restoredQty = new D(0);
          let left = total;
          const sizes = [...pieces.map((n) => new D(n).dividedBy(10)), total];
          for (const size of sizes) {
            const take = D.min(size, left);
            if (take.isZero()) continue;
            for (const a of planReturn(parts, take)) {
              restored = restored.plus(a.value);
              restoredQty = restoredQty.plus(a.quantity);
              parts = parts.map((p) =>
                p.consumptionId === a.consumptionId
                  ? {
                      ...p,
                      returnedQty: p.returnedQty.plus(a.quantity),
                      returnedValue: p.returnedValue.plus(a.value),
                    }
                  : p,
              );
            }
            left = left.minus(take);
          }
          expect(restoredQty.equals(total)).toBe(true);
          expect(restored.equals(issue.value)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

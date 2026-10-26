import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DomainError } from '../errors.js';
import {
  addTotals,
  assertAmountAllowed,
  assertAssignmentDates,
  assertCanClose,
  assertCostObjectOpen,
  assertCostTransition,
  assertProjectTransition,
  assertSectorAllowed,
  assertTaskProgress,
  budgetFromCostLines,
  budgetVariance,
  chainKey,
  costStatuses,
  costTransitions,
  isAssignmentOpen,
  normalizeAmount,
  normalizeBudgetAmount,
  normalizeContractValue,
  projectProgress,
  projectStatuses,
  projectTransitions,
  summarizeChains,
  sumAmounts,
  type ChainRow,
  type CostStatus,
} from './index.js';

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as DomainError).code;
  }
  return undefined;
};

describe('project status machine (BR-4)', () => {
  const allowed = [
    'planning>active',
    'planning>cancelled',
    'active>on_hold',
    'active>completed',
    'active>cancelled',
    'on_hold>active',
    'completed>closed',
  ];
  for (const from of projectStatuses) {
    for (const to of projectStatuses) {
      const ok = allowed.includes(`${from}>${to}`);
      it(`${from} to ${to} is ${ok ? 'allowed' : 'refused'}`, () => {
        expect(codeOf(() => assertProjectTransition(from, to))).toBe(
          ok ? undefined : 'project_transition',
        );
        expect(projectTransitions[from].includes(to)).toBe(ok);
      });
    }
  }

  it('lists the entries that block closing', () => {
    expect(() => assertCanClose({ committed: [], unpostedApproved: [] })).not.toThrow();
    for (const open of [
      { committed: ['a'], unpostedApproved: [] },
      { committed: [], unpostedApproved: ['b'] },
    ]) {
      try {
        assertCanClose(open);
        expect.unreachable();
      } catch (error) {
        expect((error as DomainError).code).toBe('project_has_open_costs');
        expect((error as DomainError).details).toEqual(open);
      }
    }
  });
});

describe('cost status machine (BR-6)', () => {
  const allowed = [
    'committed>approved',
    'committed>reversed',
    'approved>posted',
    'approved>reversed',
    'posted>reversed',
  ];
  for (const from of costStatuses) {
    for (const to of costStatuses) {
      const ok = allowed.includes(`${from}>${to}`);
      it(`${from} to ${to} is ${ok ? 'allowed' : 'refused'}`, () => {
        expect(codeOf(() => assertCostTransition(from, to))).toBe(
          ok ? undefined : 'cost_transition',
        );
        expect(costTransitions[from].includes(to)).toBe(ok);
      });
    }
  }
});

describe('amounts (BR-5)', () => {
  it('normalizes to two decimals and refuses anything else', () => {
    expect(normalizeAmount(' 12.5 ')).toBe('12.50');
    expect(normalizeAmount('-3')).toBe('-3.00');
    for (const bad of ['', 'abc', '1.234', '1e3', '--1', '1,000']) {
      expect(codeOf(() => normalizeAmount(bad))).toBe('amount_invalid');
    }
  });

  it('allows a negative amount only for salvage', () => {
    expect(() => assertAmountAllowed('5.00', 'goods_receipt')).not.toThrow();
    expect(() => assertAmountAllowed('-5.00', 'salvage')).not.toThrow();
    expect(codeOf(() => assertAmountAllowed('-5.00', 'goods_receipt'))).toBe('amount_negative');
  });

  it('budget amounts and contract values', () => {
    expect(normalizeBudgetAmount('10')).toBe('10.00');
    expect(codeOf(() => normalizeBudgetAmount('-1'))).toBe('budget_negative');
    expect(normalizeContractValue('99.9')).toBe('99.90');
    expect(codeOf(() => normalizeContractValue('0'))).toBe('contract_value_not_positive');
  });
});

describe('cost objects (BR-5, BR-11)', () => {
  const base = { id: 'p1', workOrdersEnabled: false } as const;
  it('accepts an open project and overhead without an id', () => {
    for (const projectStatus of ['planning', 'active'] as const) {
      expect(() => assertCostObjectOpen({ ...base, type: 'project', projectStatus })).not.toThrow();
    }
    expect(() =>
      assertCostObjectOpen({
        type: 'overhead',
        id: null,
        workOrdersEnabled: false,
        projectStatus: null,
      }),
    ).not.toThrow();
  });

  it('refuses a project that is missing or not open', () => {
    expect(
      codeOf(() => assertCostObjectOpen({ ...base, type: 'project', projectStatus: null })),
    ).toBe('cost_object_not_found');
    for (const projectStatus of ['on_hold', 'completed', 'closed', 'cancelled'] as const) {
      expect(codeOf(() => assertCostObjectOpen({ ...base, type: 'project', projectStatus }))).toBe(
        'cost_object_not_open',
      );
    }
  });

  it('refuses a wrong id for the kind of object', () => {
    expect(
      codeOf(() =>
        assertCostObjectOpen({
          type: 'overhead',
          id: 'x',
          workOrdersEnabled: false,
          projectStatus: null,
        }),
      ),
    ).toBe('overhead_has_no_id');
    expect(
      codeOf(() =>
        assertCostObjectOpen({
          type: 'project',
          id: null,
          workOrdersEnabled: false,
          projectStatus: null,
        }),
      ),
    ).toBe('cost_object_required');
  });

  it('refuses a work order until the flag is on, then accepts it', () => {
    expect(
      codeOf(() =>
        assertCostObjectOpen({
          type: 'work_order',
          id: 'w',
          workOrdersEnabled: false,
          projectStatus: null,
        }),
      ),
    ).toBe('work_order_disabled');
    expect(() =>
      assertCostObjectOpen({
        type: 'work_order',
        id: 'w',
        workOrdersEnabled: true,
        projectStatus: null,
      }),
    ).not.toThrow();
  });
});

describe('ledger chains (BR-6, BR-7)', () => {
  const row = (seq: number, chain: string, status: CostStatus, amount = '100.00'): ChainRow => ({
    seq,
    chain,
    costCodeId: 'c',
    amount,
    status,
  });

  it('builds a chain key that treats a missing line as empty', () => {
    expect(chainKey('prc', 'grn', 'd1', 'l1')).toBe('prc|grn|d1|l1');
    expect(chainKey('prc', 'grn', 'd1', null)).toBe('prc|grn|d1|');
  });

  it('counts the latest row of each chain and nets reversed chains to zero', () => {
    const rows = [
      row(1, 'a', 'committed'),
      row(2, 'a', 'approved'),
      row(3, 'a', 'posted'),
      row(4, 'b', 'committed', '50.00'),
      row(5, 'b', 'reversed', '50.00'),
      row(6, 'c', 'approved', '25.50'),
    ];
    expect(summarizeChains(rows)).toEqual({
      committed: '0.00',
      approved: '25.50',
      posted: '100.00',
    });
  });

  it('does not depend on the order the rows are listed in', () => {
    const rows = [row(2, 'a', 'approved'), row(1, 'a', 'committed'), row(3, 'a', 'posted')];
    expect(summarizeChains(rows).posted).toBe('100.00');
    expect(summarizeChains([])).toEqual({ committed: '0.00', approved: '0.00', posted: '0.00' });
  });

  it('adds money exactly', () => {
    expect(sumAmounts([])).toBe('0.00');
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
  });

  it('adds the totals of several cost codes', () => {
    expect(
      addTotals([
        { committed: '1.10', approved: '2.00', posted: '3.00' },
        { committed: '0.20', approved: '0.00', posted: '-1.00' },
      ]),
    ).toEqual({ committed: '1.30', approved: '2.00', posted: '2.00' });
  });

  it('property: reversing every chain yields zero, whatever the sequence', () => {
    const steps = fc.array(
      fc.record({
        chain: fc.integer({ min: 0, max: 4 }),
        amount: fc.integer({ min: 1, max: 10_000_000 }),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(steps, (list) => {
        const rows: ChainRow[] = [];
        const seen = new Set<number>();
        for (const { chain, amount } of list) {
          if (seen.has(chain)) continue;
          seen.add(chain);
          const money = (amount / 100).toFixed(2);
          for (const status of ['committed', 'approved', 'posted'] as const) {
            rows.push(row(rows.length + 1, `k${chain}`, status, money));
          }
        }
        const before = summarizeChains(rows);
        expect(before.committed).toBe('0.00');
        for (const chain of seen) {
          const last = rows.filter((r) => r.chain === `k${chain}`).at(-1) as ChainRow;
          rows.push(row(rows.length + 1, `k${chain}`, 'reversed', last.amount));
        }
        expect(summarizeChains(rows)).toEqual({
          committed: '0.00',
          approved: '0.00',
          posted: '0.00',
        });
      }),
    );
  });
});

describe('budget variance (BR-8)', () => {
  const totals = (committed: string, approved: string, posted: string) => ({
    committed,
    approved,
    posted,
  });

  it('is the budget less all three statuses', () => {
    expect(budgetVariance('1000', totals('100', '200', '300'), 90)).toEqual({
      budget: '1000.00',
      spent: '600.00',
      variance: '400.00',
      flag: 'ok',
    });
  });

  it('warns at the threshold and flags overspend', () => {
    expect(budgetVariance('1000', totals('0', '0', '899.99'), 90).flag).toBe('ok');
    expect(budgetVariance('1000', totals('0', '0', '900'), 90).flag).toBe('warning');
    expect(budgetVariance('1000', totals('0', '0', '1000'), 90).flag).toBe('warning');
    expect(budgetVariance('1000', totals('0', '0', '1000.01'), 90)).toMatchObject({
      variance: '-0.01',
      flag: 'overspent',
    });
  });

  it('never warns when nothing is spent, even on a zero budget', () => {
    expect(budgetVariance('0', totals('0', '0', '0'), 90).flag).toBe('ok');
    expect(budgetVariance('0', totals('1', '0', '0'), 90).flag).toBe('overspent');
  });
});

describe('project rules', () => {
  it('blocks government projects unless the flag is on (BR-2)', () => {
    expect(codeOf(() => assertSectorAllowed('government', false))).toBe(
      'government_data_not_allowed',
    );
    expect(() => assertSectorAllowed('government', true)).not.toThrow();
    expect(() => assertSectorAllowed('private', false)).not.toThrow();
  });

  it('groups estimate cost lines by cost code and drops empty groups (BR-1)', () => {
    expect(
      budgetFromCostLines([
        { costCodeId: 'm', amount: '100.10' },
        { costCodeId: 'l', amount: '50.00' },
        { costCodeId: 'm', amount: '200.20' },
        { costCodeId: 's', amount: '-20.00' },
        { costCodeId: 'z', amount: '0.00' },
      ]),
    ).toEqual([
      { costCodeId: 'm', amount: '300.30' },
      { costCodeId: 'l', amount: '50.00' },
    ]);
    expect(budgetFromCostLines([])).toEqual([]);
  });

  it('checks supervisor assignment dates (BR-9)', () => {
    expect(() => assertAssignmentDates('2026-01-02', null)).not.toThrow();
    expect(() => assertAssignmentDates('2026-01-02', '2026-01-02')).not.toThrow();
    expect(codeOf(() => assertAssignmentDates('2026-01-02', '2026-01-01'))).toBe(
      'assignment_dates_invalid',
    );
    expect(isAssignmentOpen(null, '2026-01-02')).toBe(true);
    expect(isAssignmentOpen('2026-01-05', '2026-01-04')).toBe(true);
    expect(isAssignmentOpen('2026-01-05', '2026-01-05')).toBe(false);
    expect(isAssignmentOpen('2026-01-05', '2026-01-06')).toBe(false);
  });
});

describe('tasks (BR-10)', () => {
  it('keeps percent between 0 and 100 and requires 100 for done', () => {
    expect(() => assertTaskProgress('todo', 0)).not.toThrow();
    expect(() => assertTaskProgress('doing', 40)).not.toThrow();
    expect(() => assertTaskProgress('done', 100)).not.toThrow();
    expect(codeOf(() => assertTaskProgress('done', 99))).toBe('done_needs_100');
    for (const bad of [-1, 101, 1.5, Number.NaN]) {
      expect(codeOf(() => assertTaskProgress('doing', bad))).toBe('percent_invalid');
    }
  });

  it('averages the task percents equally', () => {
    expect(projectProgress([])).toBe('0.00');
    expect(projectProgress([100, 50, 0])).toBe('50.00');
    expect(projectProgress([100, 100, 0])).toBe('66.67');
  });
});

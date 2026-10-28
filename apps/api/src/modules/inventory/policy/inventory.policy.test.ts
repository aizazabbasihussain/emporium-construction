import { describe, expect, it } from 'vitest';
import {
  assertClient,
  assertCostCodeKnown,
  assertDifferentStores,
  assertFound,
  assertKnown,
  assertLossCostCode,
  assertMayIssue,
  assertOwnerMatches,
  assertProjectOpen,
  assertStockable,
  assertStoreActive,
  assertStoreReachable,
  assertUpdated,
} from './inventory.policy.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const supervisor = {
  roles: ['supervisor'],
  scopes: [{ type: 'project' as const, id: 'p1' }],
  permissions: new Set<string>(),
};
const keeper = {
  roles: ['storekeeper'],
  scopes: [],
  permissions: new Set(['inventory.stock.issue']),
};

describe('inventory policy', () => {
  it('reports a missing record and a moved version', () => {
    expect(assertFound('x', 'store')).toBe('x');
    expect(codeOf(() => assertFound(undefined, 'store'))).toBe('store_not_found');
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(codeOf(() => assertKnown(false, 'item_not_found', 'x'))).toBe('item_not_found');
    expect(() => assertKnown(true, 'item_not_found', 'x')).not.toThrow();
  });

  it('limits a supervisor to the stores of assigned projects and hides warehouses', () => {
    expect(() => assertStoreReachable(supervisor, { projectId: 'p1' })).not.toThrow();
    expect(codeOf(() => assertStoreReachable(supervisor, { projectId: 'p2' }))).toBe(
      'store_not_found',
    );
    expect(codeOf(() => assertStoreReachable(supervisor, { projectId: null }))).toBe(
      'store_not_found',
    );
    expect(() => assertStoreReachable(keeper, { projectId: null })).not.toThrow();
    expect(() => assertStoreReachable(keeper, { projectId: 'p9' })).not.toThrow();
  });

  it('lets a supervisor issue only while the setting is on', () => {
    expect(() => assertMayIssue(keeper, false)).not.toThrow();
    expect(() => assertMayIssue(supervisor, true)).not.toThrow();
    expect(codeOf(() => assertMayIssue(supervisor, false))).toBe('forbidden');
    expect(
      codeOf(() => assertMayIssue({ roles: ['accountant'], permissions: new Set() }, true)),
    ).toBe('forbidden');
  });

  it('checks stores, items and projects', () => {
    expect(() => assertStoreActive(true)).not.toThrow();
    expect(codeOf(() => assertStoreActive(false))).toBe('store_inactive');
    expect(() => assertStockable({ stockable: true, active: true })).not.toThrow();
    expect(codeOf(() => assertStockable({ stockable: false, active: true }))).toBe(
      'item_not_stockable',
    );
    expect(codeOf(() => assertStockable({ stockable: true, active: false }))).toBe('item_inactive');
    expect(() => assertProjectOpen('planning')).not.toThrow();
    expect(() => assertProjectOpen('active')).not.toThrow();
    expect(codeOf(() => assertProjectOpen('closed'))).toBe('project_not_open');
    expect(codeOf(() => assertDifferentStores('a', 'a'))).toBe('same_store');
    expect(() => assertDifferentStores('a', 'b')).not.toThrow();
  });

  it('names the cost code and the loss cost code', () => {
    expect(assertCostCodeKnown('c1')).toBe('c1');
    expect(codeOf(() => assertCostCodeKnown(null))).toBe('cost_code_required');
    expect(assertLossCostCode('c1')).toBe('c1');
    expect(codeOf(() => assertLossCostCode(''))).toBe('stock_loss_cost_code_missing');
    expect(codeOf(() => assertLossCostCode(5))).toBe('stock_loss_cost_code_missing');
  });

  it('matches ownership with the owner party', () => {
    expect(() => assertOwnerMatches('company', null)).not.toThrow();
    expect(() => assertOwnerMatches('client', 'c1')).not.toThrow();
    expect(codeOf(() => assertOwnerMatches('client', null))).toBe('owner_required');
    expect(codeOf(() => assertOwnerMatches('company', 'c1'))).toBe('owner_not_allowed');
    expect(() => assertClient({ roles: ['client'] })).not.toThrow();
    expect(codeOf(() => assertClient({ roles: ['vendor'] }))).toBe('client_not_found');
    expect(codeOf(() => assertClient(undefined))).toBe('client_not_found');
  });
});

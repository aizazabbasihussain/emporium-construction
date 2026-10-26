import { describe, expect, it } from 'vitest';
import type { Actor } from '../types.js';
import {
  assertBudgetEditable,
  assertChainFree,
  assertCostCodeActive,
  assertFound,
  assertKnown,
  assertLatestInChain,
  assertProjectReachable,
  assertUpdated,
  canReachProject,
} from './projects.policy.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const actor = (roles: string[], scopes: Actor['scopes'] = []): Actor => ({
  userId: 'u',
  roles,
  scopes,
  permissions: new Set(),
  requestId: null,
});

describe('projects policy', () => {
  it('reports a missing record as not found', () => {
    expect(assertFound(5, 'x')).toBe(5);
    expect(codeOf(() => assertFound(undefined, 'project'))).toBe('project_not_found');
  });

  it('reports a moved version as a conflict', () => {
    expect(assertUpdated(1)).toBe(1);
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
  });

  it('requires a reference to exist', () => {
    expect(() => assertKnown(true, 'c', 'm')).not.toThrow();
    expect(codeOf(() => assertKnown(false, 'party_not_found', 'm'))).toBe('party_not_found');
  });

  it('limits a supervisor to assigned projects and lets other roles through', () => {
    const scoped = actor(['supervisor'], [{ type: 'project', id: 'p1' }]);
    expect(canReachProject(scoped, 'p1')).toBe(true);
    expect(canReachProject(scoped, 'p2')).toBe(false);
    expect(canReachProject(actor(['project_manager']), 'p2')).toBe(true);
    expect(() => assertProjectReachable(scoped, 'p1')).not.toThrow();
    expect(codeOf(() => assertProjectReachable(scoped, 'p2'))).toBe('project_not_found');
  });

  it('allows a cost chain to be posted only when it has no live row', () => {
    expect(() => assertChainFree(undefined)).not.toThrow();
    expect(() => assertChainFree('reversed')).not.toThrow();
    for (const status of ['committed', 'approved', 'posted']) {
      expect(codeOf(() => assertChainFree(status))).toBe('cost_chain_exists');
    }
  });

  it('moves only the latest row of a chain', () => {
    expect(() => assertLatestInChain(true)).not.toThrow();
    expect(codeOf(() => assertLatestInChain(false))).toBe('cost_entry_superseded');
  });

  it('freezes the budget of closed and cancelled projects only', () => {
    for (const status of ['planning', 'active', 'on_hold', 'completed']) {
      expect(() => assertBudgetEditable(status)).not.toThrow();
    }
    for (const status of ['closed', 'cancelled']) {
      expect(codeOf(() => assertBudgetEditable(status))).toBe('project_read_only');
    }
  });

  it('needs an active cost code', () => {
    expect(() => assertCostCodeActive(true)).not.toThrow();
    expect(codeOf(() => assertCostCodeActive(false))).toBe('cost_code_inactive');
  });
});

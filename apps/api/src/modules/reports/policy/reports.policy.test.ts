import { describe, expect, it } from 'vitest';
import {
  assertExportable,
  assertMayRead,
  assertOwnFilter,
  assertProjectReachable,
  scopedProjectIds,
} from './reports.policy.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

describe('assertMayRead (BR-8)', () => {
  it('opens a report for the holder of its permission only', () => {
    const cost = { permissions: new Set(['reports.project_cost.read']) };
    expect(codeOf(() => assertMayRead(cost, 'project-cost'))).toBe('no error');
    expect(codeOf(() => assertMayRead(cost, 'labour'))).toBe('forbidden');
    expect(codeOf(() => assertMayRead({ permissions: new Set() }, 'pipeline'))).toBe('forbidden');
  });

  it('opens the client material report with the stock permission', () => {
    const stock = { permissions: new Set(['reports.stock.read']) };
    expect(codeOf(() => assertMayRead(stock, 'client-material'))).toBe('no error');
    expect(codeOf(() => assertMayRead(stock, 'stock'))).toBe('no error');
  });
});

describe('project scope (BR-8)', () => {
  const project = { type: 'project' as const, id: 'p-1' };

  it('limits a supervisor to the projects assigned to them', () => {
    expect(scopedProjectIds({ roles: ['supervisor'], scopes: [project] })).toEqual(['p-1']);
    expect(scopedProjectIds({ roles: ['supervisor'], scopes: [] })).toEqual([]);
  });

  it('does not limit a caller with an unscoped role', () => {
    expect(scopedProjectIds({ roles: ['supervisor', 'management'], scopes: [project] })).toBe(
      undefined,
    );
    expect(scopedProjectIds({ roles: ['management'], scopes: [] })).toBe(undefined);
  });

  it('reports a project outside the scope as not found', () => {
    expect(codeOf(() => assertProjectReachable(['p-1'], 'p-1'))).toBe('no error');
    expect(codeOf(() => assertProjectReachable(['p-1'], 'p-2'))).toBe('project_not_found');
    expect(codeOf(() => assertProjectReachable(['p-1'], undefined))).toBe('no error');
    expect(codeOf(() => assertProjectReachable(undefined, 'p-2'))).toBe('no error');
  });
});

describe('assertExportable (BR-10)', () => {
  it('refuses more rows than the limit and tells the user to narrow the filters', () => {
    expect(codeOf(() => assertExportable(50_000, 50_000))).toBe('no error');
    expect(codeOf(() => assertExportable(50_001, 50_000))).toBe('export_too_large');
    expect(() => assertExportable(60_000, 50_000)).toThrow(/narrow the filters/);
  });
});

describe('assertOwnFilter', () => {
  it('lets the owner through and hides the filter of anyone else', () => {
    expect(codeOf(() => assertOwnFilter({ user_id: 'u-1' }, 'u-1'))).toBe('no error');
    expect(codeOf(() => assertOwnFilter({ user_id: 'u-1' }, 'u-2'))).toBe('saved_filter_not_found');
    expect(codeOf(() => assertOwnFilter(undefined, 'u-1'))).toBe('saved_filter_not_found');
  });
});

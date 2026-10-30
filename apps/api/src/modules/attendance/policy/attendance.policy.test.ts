import { describe, expect, it } from 'vitest';
import {
  assertAny,
  assertCostCodeActive,
  assertFound,
  assertLabourCodeKnown,
  assertMembers,
  assertMultiplier,
  assertProjectActive,
  assertProjectReachable,
  assertReason,
  assertTeamActive,
  assertTeamReachable,
  assertUpdated,
  assertVersionGiven,
  assertWagePeriodOpen,
  assertWorkersFree,
  canSeeCost,
  missingRate,
} from './attendance.policy.js';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
};

const supervisor = {
  roles: ['supervisor'],
  scopes: [
    { type: 'team' as const, id: 't1' },
    { type: 'project' as const, id: 'p1' },
  ],
};
const manager = { roles: ['project_manager'], scopes: [] };

describe('attendance policy (T-7)', () => {
  it('reports a missing record as not found and a moved version as a conflict', () => {
    expect(codeOf(() => assertFound(undefined, 'sheet'))).toBe('sheet_not_found');
    expect(assertFound(1, 'sheet')).toBe(1);
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
    expect(assertUpdated('row')).toBe('row');
  });

  it('limits a supervisor to their own teams and projects, and lets office roles reach any', () => {
    expect(codeOf(() => assertTeamReachable(supervisor, 't1'))).toBe('no error');
    expect(codeOf(() => assertTeamReachable(supervisor, 't2'))).toBe('team_not_found');
    expect(codeOf(() => assertTeamReachable(manager, 't2'))).toBe('no error');
    expect(codeOf(() => assertProjectReachable(supervisor, 'p1'))).toBe('no error');
    expect(codeOf(() => assertProjectReachable(supervisor, 'p2'))).toBe('project_not_found');
    expect(codeOf(() => assertProjectReachable(manager, 'p2'))).toBe('no error');
  });

  it('allows an active project, cost code and team only', () => {
    expect(codeOf(() => assertProjectActive('active'))).toBe('no error');
    expect(codeOf(() => assertProjectActive('on_hold'))).toBe('project_not_active');
    expect(codeOf(() => assertCostCodeActive(true))).toBe('no error');
    expect(codeOf(() => assertCostCodeActive(false))).toBe('cost_code_inactive');
    expect(codeOf(() => assertTeamActive(true))).toBe('no error');
    expect(codeOf(() => assertTeamActive(false))).toBe('team_inactive');
    expect(assertLabourCodeKnown('code')).toBe('code');
    expect(codeOf(() => assertLabourCodeKnown(undefined))).toBe('labour_cost_code_unknown');
  });

  it('names the workers who are not members or already on another sheet', () => {
    expect(codeOf(() => assertMembers([]))).toBe('no error');
    expect(codeOf(() => assertMembers(['w1']))).toBe('worker_not_in_team');
    expect(codeOf(() => assertWorkersFree([]))).toBe('no error');
    expect(codeOf(() => assertWorkersFree(['Ali', 'Bilal']))).toBe('worker_on_other_sheet');
    expect(() => assertWorkersFree(['Ali', 'Bilal'])).toThrow('Ali, Bilal');
  });

  it('names the worker whose rate is missing', () => {
    const error = missingRate('Ali', '2026-10-23');
    expect(error.code).toBe('worker_rate_missing');
    expect(error.message).toContain('Ali');
  });

  it('accepts a positive overtime multiplier and nothing else', () => {
    expect(assertMultiplier(' 1.5 ')).toBe('1.5');
    expect(assertMultiplier('2')).toBe('2');
    expect(codeOf(() => assertMultiplier('abc'))).toBe('overtime_multiplier_invalid');
    expect(codeOf(() => assertMultiplier('0'))).toBe('overtime_multiplier_invalid');
    expect(codeOf(() => assertMultiplier('1.23456'))).toBe('overtime_multiplier_invalid');
  });

  it('refuses to unlock inside an approved wage period and names it', () => {
    expect(codeOf(() => assertWagePeriodOpen(null))).toBe('no error');
    expect(codeOf(() => assertWagePeriodOpen('October 2026'))).toBe('wage_period_approved');
    expect(() => assertWagePeriodOpen('October 2026')).toThrow('October 2026');
  });

  it('needs the version of a sheet that exists, and a reason to unlock', () => {
    expect(assertVersionGiven(3)).toBe(3);
    expect(codeOf(() => assertVersionGiven(undefined))).toBe('version_conflict');
    expect(assertReason('  Wrong project ')).toBe('Wrong project');
    expect(codeOf(() => assertReason('   '))).toBe('reason_required');
  });

  it('opens a route to the holder of any one of the permissions', () => {
    const caller = { permissions: new Set(['a.b.c']) };
    expect(codeOf(() => assertAny(caller, ['x.y.z', 'a.b.c']))).toBe('no error');
    expect(codeOf(() => assertAny(caller, ['x.y.z']))).toBe('forbidden');
  });

  it('hides cost from a supervisor only', () => {
    expect(canSeeCost(supervisor)).toBe(false);
    expect(canSeeCost(manager)).toBe(true);
    expect(canSeeCost({ roles: ['supervisor', 'project_manager'], scopes: [] })).toBe(true);
  });
});

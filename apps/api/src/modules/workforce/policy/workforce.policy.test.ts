import { describe, expect, it } from 'vitest';
import {
  assertAny,
  assertCnicFree,
  assertFound,
  assertRemovable,
  assertSupervisor,
  assertTeamReachable,
  assertUpdated,
  assertWorkerActive,
  assertWorkerReachable,
  canReachTeam,
  canReadRates,
  canSeeSensitive,
  teamLimit,
} from './workforce.policy.js';

const supervisor = (teamIds: string[] = []) => ({
  userId: 'u-sup',
  roles: ['supervisor'],
  scopes: teamIds.map((id) => ({ type: 'team' as const, id })),
  permissions: new Set(['workforce.worker.read']),
});
const manager = {
  userId: 'u-pm',
  roles: ['project_manager'],
  scopes: [],
  permissions: new Set(['workforce.worker.read', 'workforce.team.manage']),
};
const accountant = {
  userId: 'u-acc',
  roles: ['accountant'],
  scopes: [],
  permissions: new Set(['workforce.worker.read', 'workforce.worker.manage', 'workforce.rate.read']),
};

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

describe('workforce policy', () => {
  it('reports a missing record as not found and a moved version as a conflict', () => {
    expect(assertFound('row', 'worker')).toBe('row');
    expect(codeOf(() => assertFound(undefined, 'worker'))).toBe('worker_not_found');
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
  });

  it('opens a route to the holder of any one permission', () => {
    expect(() => assertAny(manager, ['x', 'workforce.team.manage'])).not.toThrow();
    expect(codeOf(() => assertAny(manager, ['workforce.rate.read']))).toBe('forbidden');
  });

  it('shows pay and sensitive details only to those with the permission (BR-7, BR-8)', () => {
    expect(canReadRates(accountant)).toBe(true);
    expect(canReadRates(supervisor())).toBe(false);
    expect(canSeeSensitive(accountant)).toBe(true);
    expect(canSeeSensitive(manager)).toBe(false);
  });

  it('limits a supervisor to the teams in scope and lets office roles reach any', () => {
    expect(canReachTeam(supervisor(['t1']), 't1')).toBe(true);
    expect(canReachTeam(supervisor(['t1']), 't2')).toBe(false);
    expect(canReachTeam(manager, 't2')).toBe(true);
    expect(() => assertTeamReachable(supervisor(['t1']), 't1')).not.toThrow();
    expect(codeOf(() => assertTeamReachable(supervisor(['t1']), 't2'))).toBe('team_not_found');
    expect(teamLimit(supervisor(['t1', 't3']))).toEqual(['t1', 't3']);
    expect(teamLimit(supervisor())).toEqual([]);
    expect(teamLimit(manager)).toBeUndefined();
  });

  it('lets a supervisor see a worker only while the worker is in one of their teams', () => {
    expect(() => assertWorkerReachable(supervisor(['t1']), ['t9', 't1'])).not.toThrow();
    expect(codeOf(() => assertWorkerReachable(supervisor(['t1']), ['t9']))).toBe(
      'worker_not_found',
    );
    expect(codeOf(() => assertWorkerReachable(supervisor(['t1']), []))).toBe('worker_not_found');
    expect(() => assertWorkerReachable(manager, [])).not.toThrow();
  });

  it('wants a team supervisor with the supervisor role (BR-5)', () => {
    expect(() => assertSupervisor({ roles: ['supervisor', 'storekeeper'] })).not.toThrow();
    expect(codeOf(() => assertSupervisor({ roles: ['storekeeper'] }))).toBe('supervisor_invalid');
    expect(codeOf(() => assertSupervisor(undefined))).toBe('supervisor_invalid');
  });

  it('keeps a CNIC to one active worker (BR-1)', () => {
    expect(() => assertCnicFree(undefined, undefined)).not.toThrow();
    expect(() => assertCnicFree('w1', 'w1')).not.toThrow();
    expect(codeOf(() => assertCnicFree('w1', 'w2'))).toBe('cnic_in_use');
    expect(codeOf(() => assertCnicFree('w1', undefined))).toBe('cnic_in_use');
  });

  it('needs an active worker, and keeps records in use', () => {
    expect(() => assertWorkerActive('active')).not.toThrow();
    expect(codeOf(() => assertWorkerActive('inactive'))).toBe('worker_inactive');
    expect(() => assertRemovable(false, 'x_in_use')).not.toThrow();
    expect(codeOf(() => assertRemovable(true, 'x_in_use'))).toBe('x_in_use');
  });
});

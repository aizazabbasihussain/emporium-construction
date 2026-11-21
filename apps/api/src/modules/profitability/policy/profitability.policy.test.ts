import { describe, expect, it } from 'vitest';
import {
  assertFound,
  assertForecastAmount,
  assertMayManageThresholds,
  assertMayRead,
  assertMaySetForecast,
  assertProjectVisible,
  assertScopeMatches,
  assertThresholdFree,
  canSeeProject,
} from './profitability.policy.js';

const holding = (...permissions: string[]) => ({ permissions: new Set(permissions) });
const project = { id: 'p', code: 'P-1', name: 'One', status: 'active', projectManagerId: 'pm-1' };

describe('permissions (spec section 6)', () => {
  it('reads need profitability.project.read', () => {
    expect(() => assertMayRead(holding('profitability.project.read'))).not.toThrow();
    expect(() => assertMayRead(holding('profitability.forecast.set'))).toThrow(/Not allowed/);
    expect(() => assertMayRead(holding())).toThrow(/Not allowed/);
  });

  it('forecasts and thresholds each need their own permission', () => {
    expect(() => assertMaySetForecast(holding('profitability.forecast.set'))).not.toThrow();
    expect(() => assertMaySetForecast(holding('profitability.project.read'))).toThrow(/forecast/);
    expect(() =>
      assertMayManageThresholds(holding('profitability.threshold.manage')),
    ).not.toThrow();
    expect(() => assertMayManageThresholds(holding('profitability.forecast.set'))).toThrow(
      /thresholds/,
    );
  });
});

describe('visibility (BR-8)', () => {
  it('management, the accountant and admin see every project', () => {
    for (const role of ['management', 'accountant', 'admin']) {
      expect(canSeeProject({ roles: [role], userId: 'x' }, project)).toBe(true);
      expect(
        canSeeProject({ roles: [role], userId: 'x' }, { ...project, projectManagerId: null }),
      ).toBe(true);
    }
  });

  it('a project manager sees the projects they manage and no others', () => {
    expect(canSeeProject({ roles: ['project_manager'], userId: 'pm-1' }, project)).toBe(true);
    expect(canSeeProject({ roles: ['project_manager'], userId: 'pm-2' }, project)).toBe(false);
    expect(
      canSeeProject(
        { roles: ['project_manager'], userId: 'pm-1' },
        { ...project, projectManagerId: null },
      ),
    ).toBe(false);
    expect(canSeeProject({ roles: ['supervisor'], userId: 'pm-1' }, { ...project })).toBe(true);
  });

  it('reports a hidden or missing project as not found', () => {
    const actor = { roles: ['project_manager'], userId: 'pm-2' };
    expect(() => assertProjectVisible(actor, undefined)).toThrow('Not found');
    expect(() => assertProjectVisible(actor, project)).toThrow('Not found');
    expect(() =>
      assertProjectVisible({ roles: ['management'], userId: 'x' }, project),
    ).not.toThrow();
  });
});

describe('input rules', () => {
  it('finds rows and refuses missing ones', () => {
    expect(assertFound('row', 'threshold')).toBe('row');
    expect(() => assertFound(undefined, 'threshold')).toThrow('Not found');
  });

  it('a forecast is money of zero or more with at most 2 decimals', () => {
    for (const ok of ['0', '10', '10.5', '10.50', '1234567.89']) {
      expect(() => assertForecastAmount(ok)).not.toThrow();
    }
    for (const bad of ['', '-1', '1.234', 'abc', '1,000', '1e3', ' 1']) {
      expect(() => assertForecastAmount(bad)).toThrow(/zero or more/);
    }
  });

  it('a company threshold has no project and a project threshold needs one', () => {
    expect(() => assertScopeMatches('company', undefined)).not.toThrow();
    expect(() => assertScopeMatches('project', 'p')).not.toThrow();
    expect(() => assertScopeMatches('company', 'p')).toThrow(/needs one/);
    expect(() => assertScopeMatches('project', undefined)).toThrow(/needs one/);
  });

  it('one live threshold row per scope', () => {
    expect(() => assertThresholdFree(undefined)).not.toThrow();
    expect(() => assertThresholdFree({ id: 'x' })).toThrow(/already exist/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertAny,
  assertAuthor,
  assertCanRead,
  assertFound,
  assertProjectActive,
  assertProjectReachable,
  assertReportAbsent,
  assertUpdated,
  canAccessPhoto,
  canReadProject,
} from './dpr.policy.js';

const supervisor = (projectIds: string[] = []) => ({
  userId: 'u-sup',
  roles: ['supervisor'],
  scopes: projectIds.map((id) => ({ type: 'project' as const, id })),
  permissions: new Set(['dpr.report.read', 'dpr.report.create', 'dpr.report.update_own']),
});
const manager = {
  userId: 'u-pm',
  roles: ['project_manager'],
  scopes: [],
  permissions: new Set(['dpr.report.read', 'dpr.report.review']),
};
const outsider = {
  userId: 'u-x',
  roles: ['nopower'],
  scopes: [],
  permissions: new Set<string>(),
};

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
};

describe('dpr policy', () => {
  it('reports a missing record as not found and a moved version as a conflict', () => {
    expect(assertFound('row', 'report')).toBe('row');
    expect(codeOf(() => assertFound(undefined, 'report'))).toBe('report_not_found');
    expect(assertUpdated('row')).toBe('row');
    expect(codeOf(() => assertUpdated(undefined))).toBe('version_conflict');
  });

  it('limits a supervisor to the projects in scope and lets office roles reach any', () => {
    expect(() => assertProjectReachable(supervisor(['p1']), 'p1')).not.toThrow();
    expect(codeOf(() => assertProjectReachable(supervisor(['p1']), 'p2'))).toBe(
      'project_not_found',
    );
    expect(() => assertProjectReachable(manager, 'p2')).not.toThrow();
  });

  it('needs an active project', () => {
    expect(() => assertProjectActive('active')).not.toThrow();
    for (const status of ['draft', 'on_hold', 'closed']) {
      expect(
        codeOf(() => assertProjectActive(status)),
        status,
      ).toBe('project_not_active');
    }
  });

  it('allows one report per author per project per date', () => {
    expect(() => assertReportAbsent(false)).not.toThrow();
    expect(codeOf(() => assertReportAbsent(true))).toBe('report_exists');
  });

  it('reads need the permission and, for a supervisor, the project in scope', () => {
    expect(canReadProject(supervisor(['p1']), 'p1')).toBe(true);
    expect(canReadProject(supervisor(['p1']), 'p2')).toBe(false);
    expect(canReadProject(manager, 'p2')).toBe(true);
    expect(canReadProject(outsider, 'p1')).toBe(false);
    expect(() => assertCanRead(manager, 'p1')).not.toThrow();
    expect(codeOf(() => assertCanRead(outsider, 'p1'))).toBe('report_not_found');
  });

  it('lets only the author act on their report', () => {
    expect(() => assertAuthor({ userId: 'a' }, 'a')).not.toThrow();
    expect(codeOf(() => assertAuthor({ userId: 'b' }, 'a'))).toBe('not_your_report');
  });

  it('checks that the caller holds one of the permissions', () => {
    expect(() => assertAny(manager, ['dpr.report.review', 'x'])).not.toThrow();
    expect(codeOf(() => assertAny(outsider, ['dpr.report.review']))).toBe('forbidden');
  });

  describe('photo access', () => {
    const report = (status: 'draft' | 'submitted' | 'reopened', authorId = 'u-sup') => ({
      projectId: 'p1',
      authorId,
      status,
    });
    const allow = (
      caller: Parameters<typeof canAccessPhoto>[0]['caller'],
      operation: 'upload' | 'read' | 'remove',
      subject: ReturnType<typeof report> | undefined,
    ) => canAccessPhoto({ caller, operation, report: subject });

    it('refuses a report that does not exist', () => {
      expect(allow(manager, 'read', undefined)).toBe(false);
    });

    it('lets readers read, in scope', () => {
      expect(allow(manager, 'read', report('submitted'))).toBe(true);
      expect(allow(supervisor(['p1']), 'read', report('submitted'))).toBe(true);
      expect(allow(supervisor(['p2']), 'read', report('submitted'))).toBe(false);
      expect(allow(outsider, 'read', report('draft'))).toBe(false);
    });

    it('lets the author add and remove photos while the report is editable', () => {
      for (const operation of ['upload', 'remove'] as const) {
        expect(allow(supervisor(['p1']), operation, report('draft'))).toBe(true);
        expect(allow(supervisor(['p1']), operation, report('reopened'))).toBe(true);
        expect(allow(supervisor(['p1']), operation, report('submitted'))).toBe(false);
        expect(allow(supervisor(['p1']), operation, report('draft', 'someone-else'))).toBe(false);
        expect(allow(manager, operation, report('draft', 'u-pm'))).toBe(false);
      }
    });
  });
});

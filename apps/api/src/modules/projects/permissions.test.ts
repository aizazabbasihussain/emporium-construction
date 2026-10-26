import { projectsPermissionGrants, projectsPermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectsKit, type ProjectsKit } from './test-support.js';

let kit: ProjectsKit;
beforeAll(async () => {
  kit = await createProjectsKit();
}, 60_000);
afterAll(() => kit.close());

describe('projects permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(projectsPermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...projectsPermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: budget and status for the office, tasks also for supervisors', () => {
    const office = ['management', 'project_manager'];
    for (const key of ['projects.budget.manage', 'projects.project.status'] as const) {
      expect([...projectsPermissionGrants[key]].sort()).toEqual(office);
    }
    expect([...projectsPermissionGrants['projects.task.manage']].sort()).toEqual([
      'management',
      'project_manager',
      'supervisor',
    ]);
    expect([...projectsPermissionGrants['projects.cost.read']].sort()).toEqual([
      'accountant',
      'management',
      'project_manager',
    ]);
  });

  it('cost posting belongs to no role: system calls only', () => {
    expect(projectsPermissionGrants['projects.cost.post']).toEqual([]);
  });

  it('every projects table has row level security and the view is read through the invoker', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'prj\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'prj_budget_lines',
      'prj_cost_entries',
      'prj_projects',
      'prj_supervisor_assignments',
      'prj_tasks',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
    const [view] = await kit.db.query<{ reloptions: string[] }>(
      `select reloptions from pg_class where relname = 'prj_v_cost_summary'`,
    );
    expect(view?.reloptions).toContain('security_invoker=true');
  });
});

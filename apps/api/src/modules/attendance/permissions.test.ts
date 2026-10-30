import { attendancePermissionGrants, attendancePermissions } from '@emporium/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAttendanceKit, type AttendanceKit } from './test-support.js';

let kit: AttendanceKit;
beforeAll(async () => {
  kit = await createAttendanceKit();
}, 60_000);
afterAll(() => kit.close());

describe('attendance permissions (spec section 6)', () => {
  it('grants in the migration match the shared grant table', async () => {
    for (const permission of Object.values(attendancePermissions)) {
      const rows = await kit.db.query<{ role_code: string }>(
        'select role_code from sys_role_permissions where permission_code = $1',
        [permission],
      );
      expect(rows.map((r) => r.role_code).sort(), permission).toEqual(
        [...attendancePermissionGrants[permission]].sort(),
      );
    }
  });

  it('follows the spec: supervisors write and read, managers unlock, finance only reads', () => {
    const grants = attendancePermissionGrants;
    expect(grants['attendance.sheet.create']).toEqual(['supervisor', 'project_manager']);
    expect(grants['attendance.sheet.update']).toEqual(['supervisor', 'project_manager']);
    expect(grants['attendance.sheet.read']).toEqual([
      'supervisor',
      'project_manager',
      'management',
      'accountant',
    ]);
    expect(grants['attendance.sheet.unlock']).toEqual(['management', 'project_manager']);
  });

  it('every attendance table has row level security', async () => {
    const tables = await kit.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'att\\_%'`,
    );
    expect(tables.map((t) => t.relname).sort()).toEqual([
      'att_allocations',
      'att_entries',
      'att_sheets',
      'att_worker_days',
    ]);
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });

  it('seeds the approval rule: the project manager approves an attendance sheet', async () => {
    const rules = await kit.db.query<{ role_code: string; min_approvers: number }>(
      `select s.role_code, s.min_approvers from apr_rules r join apr_rule_steps s on s.rule_id = r.id
        where r.doc_type = 'attendance_sheet'`,
    );
    expect(rules).toEqual([{ role_code: 'project_manager', min_approvers: 1 }]);
  });

  it('knows the H-11 defaults as editable settings', async () => {
    const value = async (key: string) => (await kit.platform.settings.get(kit.db, key)).value;
    expect(await value('attendance.overtime_multiplier')).toBe('1.5');
    expect(await value('workforce.working_days_basis')).toBe(26);
    expect(await value('labour_cost_code')).toBe('200');
  });
});

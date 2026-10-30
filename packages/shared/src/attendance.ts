/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the attendance module. */
export const attendancePermissions = {
  sheetCreate: 'attendance.sheet.create',
  sheetUpdate: 'attendance.sheet.update',
  sheetRead: 'attendance.sheet.read',
  sheetUnlock: 'attendance.sheet.unlock',
} as const;

export type AttendancePermission =
  (typeof attendancePermissions)[keyof typeof attendancePermissions];

/** Roles that receive each permission (spec P1-17 section 6). Approval goes through the engine. */
export const attendancePermissionGrants: Record<AttendancePermission, readonly string[]> = {
  'attendance.sheet.create': ['supervisor', 'project_manager'],
  'attendance.sheet.update': ['supervisor', 'project_manager'],
  'attendance.sheet.read': ['supervisor', 'project_manager', 'management', 'accountant'],
  'attendance.sheet.unlock': ['management', 'project_manager'],
};

export const sheetStatuses = ['draft', 'submitted', 'approved', 'rejected', 'unlocked'] as const;
export type SheetStatus = (typeof sheetStatuses)[number];

export const entryStatuses = [
  'present',
  'half_day',
  'absent',
  'leave_paid',
  'leave_unpaid',
  'off',
] as const;
export type EntryStatus = (typeof entryStatuses)[number];

/** The approval document type of a submitted sheet. */
export const attendanceSheetDocType = 'attendance_sheet';

/** Settings of this module (H-11 and BR-3). */
export const attendanceSettingKeys = {
  overtimeMultiplier: 'attendance.overtime_multiplier',
  labourCostCode: 'labour_cost_code',
} as const;

/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the workforce module. */
export const workforcePermissions = {
  workerRead: 'workforce.worker.read',
  workerManage: 'workforce.worker.manage',
  rateRead: 'workforce.rate.read',
  rateManage: 'workforce.rate.manage',
  teamManage: 'workforce.team.manage',
} as const;

export type WorkforcePermission = (typeof workforcePermissions)[keyof typeof workforcePermissions];

/** Roles that receive each permission (spec P1-16 section 6). */
export const workforcePermissionGrants: Record<WorkforcePermission, readonly string[]> = {
  'workforce.worker.read': ['supervisor', 'project_manager', 'management', 'accountant'],
  'workforce.worker.manage': ['management', 'accountant'],
  'workforce.rate.read': ['accountant', 'management'],
  'workforce.rate.manage': ['accountant', 'management'],
  'workforce.team.manage': ['management', 'project_manager'],
};

export const employmentTypes = ['permanent', 'daily', 'contract'] as const;
export type EmploymentType = (typeof employmentTypes)[number];

export const workerStatuses = ['active', 'inactive'] as const;
export type WorkerStatus = (typeof workerStatuses)[number];

export const payBases = ['daily_rate', 'monthly_salary'] as const;
export type PayBasis = (typeof payBases)[number];

/** The setting that holds the working-days basis of a month (H-11). 0 means not decided yet. */
export const workforceSettingKeys = {
  workingDaysBasis: 'workforce.working_days_basis',
} as const;

/** The number series of worker and team codes. */
export const workerSeries = 'worker';
export const teamSeries = 'team';

/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the worker portal. */
export const workerportalPermissions = {
  selfRead: 'workerportal.self.read',
  accountManage: 'workerportal.account.manage',
} as const;

export type WorkerportalPermission =
  (typeof workerportalPermissions)[keyof typeof workerportalPermissions];

/** Roles that receive each permission (spec P1-22 section 6). */
export const workerportalPermissionGrants: Record<WorkerportalPermission, readonly string[]> = {
  'workerportal.self.read': ['worker'],
  'workerportal.account.manage': ['admin'],
};

/** The role a worker's login holds. */
export const WORKER_ROLE = 'worker';

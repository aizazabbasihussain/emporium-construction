/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the importer. */
export const importerPermissions = {
  batchRun: 'importer.batch.run',
  batchForce: 'importer.batch.force',
  batchRead: 'importer.batch.read',
} as const;

export type ImporterPermission = (typeof importerPermissions)[keyof typeof importerPermissions];

/** Roles that receive each importer permission (spec P0-04 section 6). */
export const importerPermissionGrants: Record<ImporterPermission, readonly string[]> = {
  'importer.batch.run': ['admin', 'accountant'],
  'importer.batch.force': ['admin'],
  'importer.batch.read': ['admin', 'accountant', 'management'],
};

export const importBatchStatuses = [
  'dry_run_ok',
  'dry_run_failed',
  'committed',
  'rolled_back',
] as const;
export type ImportBatchStatus = (typeof importBatchStatuses)[number];

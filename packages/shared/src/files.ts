/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the files module. */
export const filesPermissions = {
  upload: 'files.attachment.upload',
  read: 'files.attachment.read',
  remove: 'files.attachment.remove',
} as const;

export type FilesPermission = (typeof filesPermissions)[keyof typeof filesPermissions];

const everyone = [
  'admin',
  'management',
  'project_manager',
  'procurement',
  'storekeeper',
  'supervisor',
  'accountant',
  'service_coordinator',
  'estimator',
] as const;

/** Roles that receive each files permission (spec P1-04 section 6); the owning entity's check applies on top. */
export const filesPermissionGrants: Record<FilesPermission, readonly string[]> = {
  'files.attachment.upload': everyone,
  'files.attachment.read': everyone,
  'files.attachment.remove': ['admin', 'management', 'project_manager', 'accountant'],
};

/** What a registered entity check is asked to decide. */
export const fileOperations = ['upload', 'read', 'remove'] as const;
export type FileOperation = (typeof fileOperations)[number];

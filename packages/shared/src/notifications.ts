/** Permission codes owned by the notifications module. */
export const notificationsPermissions = {
  readOwn: 'notifications.read.own',
} as const;

export type NotificationsPermission =
  (typeof notificationsPermissions)[keyof typeof notificationsPermissions];

/** Every user reads their own notifications; the migration also grants it to roles created later. */
export const notificationsPermissionGrants: Record<NotificationsPermission, readonly string[]> = {
  'notifications.read.own': [
    'admin',
    'management',
    'project_manager',
    'procurement',
    'storekeeper',
    'supervisor',
    'accountant',
    'service_coordinator',
    'estimator',
  ],
};

/**
 * Template code to i18n key (BR-9). Later modules register their own templates at startup;
 * these are the ones the notifications module itself needs for approval events (BR-10).
 */
export const approvalNotificationTemplates = {
  'approval.requested': 'notifications.templates.approvalRequested',
  'approval.progressed': 'notifications.templates.approvalProgressed',
  'approval.approved': 'notifications.templates.approvalApproved',
  'approval.rejected': 'notifications.templates.approvalRejected',
  'approval.returned': 'notifications.templates.approvalReturned',
  'approval.cancelled': 'notifications.templates.approvalCancelled',
} as const;

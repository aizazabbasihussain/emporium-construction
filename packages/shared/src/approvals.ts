/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the approvals module. */
export const approvalsPermissions = {
  inboxRead: 'approvals.inbox.read',
  ruleManage: 'approvals.rule.manage',
  requestRead: 'approvals.request.read',
} as const;

export type ApprovalsPermission = (typeof approvalsPermissions)[keyof typeof approvalsPermissions];

/** Roles that receive each approvals permission (spec P1-03 section 6). */
export const approvalsPermissionGrants: Record<ApprovalsPermission, readonly string[]> = {
  'approvals.inbox.read': ['admin', 'management', 'project_manager', 'procurement', 'accountant'],
  'approvals.rule.manage': ['admin', 'management'],
  'approvals.request.read': [
    'admin',
    'management',
    'project_manager',
    'procurement',
    'accountant',
    'storekeeper',
    'supervisor',
    'service_coordinator',
    'estimator',
  ],
};

export const approvalStatuses = [
  'pending',
  'approved',
  'rejected',
  'returned',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const approvalActions = ['approve', 'reject', 'return'] as const;
export type ApprovalAction = (typeof approvalActions)[number];

/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the valuation module. */
export const valuationPermissions = {
  policyRead: 'valuation.policy.read',
  policyRequest: 'valuation.policy.request',
  transitionRun: 'valuation.transition.run',
  reportRead: 'valuation.report.read',
} as const;

export type ValuationPermission = (typeof valuationPermissions)[keyof typeof valuationPermissions];

/** Roles that receive each valuation permission (spec P1-13 section 6); the admin sees everything (H-10). */
export const valuationPermissionGrants: Record<ValuationPermission, readonly string[]> = {
  'valuation.policy.read': ['admin', 'accountant', 'management', 'storekeeper'],
  'valuation.policy.request': ['accountant'],
  'valuation.transition.run': ['accountant', 'admin'],
  'valuation.report.read': ['admin', 'accountant', 'management'],
};

export const valuationMethods = ['weighted_average', 'fifo'] as const;
export type ValuationMethod = (typeof valuationMethods)[number];

export const policyScopes = ['company', 'category'] as const;
export type PolicyScope = (typeof policyScopes)[number];

export const policyStatuses = ['pending_approval', 'active', 'superseded', 'rejected'] as const;
export type PolicyStatus = (typeof policyStatuses)[number];

export const movementTypes = [
  'receipt',
  'issue',
  'transfer_out',
  'transfer_in',
  'return',
  'transition',
] as const;
export type MovementType = (typeof movementTypes)[number];

/** The approval document type of a policy change (spec P1-13 BR-3). */
export const valuationPolicyDocType = 'valuation_policy';

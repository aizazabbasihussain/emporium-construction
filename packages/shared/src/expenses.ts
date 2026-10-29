/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the expenses module. */
export const expensesPermissions = {
  claimCreate: 'expenses.claim.create',
  claimReadOwn: 'expenses.claim.read_own',
  claimReadAll: 'expenses.claim.read_all',
  claimPost: 'expenses.claim.post',
  claimReverse: 'expenses.claim.reverse',
  advanceIssue: 'expenses.advance.issue',
  categoryManage: 'expenses.category.manage',
} as const;

export type ExpensesPermission = (typeof expensesPermissions)[keyof typeof expensesPermissions];

const claimants = ['supervisor', 'project_manager', 'storekeeper'] as const;

/** Roles that receive each permission (spec P1-14 section 6). */
export const expensesPermissionGrants: Record<ExpensesPermission, readonly string[]> = {
  'expenses.claim.create': claimants,
  'expenses.claim.read_own': claimants,
  'expenses.claim.read_all': ['accountant', 'management'],
  'expenses.claim.post': ['accountant'],
  'expenses.claim.reverse': ['accountant'],
  'expenses.advance.issue': ['accountant'],
  'expenses.category.manage': ['accountant'],
};

export const claimStatuses = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'returned',
  'posted',
  'cancelled',
] as const;
export type ClaimStatus = (typeof claimStatuses)[number];

export const advanceStatuses = ['issued', 'settled', 'cancelled'] as const;
export type AdvanceStatus = (typeof advanceStatuses)[number];

export const claimCostObjectTypes = ['project', 'overhead'] as const;
export type ClaimCostObjectType = (typeof claimCostObjectTypes)[number];

/** The approval document type of an expense claim (H-09 matrix) and the file entity type of its receipts. */
export const expenseClaimDocType = 'expense_claim';
export const expenseClaimEntityType = 'exp_claim';

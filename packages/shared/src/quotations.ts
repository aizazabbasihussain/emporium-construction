/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the quotations module. */
export const quotationsPermissions = {
  read: 'quotations.quotation.read',
  create: 'quotations.quotation.create',
  update: 'quotations.quotation.update',
  submit: 'quotations.quotation.submit',
  issue: 'quotations.quotation.issue',
  accept: 'quotations.quotation.accept',
  reject: 'quotations.quotation.reject',
  marginRead: 'quotations.margin.read',
} as const;

export type QuotationsPermission =
  (typeof quotationsPermissions)[keyof typeof quotationsPermissions];

const office = ['management', 'project_manager'] as const;

/** Roles that receive each permission (spec P1-08 section 6). */
export const quotationsPermissionGrants: Record<QuotationsPermission, readonly string[]> = {
  'quotations.quotation.read': [...office, 'accountant'],
  'quotations.quotation.create': office,
  'quotations.quotation.update': office,
  'quotations.quotation.submit': office,
  'quotations.quotation.issue': office,
  'quotations.quotation.accept': office,
  'quotations.quotation.reject': office,
  'quotations.margin.read': ['management', 'accountant'],
};

export const quotationStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'issued',
  'accepted',
  'rejected',
  'expired',
  'superseded',
] as const;
export type QuotationStatus = (typeof quotationStatuses)[number];

export const stageBases = ['percent', 'amount'] as const;
export type StageBasis = (typeof stageBases)[number];

/** The approval document type of a quotation (H-09 matrix) and the file entity type of its acceptance proof. */
export const quotationDocType = 'quotation';
export const quotationEntityType = 'qte_quotation';

/** The margin floor, in percent, below which the approval request is flagged (H-09: none for now). */
export const quotationSettingKeys = {
  marginFloorPercent: 'quotations.margin_floor_percent',
} as const;

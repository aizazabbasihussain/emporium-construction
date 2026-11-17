/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the tax module. */
export const taxPermissions = {
  ruleRead: 'tax.rule.read',
  ruleManage: 'tax.rule.manage',
  reportRead: 'tax.report.read',
} as const;

export type TaxPermission = (typeof taxPermissions)[keyof typeof taxPermissions];

/** Roles that receive each tax permission (spec P2-01 section 6); the admin sees everything (H-10). */
export const taxPermissionGrants: Record<TaxPermission, readonly string[]> = {
  'tax.rule.read': ['admin', 'accountant', 'management'],
  'tax.rule.manage': ['accountant'],
  'tax.report.read': ['admin', 'accountant', 'management'],
};

export const supplyKinds = ['goods', 'services'] as const;
export type SupplyKind = (typeof supplyKinds)[number];

export const taxRegions = ['islamabad', 'punjab'] as const;
export type TaxRegion = (typeof taxRegions)[number];

export const withholdingDirections = ['client_withholds', 'we_withhold'] as const;
export type WithholdingDirection = (typeof withholdingDirections)[number];

export const withholdingBases = ['on_invoice_total', 'on_tax_amount', 'on_base'] as const;
export type WithholdingBase = (typeof withholdingBases)[number];

export const taxRoundingModes = ['per_line', 'per_document'] as const;
export type TaxRoundingMode = (typeof taxRoundingModes)[number];

/** A rule is requested, then approved (active) or rejected; an approved successor closes its predecessor. */
export const taxRuleStatuses = ['pending_approval', 'active', 'rejected'] as const;
export type TaxRuleStatus = (typeof taxRuleStatuses)[number];

export const taxRuleKinds = ['sales', 'withholding', 'region'] as const;
export type TaxRuleKind = (typeof taxRuleKinds)[number];

/** The approval document type of every tax rule change (spec P2-01 BR-6). */
export const taxRuleDocType = 'tax_rule';

/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the variations module. */
export const variationsPermissions = {
  read: 'variations.variation.read',
  create: 'variations.variation.create',
  update: 'variations.variation.update',
  clientApprove: 'variations.variation.client_approve',
} as const;

export type VariationsPermission =
  (typeof variationsPermissions)[keyof typeof variationsPermissions];

const office = ['management', 'project_manager'] as const;

/** Roles that receive each permission (spec P1-10 section 6). A supervisor may also create drafts. */
export const variationsPermissionGrants: Record<VariationsPermission, readonly string[]> = {
  'variations.variation.read': office,
  'variations.variation.create': [...office, 'supervisor'],
  'variations.variation.update': office,
  'variations.variation.client_approve': office,
};

export const variationStatuses = [
  'draft',
  'pending_internal_approval',
  'submitted_to_client',
  'client_approved',
  'client_rejected',
  'cancelled',
] as const;
export type VariationStatus = (typeof variationStatuses)[number];

/** The approval document type of a variation (H-09 matrix) and the file entity type of the client's document. */
export const variationDocType = 'variation';
export const variationEntityType = 'var_variation';

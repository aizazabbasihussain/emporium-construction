/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the estimation module. */
export const estimationPermissions = {
  templateManage: 'estimation.template.manage',
  estimateRead: 'estimation.estimate.read',
  estimateCreate: 'estimation.estimate.create',
  estimateUpdate: 'estimation.estimate.update',
  estimateLock: 'estimation.estimate.lock',
} as const;

export type EstimationPermission =
  (typeof estimationPermissions)[keyof typeof estimationPermissions];

const office = ['admin', 'management', 'project_manager'] as const;

/** Roles that receive each estimation permission (spec P1-07 section 6); the accountant reads only. */
export const estimationPermissionGrants: Record<EstimationPermission, readonly string[]> = {
  'estimation.template.manage': office,
  'estimation.estimate.read': [...office, 'accountant'],
  'estimation.estimate.create': office,
  'estimation.estimate.update': office,
  'estimation.estimate.lock': office,
};

export const estimateWorkTypes = [
  'new_build',
  'boundary_wall',
  'renovation',
  'demolition',
  'restructure',
  'maintenance',
  'room',
  'slab',
  'other',
] as const;
export type EstimateWorkType = (typeof estimateWorkTypes)[number];

export const estimateSectors = ['government', 'private'] as const;
export type EstimateSector = (typeof estimateSectors)[number];

export const estimateLineKinds = [
  'material',
  'labour',
  'subcontract',
  'equipment',
  'disposal',
  'salvage_credit',
] as const;
export type EstimateLineKind = (typeof estimateLineKinds)[number];

export const estimateSuppliers = ['company', 'client'] as const;
export type EstimateSupplier = (typeof estimateSuppliers)[number];

/** The typed settings that seed a new estimate (H-15 defaults; editable in the settings screen). */
export const estimationSettingKeys = {
  overheadPercent: 'estimation.overhead_percent',
  contingencyPercent: 'estimation.contingency_percent',
  targetMarginPercent: 'estimation.target_margin_percent',
} as const;

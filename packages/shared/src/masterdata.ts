/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the master data module. */
export const masterdataPermissions = {
  companyManage: 'master.company.manage',
  referenceRead: 'master.reference.read',
  partyRead: 'master.party.read',
  partyManage: 'master.party.manage',
  itemRead: 'master.item.read',
  itemManage: 'master.item.manage',
  costcodeManage: 'master.costcode.manage',
  priceRead: 'master.price.read',
  priceManage: 'master.price.manage',
} as const;

export type MasterdataPermission =
  (typeof masterdataPermissions)[keyof typeof masterdataPermissions];

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

const office = [
  'admin',
  'management',
  'project_manager',
  'procurement',
  'accountant',
  'service_coordinator',
  'estimator',
] as const;

/** Roles that receive each master data permission (spec P1-05 section 6). */
export const masterdataPermissionGrants: Record<MasterdataPermission, readonly string[]> = {
  'master.company.manage': ['admin'],
  'master.reference.read': everyone,
  'master.party.read': office,
  'master.party.manage': ['admin', 'management', 'project_manager', 'procurement', 'accountant'],
  'master.item.read': everyone,
  'master.item.manage': ['admin', 'management', 'procurement'],
  'master.costcode.manage': ['admin', 'management', 'accountant'],
  'master.price.read': [
    'admin',
    'management',
    'project_manager',
    'procurement',
    'accountant',
    'estimator',
  ],
  'master.price.manage': ['admin', 'procurement'],
};

export const partyRoles = ['client', 'vendor', 'subcontractor', 'labour_contractor'] as const;
export type PartyRole = (typeof partyRoles)[number];

export const partyStatuses = ['active', 'inactive'] as const;
export type PartyStatus = (typeof partyStatuses)[number];

export const unitKinds = ['count', 'length', 'area', 'volume', 'weight', 'time', 'lump'] as const;
export type UnitKind = (typeof unitKinds)[number];

export const itemKinds = ['material', 'consumable', 'service', 'labour', 'equipment'] as const;
export type ItemKind = (typeof itemKinds)[number];

export const taxKinds = ['goods', 'services'] as const;
export type DefaultTaxKind = (typeof taxKinds)[number];

export const costCodeKinds = [
  'material',
  'labour',
  'subcontract',
  'equipment',
  'overhead',
] as const;
export type CostCodeKind = (typeof costCodeKinds)[number];

export const regions = ['islamabad', 'punjab'] as const;
export type Region = (typeof regions)[number];

export const registrationTypes = ['ntn', 'strn', 'pra', 'other'] as const;
export type RegistrationType = (typeof registrationTypes)[number];

/** Entities whose records other modules may reference (BR-8). */
export const referenceableEntities = ['party', 'item'] as const;
export type ReferenceableEntity = (typeof referenceableEntities)[number];

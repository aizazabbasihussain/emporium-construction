/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the CRM module. */
export const crmPermissions = {
  leadRead: 'crm.lead.read',
  leadCreate: 'crm.lead.create',
  leadUpdate: 'crm.lead.update',
  leadReopen: 'crm.lead.reopen',
  visitManage: 'crm.visit.manage',
  followupManage: 'crm.followup.manage',
} as const;

export type CrmPermission = (typeof crmPermissions)[keyof typeof crmPermissions];

const sales = ['admin', 'management', 'project_manager', 'service_coordinator'] as const;

/** Roles that receive each CRM permission (spec P1-06 section 6); the accountant reads only (BR-9). */
export const crmPermissionGrants: Record<CrmPermission, readonly string[]> = {
  'crm.lead.read': [...sales, 'accountant'],
  'crm.lead.create': sales,
  'crm.lead.update': sales,
  'crm.lead.reopen': ['admin', 'management'],
  'crm.visit.manage': sales,
  'crm.followup.manage': sales,
};

export const leadWorkTypes = [
  'new_build',
  'boundary_wall',
  'renovation',
  'demolition',
  'restructure',
  'maintenance',
  'other',
] as const;
export type LeadWorkType = (typeof leadWorkTypes)[number];

export const leadSectors = ['government', 'private'] as const;
export type LeadSector = (typeof leadSectors)[number];

export const stageKinds = ['open', 'won', 'lost'] as const;
export type StageKind = (typeof stageKinds)[number];

export const followUpStatuses = ['open', 'done', 'cancelled'] as const;
export type FollowUpStatus = (typeof followUpStatuses)[number];

/** File attachments of a site visit use this entity type with the shared uploader. */
export const siteVisitEntityType = 'crm_site_visit';

export const crmNotificationTemplates = {
  'crm.followup.due': 'notifications.templates.crmFollowUpDue',
} as const;

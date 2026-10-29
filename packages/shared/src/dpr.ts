/** Permission codes `<module>.<resource>.<action>` (constitution 7.2) owned by the dpr module. */
export const dprPermissions = {
  reportCreate: 'dpr.report.create',
  // The action part of a permission code allows letters, digits and underscores, so the spec's
  // update-own is spelled update_own.
  reportUpdateOwn: 'dpr.report.update_own',
  reportRead: 'dpr.report.read',
  reportReview: 'dpr.report.review',
} as const;

export type DprPermission = (typeof dprPermissions)[keyof typeof dprPermissions];

/** Roles that receive each permission (spec P1-15 section 6). */
export const dprPermissionGrants: Record<DprPermission, readonly string[]> = {
  'dpr.report.create': ['supervisor', 'project_manager'],
  'dpr.report.update_own': ['supervisor', 'project_manager'],
  'dpr.report.read': ['supervisor', 'project_manager', 'management', 'accountant'],
  'dpr.report.review': ['project_manager', 'management'],
};

export const dprStatuses = ['draft', 'submitted', 'reviewed', 'reopened'] as const;
export type DprStatus = (typeof dprStatuses)[number];

export const dprWeathers = ['clear', 'cloudy', 'rain', 'extreme_heat', 'other'] as const;
export type DprWeather = (typeof dprWeathers)[number];

/** The file entity type of the photos of a report. */
export const dprReportEntityType = 'dpr_report';

export const dprSettingKeys = {
  photoRequired: 'dpr_photo_required',
  siteHolidays: 'site_holidays',
} as const;

/** Notification templates of this module and the i18n key that renders each. */
export const dprNotificationTemplates = {
  'dpr.missing': 'notifications.templates.dprMissing',
} as const;

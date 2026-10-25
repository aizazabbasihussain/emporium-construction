import {
  approvalsPermissions,
  crmPermissions,
  estimationPermissions,
  identityPermissions,
  importerPermissions,
  masterdataPermissions,
  notificationsPermissions,
  platformPermissions,
  valuationPermissions,
} from '@emporium/shared';

export interface NavItem {
  path: string;
  /** i18n key of the label. */
  label: string;
  /** Permission needed to see the item and open the page (BR-10); none means any signed-in user. */
  permission?: string;
}

/** Module specs append their pages here with the permission that opens them. */
export const navItems: readonly NavItem[] = [
  { path: '/', label: 'nav.home' },
  { path: '/admin/users', label: 'nav.users', permission: identityPermissions.userRead },
  { path: '/admin/roles', label: 'nav.roles', permission: identityPermissions.userRead },
  { path: '/admin/audit', label: 'nav.audit', permission: platformPermissions.auditRead },
  {
    path: '/admin/number-series',
    label: 'nav.series',
    permission: platformPermissions.seriesManage,
  },
  { path: '/approvals', label: 'nav.approvals', permission: approvalsPermissions.inboxRead },
  {
    path: '/admin/approval-rules',
    label: 'nav.approvalRules',
    permission: approvalsPermissions.ruleManage,
  },
  {
    path: '/notifications',
    label: 'nav.notifications',
    permission: notificationsPermissions.readOwn,
  },
  { path: '/imports', label: 'nav.imports', permission: importerPermissions.batchRead },
  {
    path: '/master/company',
    label: 'nav.company',
    permission: masterdataPermissions.referenceRead,
  },
  { path: '/master/parties', label: 'nav.parties', permission: masterdataPermissions.partyRead },
  { path: '/master/items', label: 'nav.items', permission: masterdataPermissions.itemRead },
  { path: '/master/units', label: 'nav.units', permission: masterdataPermissions.referenceRead },
  {
    path: '/master/cost-codes',
    label: 'nav.costCodes',
    permission: masterdataPermissions.referenceRead,
  },
  {
    path: '/master/locations',
    label: 'nav.locations',
    permission: masterdataPermissions.referenceRead,
  },
  {
    path: '/master/vendor-prices',
    label: 'nav.vendorPrices',
    permission: masterdataPermissions.priceRead,
  },
  { path: '/crm/leads', label: 'nav.crmLeads', permission: crmPermissions.leadRead },
  { path: '/crm/follow-ups', label: 'nav.crmFollowUps', permission: crmPermissions.leadRead },
  {
    path: '/estimation/templates',
    label: 'nav.estimationTemplates',
    permission: estimationPermissions.estimateRead,
  },
  {
    path: '/estimation/estimates',
    label: 'nav.estimates',
    permission: estimationPermissions.estimateRead,
  },
  {
    path: '/valuation/settings',
    label: 'nav.valuationSettings',
    permission: valuationPermissions.policyRead,
  },
  {
    path: '/valuation/report',
    label: 'nav.valuationReport',
    permission: valuationPermissions.reportRead,
  },
  {
    path: '/valuation/transitions',
    label: 'nav.valuationTransitions',
    permission: valuationPermissions.reportRead,
  },
  {
    path: '/admin/settings',
    label: 'nav.settings',
    permission: platformPermissions.settingsManage,
  },
];

import { identityPermissions, importerPermissions, platformPermissions } from '@emporium/shared';

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
  { path: '/imports', label: 'nav.imports', permission: importerPermissions.batchRead },
  {
    path: '/admin/settings',
    label: 'nav.settings',
    permission: platformPermissions.settingsManage,
  },
];

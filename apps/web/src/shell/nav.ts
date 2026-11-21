import {
  approvalsPermissions,
  attendancePermissions,
  crmPermissions,
  dprPermissions,
  estimationPermissions,
  expensesPermissions,
  identityPermissions,
  importerPermissions,
  inventoryPermissions,
  masterdataPermissions,
  quotationsPermissions,
  notificationsPermissions,
  platformPermissions,
  procurementPermissions,
  projectsPermissions,
  reportsPermissions,
  billingPermissions,
  cashbookPermissions,
  receivablesPermissions,
  payablesPermissions,
  payrollPermissions,
  subcontractsPermissions,
  taxPermissions,
  valuationPermissions,
  wagesPermissions,
  workerportalPermissions,
  workforcePermissions,
} from '@emporium/shared';

export interface NavItem {
  path: string;
  /** i18n key of the label. */
  label: string;
  /** Permission needed to see the item and open the page (BR-10); none means any signed-in user. */
  permission?: string;
  /** Alternative to `permission`: the item shows when the user holds any one of these. */
  anyPermission?: readonly string[];
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
    path: '/quotations',
    label: 'nav.quotations',
    permission: quotationsPermissions.read,
  },
  {
    path: '/projects',
    label: 'nav.projects',
    permission: projectsPermissions.read,
  },
  {
    path: '/procurement/requisitions',
    label: 'nav.requisitions',
    permission: procurementPermissions.requisitionRead,
  },
  {
    path: '/procurement/purchase-orders',
    label: 'nav.purchaseOrders',
    permission: procurementPermissions.poRead,
  },
  {
    path: '/inventory/stock',
    label: 'nav.inventoryStock',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/inventory/issue',
    label: 'nav.inventoryIssue',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/inventory/transfers',
    label: 'nav.inventoryTransfers',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/inventory/counts',
    label: 'nav.inventoryCounts',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/inventory/client-material',
    label: 'nav.inventoryClient',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/inventory/ledger',
    label: 'nav.inventoryLedger',
    permission: inventoryPermissions.stockRead,
  },
  {
    path: '/expenses/claims',
    label: 'nav.expenseClaims',
    permission: expensesPermissions.claimReadOwn,
  },
  {
    path: '/expenses/all-claims',
    label: 'nav.expenseAllClaims',
    permission: expensesPermissions.claimReadAll,
  },
  {
    path: '/expenses/queue',
    label: 'nav.expenseQueue',
    permission: expensesPermissions.claimPost,
  },
  {
    path: '/expenses/advances',
    label: 'nav.expenseAdvances',
    permission: expensesPermissions.advanceIssue,
  },
  {
    path: '/expenses/custodians',
    label: 'nav.expenseCustodians',
    permission: expensesPermissions.claimReadAll,
  },
  {
    path: '/expenses/categories',
    label: 'nav.expenseCategories',
    permission: expensesPermissions.categoryManage,
  },
  {
    path: '/dpr/reports',
    label: 'nav.dprReports',
    permission: dprPermissions.reportRead,
  },
  {
    path: '/dpr/missing',
    label: 'nav.dprMissing',
    permission: dprPermissions.reportReview,
  },
  {
    path: '/workforce/workers',
    label: 'nav.workforceWorkers',
    permission: workforcePermissions.workerRead,
  },
  {
    path: '/workforce/my-teams',
    label: 'nav.workforceMine',
    permission: workforcePermissions.workerRead,
  },
  {
    path: '/workforce/board',
    label: 'nav.workforceBoard',
    permission: workforcePermissions.teamManage,
  },
  {
    path: '/attendance/grid',
    label: 'nav.attendanceGrid',
    permission: attendancePermissions.sheetRead,
  },
  {
    path: '/attendance/sheets',
    label: 'nav.attendanceSheets',
    permission: attendancePermissions.sheetRead,
  },
  {
    path: '/attendance/missing',
    label: 'nav.attendanceMissing',
    permission: attendancePermissions.sheetRead,
  },
  { path: '/wages/periods', label: 'nav.wagesPeriods', permission: wagesPermissions.periodRead },
  { path: '/wages/advances', label: 'nav.wagesAdvances', permission: wagesPermissions.periodRead },
  {
    path: '/me/worker/attendance',
    label: 'nav.workerAttendance',
    permission: workerportalPermissions.selfRead,
  },
  {
    path: '/me/worker/advances',
    label: 'nav.workerAdvances',
    permission: workerportalPermissions.selfRead,
  },
  {
    path: '/me/worker/wages',
    label: 'nav.workerWages',
    permission: workerportalPermissions.selfRead,
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
    path: '/billing/invoices',
    label: 'nav.billingInvoices',
    permission: billingPermissions.invoiceRead,
  },
  {
    path: '/cashbook/accounts',
    label: 'nav.cashbookAccounts',
    permission: cashbookPermissions.txnRead,
  },
  { path: '/cashbook/book', label: 'nav.cashbookBook', permission: cashbookPermissions.txnRead },
  {
    path: '/cashbook/position',
    label: 'nav.cashbookPosition',
    permission: cashbookPermissions.txnRead,
  },
  {
    path: '/cashbook/needs-tag',
    label: 'nav.cashbookNeedsTag',
    permission: cashbookPermissions.txnRead,
  },
  {
    path: '/cashbook/reconciliations',
    label: 'nav.cashbookReconciliations',
    permission: cashbookPermissions.txnRead,
  },
  {
    path: '/cashbook/pending',
    label: 'nav.cashbookPending',
    permission: cashbookPermissions.txnRead,
  },
  {
    path: '/receivables/receipts/new',
    label: 'nav.receivablesReceipt',
    permission: receivablesPermissions.receiptCreate,
  },
  {
    path: '/receivables/pdcs',
    label: 'nav.receivablesPdcs',
    permission: receivablesPermissions.ledgerRead,
  },
  {
    path: '/receivables/customers',
    label: 'nav.receivablesLedger',
    permission: receivablesPermissions.ledgerRead,
  },
  {
    path: '/receivables/aging',
    label: 'nav.receivablesAging',
    permission: receivablesPermissions.ledgerRead,
  },
  {
    path: '/receivables/followups',
    label: 'nav.receivablesFollowups',
    permission: receivablesPermissions.ledgerRead,
  },
  { path: '/payables/bills', label: 'nav.payablesBills', permission: payablesPermissions.billRead },
  {
    path: '/payables/payments',
    label: 'nav.payablesPayments',
    permission: payablesPermissions.ledgerRead,
  },
  {
    path: '/payables/payment-runs',
    label: 'nav.payablesRuns',
    permission: payablesPermissions.paymentCreate,
  },
  {
    path: '/payables/vendors',
    label: 'nav.payablesLedger',
    permission: payablesPermissions.ledgerRead,
  },
  {
    path: '/payables/aging',
    label: 'nav.payablesAging',
    permission: payablesPermissions.ledgerRead,
  },
  {
    path: '/payables/withholding',
    label: 'nav.payablesWithholding',
    permission: payablesPermissions.ledgerRead,
  },
  { path: '/payroll/runs', label: 'nav.payrollRuns', permission: payrollPermissions.runRead },
  { path: '/payroll/unpaid', label: 'nav.payrollUnpaid', permission: payrollPermissions.runRead },
  {
    path: '/subcontracts/work-orders',
    label: 'nav.subcontractsOrders',
    permission: subcontractsPermissions.orderRead,
  },
  {
    path: '/subcontracts/statement',
    label: 'nav.subcontractsStatement',
    permission: subcontractsPermissions.amountRead,
  },
  { path: '/tax/region-map', label: 'nav.taxRegionMap', permission: taxPermissions.ruleRead },
  { path: '/tax/rules', label: 'nav.taxRules', permission: taxPermissions.ruleRead },
  { path: '/tax/withholding', label: 'nav.taxWithholding', permission: taxPermissions.ruleRead },
  { path: '/tax/report', label: 'nav.taxReport', permission: taxPermissions.reportRead },
  { path: '/reports', label: 'nav.reports', anyPermission: Object.values(reportsPermissions) },
  {
    path: '/admin/settings',
    label: 'nav.settings',
    permission: platformPermissions.settingsManage,
  },
];

import {
  dprPermissions,
  expensesPermissions,
  procurementPermissions,
  variationsPermissions,
} from '@emporium/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router-dom';
import { ApiError } from './admin/api';
import { AuditPage } from './admin/AuditPage';
import { NumberSeriesPage } from './admin/NumberSeriesPage';
import { RolesPage } from './admin/RolesPage';
import { SettingsPage } from './admin/SettingsPage';
import { UsersPage } from './admin/UsersPage';
import { AuthProvider, directionOf } from './auth/AuthProvider';
import type { AuthClient } from './auth/client';
import { i18n } from './i18n';
import { AppLayout } from './shell/AppLayout';
import { NotFoundPage } from './shell/ErrorPages';
import { RequireAnyPermission, RequireAuth, RequirePermission } from './shell/guards';
import { MissingReportsPage } from './dpr/MissingReportsPage';
import { ReportPage } from './dpr/ReportPage';
import { ReportsPage } from './dpr/ReportsPage';
import { AdvancesPage } from './expenses/AdvancesPage';
import { CategoriesPage } from './expenses/CategoriesPage';
import { ClaimPage } from './expenses/ClaimPage';
import { ClaimsPage } from './expenses/ClaimsPage';
import { CustodiansPage } from './expenses/CustodiansPage';
import { ApprovalRulesPage } from './approvals/ApprovalRulesPage';
import { ApprovalsInboxPage } from './approvals/ApprovalsInboxPage';
import { FollowUpsPage } from './crm/FollowUpsPage';
import { EstimateEditorPage } from './estimation/EstimateEditorPage';
import { EstimatesPage } from './estimation/EstimatesPage';
import { TemplatesPage } from './estimation/TemplatesPage';
import { ProjectPage } from './projects/ProjectPage';
import { ClientMaterialPage } from './inventory/ClientMaterialPage';
import { CountsPage } from './inventory/CountsPage';
import { IssuePage } from './inventory/IssuePage';
import { LedgerPage } from './inventory/LedgerPage';
import { StockPage } from './inventory/StockPage';
import { TransfersPage } from './inventory/TransfersPage';
import { GrnPage } from './procurement/GrnPage';
import { PurchaseOrderPage, PurchaseOrdersPage } from './procurement/OrderPages';
import { RequisitionPage, RequisitionsPage } from './procurement/RequisitionPages';
import { RfqPage } from './procurement/RfqPage';
import { VariationEditorPage } from './variations/VariationEditorPage';
import { ProjectsPage } from './projects/ProjectsPage';
import { QuotationEditorPage } from './quotations/QuotationEditorPage';
import { QuotationsPage } from './quotations/QuotationsPage';
import { LeadDetailPage } from './crm/LeadDetailPage';
import { LeadsPage } from './crm/LeadsPage';
import { ImportPage } from './importer/ImportPage';
import { CompanyPage } from './master/CompanyPage';
import { CostCodesPage } from './master/CostCodesPage';
import { ItemsPage } from './master/ItemsPage';
import { LocationsPage } from './master/LocationsPage';
import { PartiesPage } from './master/PartiesPage';
import { UnitsPage } from './master/UnitsPage';
import { VendorPricesPage } from './master/VendorPricesPage';
import { NotificationsPage } from './notifications/NotificationsPage';
import { HomePage } from './shell/HomePage';
import { LoginPage } from './shell/LoginPage';
import { navItems } from './shell/nav';
import { ValuationReportPage } from './valuation/ReportPage';
import { ValuationSettingsPage } from './valuation/SettingsPage';
import { TransitionsPage } from './valuation/TransitionsPage';
import { GridPage } from './attendance/GridPage';
import { MissingPage } from './attendance/MissingPage';
import { SheetsPage } from './attendance/SheetsPage';
import { WageAdvancesPage } from './wages/AdvancesPage';
import { WagePeriodsPage } from './wages/PeriodsPage';
import { WageReconciliationPage } from './wages/ReconciliationPage';
import { WageSheetPage } from './wages/SheetPage';
import { MyTeamsPage } from './workforce/MyTeamsPage';
import { TeamBoardPage } from './workforce/TeamBoardPage';
import { WorkerPage } from './workforce/WorkerPage';
import { WorkersPage } from './workforce/WorkersPage';

/** Layout direction and the document language follow the active language (BR-11). */
function DirectionProvider({ children }: { children: ReactNode }) {
  const { i18n: instance } = useTranslation();
  const direction = directionOf(instance.language);
  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = instance.language;
  }, [direction, instance.language]);
  return <ConfigProvider direction={direction}>{children}</ConfigProvider>;
}

export function AppProviders({ auth, children }: { auth: AuthClient; children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Retry network failures only; an HTTP error answer will not change on retry.
        defaultOptions: {
          queries: { retry: (count, error) => !(error instanceof ApiError) && count < 2 },
        },
      }),
  );
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <DirectionProvider>
          <AuthProvider client={auth}>{children}</AuthProvider>
        </DirectionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

const permissionFor = (path: string) => navItems.find((item) => item.path === path)?.permission;

const guarded = (path: string, page: ReactNode) => (
  <RequirePermission permission={permissionFor(path)}>{page}</RequirePermission>
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="/admin/users" element={guarded('/admin/users', <UsersPage />)} />
        <Route path="/admin/roles" element={guarded('/admin/roles', <RolesPage />)} />
        <Route path="/admin/audit" element={guarded('/admin/audit', <AuditPage />)} />
        <Route
          path="/admin/number-series"
          element={guarded('/admin/number-series', <NumberSeriesPage />)}
        />
        <Route path="/approvals" element={guarded('/approvals', <ApprovalsInboxPage />)} />
        <Route
          path="/admin/approval-rules"
          element={guarded('/admin/approval-rules', <ApprovalRulesPage />)}
        />
        <Route path="/notifications" element={guarded('/notifications', <NotificationsPage />)} />
        <Route path="/master/company" element={guarded('/master/company', <CompanyPage />)} />
        <Route path="/master/parties" element={guarded('/master/parties', <PartiesPage />)} />
        <Route path="/master/items" element={guarded('/master/items', <ItemsPage />)} />
        <Route path="/master/units" element={guarded('/master/units', <UnitsPage />)} />
        <Route
          path="/master/cost-codes"
          element={guarded('/master/cost-codes', <CostCodesPage />)}
        />
        <Route path="/master/locations" element={guarded('/master/locations', <LocationsPage />)} />
        <Route
          path="/master/vendor-prices"
          element={guarded('/master/vendor-prices', <VendorPricesPage />)}
        />
        <Route path="/crm/leads" element={guarded('/crm/leads', <LeadsPage />)} />
        <Route path="/crm/leads/:id" element={guarded('/crm/leads', <LeadDetailPage />)} />
        <Route
          path="/estimation/templates"
          element={guarded('/estimation/templates', <TemplatesPage />)}
        />
        <Route
          path="/estimation/estimates"
          element={guarded('/estimation/estimates', <EstimatesPage />)}
        />
        <Route
          path="/estimation/estimates/:id"
          element={guarded('/estimation/estimates', <EstimateEditorPage />)}
        />
        <Route path="/quotations" element={guarded('/quotations', <QuotationsPage />)} />
        <Route path="/quotations/:id" element={guarded('/quotations', <QuotationEditorPage />)} />
        <Route path="/projects" element={guarded('/projects', <ProjectsPage />)} />
        <Route path="/projects/:id" element={guarded('/projects', <ProjectPage />)} />
        <Route
          path="/variations/:id"
          element={
            <RequirePermission permission={variationsPermissions.read}>
              <VariationEditorPage />
            </RequirePermission>
          }
        />
        <Route
          path="/procurement/requisitions"
          element={guarded('/procurement/requisitions', <RequisitionsPage />)}
        />
        <Route
          path="/procurement/requisitions/:id"
          element={guarded('/procurement/requisitions', <RequisitionPage />)}
        />
        <Route
          path="/procurement/rfqs/:id"
          element={guarded('/procurement/requisitions', <RfqPage />)}
        />
        <Route
          path="/procurement/purchase-orders"
          element={guarded('/procurement/purchase-orders', <PurchaseOrdersPage />)}
        />
        <Route
          path="/procurement/purchase-orders/:id"
          element={guarded('/procurement/purchase-orders', <PurchaseOrderPage />)}
        />
        <Route
          path="/procurement/receiving/:poId"
          element={
            <RequirePermission permission={procurementPermissions.grnCreate}>
              <GrnPage />
            </RequirePermission>
          }
        />
        <Route path="/inventory/stock" element={guarded('/inventory/stock', <StockPage />)} />
        <Route path="/inventory/issue" element={guarded('/inventory/issue', <IssuePage />)} />
        <Route
          path="/inventory/transfers"
          element={guarded('/inventory/transfers', <TransfersPage />)}
        />
        <Route path="/inventory/counts" element={guarded('/inventory/counts', <CountsPage />)} />
        <Route
          path="/inventory/client-material"
          element={guarded('/inventory/client-material', <ClientMaterialPage />)}
        />
        <Route path="/inventory/ledger" element={guarded('/inventory/ledger', <LedgerPage />)} />
        <Route
          path="/expenses/claims"
          element={guarded('/expenses/claims', <ClaimsPage view="mine" />)}
        />
        <Route
          path="/expenses/claims/:id"
          element={
            <RequireAnyPermission
              permissions={[expensesPermissions.claimReadOwn, expensesPermissions.claimReadAll]}
            >
              <ClaimPage />
            </RequireAnyPermission>
          }
        />
        <Route
          path="/expenses/all-claims"
          element={guarded('/expenses/all-claims', <ClaimsPage view="all" />)}
        />
        <Route
          path="/expenses/queue"
          element={guarded('/expenses/queue', <ClaimsPage view="queue" />)}
        />
        <Route
          path="/expenses/advances"
          element={guarded('/expenses/advances', <AdvancesPage />)}
        />
        <Route
          path="/expenses/custodians"
          element={guarded('/expenses/custodians', <CustodiansPage />)}
        />
        <Route
          path="/expenses/categories"
          element={guarded('/expenses/categories', <CategoriesPage />)}
        />
        <Route path="/dpr/reports" element={guarded('/dpr/reports', <ReportsPage />)} />
        <Route
          path="/dpr/reports/:id"
          element={
            <RequireAnyPermission
              permissions={[dprPermissions.reportRead, dprPermissions.reportCreate]}
            >
              <ReportPage />
            </RequireAnyPermission>
          }
        />
        <Route path="/dpr/missing" element={guarded('/dpr/missing', <MissingReportsPage />)} />
        <Route path="/workforce/workers" element={guarded('/workforce/workers', <WorkersPage />)} />
        <Route
          path="/workforce/workers/:id"
          element={guarded('/workforce/workers', <WorkerPage />)}
        />
        <Route
          path="/workforce/my-teams"
          element={guarded('/workforce/my-teams', <MyTeamsPage />)}
        />
        <Route path="/workforce/board" element={guarded('/workforce/board', <TeamBoardPage />)} />
        <Route path="/attendance/grid" element={guarded('/attendance/grid', <GridPage />)} />
        <Route path="/attendance/sheets" element={guarded('/attendance/sheets', <SheetsPage />)} />
        <Route
          path="/attendance/missing"
          element={guarded('/attendance/missing', <MissingPage />)}
        />
        <Route path="/wages/periods" element={guarded('/wages/periods', <WagePeriodsPage />)} />
        <Route path="/wages/periods/:id" element={guarded('/wages/periods', <WageSheetPage />)} />
        <Route
          path="/wages/periods/:id/reconciliation"
          element={guarded('/wages/periods', <WageReconciliationPage />)}
        />
        <Route path="/wages/advances" element={guarded('/wages/advances', <WageAdvancesPage />)} />
        <Route
          path="/valuation/settings"
          element={guarded('/valuation/settings', <ValuationSettingsPage />)}
        />
        <Route
          path="/valuation/report"
          element={guarded('/valuation/report', <ValuationReportPage />)}
        />
        <Route
          path="/valuation/transitions"
          element={guarded('/valuation/transitions', <TransitionsPage />)}
        />
        <Route path="/crm/follow-ups" element={guarded('/crm/follow-ups', <FollowUpsPage />)} />
        <Route path="/imports" element={guarded('/imports', <ImportPage />)} />
        <Route path="/admin/settings" element={guarded('/admin/settings', <SettingsPage />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

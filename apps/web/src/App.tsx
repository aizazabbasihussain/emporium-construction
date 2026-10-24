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
import { RequireAuth, RequirePermission } from './shell/guards';
import { ApprovalRulesPage } from './approvals/ApprovalRulesPage';
import { ApprovalsInboxPage } from './approvals/ApprovalsInboxPage';
import { ImportPage } from './importer/ImportPage';
import { HomePage } from './shell/HomePage';
import { LoginPage } from './shell/LoginPage';
import { navItems } from './shell/nav';

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
        <Route path="/imports" element={guarded('/imports', <ImportPage />)} />
        <Route path="/admin/settings" element={guarded('/admin/settings', <SettingsPage />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

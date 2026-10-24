import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider, Layout, Typography } from 'antd';
import { useState, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router-dom';
import { i18n } from './i18n';

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider direction="ltr">{children}</ConfigProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

export function Shell() {
  const { t } = useTranslation();
  return (
    <Layout style={{ minHeight: '100vh', padding: 24 }}>
      <Typography.Title level={2}>{t('app.title')}</Typography.Title>
      <Typography.Text type="secondary">{t('app.tagline')}</Typography.Text>
    </Layout>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
    </Routes>
  );
}

import { Button, Layout, Menu, Radio, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { locales, WORKER_ROLE } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { navItems } from './nav';

/** BR-5: a login that holds only the worker role gets this shell, with no link to any other module. */
export const isWorkerOnly = (roles: readonly string[] | undefined): boolean =>
  roles !== undefined && roles.length === 1 && roles[0] === WORKER_ROLE;

/** The phone-first shell of the worker portal: a header and a row of three tabs. */
export function WorkerLayout() {
  const { t, i18n } = useTranslation();
  const { profile, can, signOut, setLanguage } = useAuth();
  const location = useLocation();
  const items = navItems.filter(
    (item) =>
      item.path.startsWith('/me/worker/') &&
      (item.permission === undefined || can(item.permission)),
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          height: 'auto',
          padding: '8px 12px',
        }}
      >
        <Typography.Text strong style={{ color: 'white', flex: 1 }}>
          {t('app.title')}
        </Typography.Text>
        <Radio.Group
          optionType="button"
          size="small"
          aria-label={t('language.label')}
          value={i18n.language}
          onChange={(event) => setLanguage(event.target.value as string)}
          options={locales.map((locale) => ({ value: locale, label: t(`language.${locale}`) }))}
        />
        <Space>
          <Typography.Text style={{ color: 'white' }}>
            {t('shell.signedInAs', { name: profile?.fullName ?? '' })}
          </Typography.Text>
          <Button size="small" onClick={() => void signOut()}>
            {t('shell.logout')}
          </Button>
        </Space>
      </Layout.Header>
      <Menu
        aria-label={t('shell.menu')}
        mode="horizontal"
        selectedKeys={items
          .filter((item) => location.pathname === item.path)
          .map((item) => item.path)}
        items={items.map((item) => ({
          key: item.path,
          label: <Link to={item.path}>{t(item.label)}</Link>,
        }))}
      />
      <Layout.Content style={{ padding: 12 }}>
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}

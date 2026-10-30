import { Button, Layout, Menu, Modal, Radio, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { locales } from '@emporium/shared';
import { useAuth } from '../auth/AuthProvider';
import { NotificationBell } from '../notifications/NotificationBell';
import { InstallPrompt } from '../offline/InstallPrompt';
import { useOffline } from '../offline/OfflineProvider';
import { SyncStatusBar } from '../offline/SyncStatusBar';
import { navItems } from './nav';

export function AppLayout() {
  const { t, i18n } = useTranslation();
  const { profile, can, signOut, setLanguage } = useAuth();
  const location = useLocation();
  const { sharedDevice, clearDrafts } = useOffline();

  // BR-2: on a device marked as shared, the user decides whether their drafts stay; default keep.
  const [answer, setAnswer] = useState<((remove: boolean) => void) | null>(null);
  const logout = async () => {
    if (sharedDevice) {
      const remove = await new Promise<boolean>((resolve) => setAnswer(() => resolve));
      setAnswer(null);
      if (remove) await clearDrafts();
    }
    await signOut();
  };

  // BR-10: an item shows only when the user holds its permission.
  const visible = navItems.filter((item) =>
    item.anyPermission !== undefined
      ? item.anyPermission.some((permission) => can(permission))
      : item.permission === undefined || can(item.permission),
  );
  const selected = visible
    .filter(
      (item) =>
        item.path === location.pathname ||
        (item.path !== '/' && location.pathname.startsWith(item.path)),
    )
    .map((item) => item.path);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {answer !== null && (
        <Modal
          open
          title={t('offline.logout.title')}
          okText={t('offline.logout.delete')}
          cancelText={t('offline.logout.keep')}
          onOk={() => answer(true)}
          onCancel={() => answer(false)}
        >
          {t('offline.logout.body')}
        </Modal>
      )}
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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
        <InstallPrompt />
        <NotificationBell />
        <Space>
          <Typography.Text style={{ color: 'white' }}>
            {t('shell.signedInAs', { name: profile?.fullName ?? '' })}
          </Typography.Text>
          <Button size="small" onClick={() => void logout()}>
            {t('shell.logout')}
          </Button>
        </Space>
      </Layout.Header>
      <Layout>
        <Layout.Sider theme="light" width={220}>
          <Menu
            aria-label={t('shell.menu')}
            mode="inline"
            selectedKeys={selected}
            items={visible.map((item) => ({
              key: item.path,
              label: <Link to={item.path}>{t(item.label)}</Link>,
            }))}
          />
        </Layout.Sider>
        <Layout.Content style={{ padding: 24 }}>
          <SyncStatusBar />
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

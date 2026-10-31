import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { isWorkerOnly } from './WorkerLayout';

export function HomePage() {
  const { t } = useTranslation();
  const { profile } = useAuth();
  // A worker has no home page of their own: they land on their attendance.
  if (isWorkerOnly(profile?.roles)) return <Navigate to="/me/worker/attendance" replace />;
  return (
    <div>
      <Typography.Title level={2}>{t('app.title')}</Typography.Title>
      <Typography.Text type="secondary">{t('app.tagline')}</Typography.Text>
      <Typography.Paragraph>
        {t('shell.welcome', { name: profile?.fullName ?? '' })}
      </Typography.Paragraph>
    </div>
  );
}

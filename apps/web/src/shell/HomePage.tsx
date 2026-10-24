import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';

export function HomePage() {
  const { t } = useTranslation();
  const { profile } = useAuth();
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

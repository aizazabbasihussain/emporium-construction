import { Button, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function ForbiddenPage() {
  const { t } = useTranslation();
  return (
    <Result
      status="403"
      title={t('errors.forbiddenTitle')}
      subTitle={t('errors.forbiddenText')}
      extra={
        <Link to="/">
          <Button type="primary">{t('errors.backHome')}</Button>
        </Link>
      }
    />
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Result
      status="404"
      title={t('errors.notFoundTitle')}
      subTitle={t('errors.notFoundText')}
      extra={
        <Link to="/">
          <Button type="primary">{t('errors.backHome')}</Button>
        </Link>
      }
    />
  );
}

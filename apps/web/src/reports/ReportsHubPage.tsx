import { reportCodes, reportPermission } from '@emporium/shared';
import { Card, Col, Row, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

/** The reports the signed-in user may open. */
export function ReportsHubPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const allowed = reportCodes.filter((code) => can(reportPermission[code]));

  return (
    <div>
      <Typography.Title level={3}>{t('reports.title')}</Typography.Title>
      <Typography.Paragraph>{t('reports.hubIntro')}</Typography.Paragraph>
      <Row gutter={[16, 16]}>
        {allowed.map((code) => (
          <Col key={code} xs={24} md={12} lg={8}>
            <Card title={t(`reports.names.${code}`)}>
              <Typography.Paragraph>{t(`reports.descriptions.${code}`)}</Typography.Paragraph>
              <Link
                to={`/reports/${code}`}
                aria-label={`${t('reports.open')} ${t(`reports.names.${code}`)}`}
              >
                {t('reports.open')}
              </Link>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}

import { formatAmount, formatDate } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { quotationsApi } from './api';

/** What the client will receive. It is built from the print model, which carries no cost or margin (BR-8). */
export function PrintPreview({ id }: { id: string }) {
  const { t } = useTranslation();
  const model = useQuery({
    queryKey: ['quotations', 'print-model', id],
    queryFn: () => quotationsApi.printModel(id),
  });
  if (model.isError) return <Alert type="error" message={t('quotations.print.failed')} />;
  if (model.data === undefined) return null;
  const m = model.data;
  const text = (title: string, body: string) =>
    body.trim() === '' ? null : (
      <>
        <Typography.Title level={5}>{title}</Typography.Title>
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{body}</Typography.Paragraph>
      </>
    );
  return (
    <div aria-label={t('quotations.print.title')}>
      <Typography.Title level={4}>{m.company.name}</Typography.Title>
      <Typography.Paragraph>
        {[m.company.address, m.company.phone, m.company.email].filter(Boolean).join(' | ')}
        {m.registrations.map((r) => (
          <div key={`${r.authority}-${r.number}`}>
            {r.authority} {r.registrationType.toUpperCase()}: {r.number}
          </div>
        ))}
      </Typography.Paragraph>
      <Descriptions size="small" column={1} title={`${m.quotation.number} - ${m.quotation.title}`}>
        <Descriptions.Item label={t('quotations.print.to')}>
          {[m.client.name, m.client.address, m.client.city].filter(Boolean).join(', ')}
        </Descriptions.Item>
        {m.quotation.issuedOn !== null && (
          <Descriptions.Item label={t('quotations.print.date')}>
            {formatDate(m.quotation.issuedOn)}
          </Descriptions.Item>
        )}
        {m.quotation.expiresOn !== null && (
          <Descriptions.Item label={t('quotations.print.validUntil')}>
            {formatDate(m.quotation.expiresOn)}
          </Descriptions.Item>
        )}
      </Descriptions>
      {text(t('quotations.print.scope'), m.scope)}
      {text(t('quotations.print.inclusions'), m.inclusions)}
      {text(t('quotations.print.exclusions'), m.exclusions)}
      <Typography.Title level={5}>{t('quotations.print.schedule')}</Typography.Title>
      <Table
        rowKey="stageNo"
        size="small"
        pagination={false}
        dataSource={m.stages}
        columns={[
          { title: '#', dataIndex: 'stageNo' },
          { title: t('quotations.stages.name'), dataIndex: 'name' },
          { title: t('quotations.stages.percent'), dataIndex: 'percent', align: 'right' },
          {
            title: t('quotations.stages.amount'),
            align: 'right',
            render: (_, stage) => formatAmount(stage.amount),
          },
          { title: t('quotations.stages.condition'), dataIndex: 'condition' },
        ]}
      />
      {text(t('quotations.print.terms'), m.terms)}
      <Typography.Title level={5}>
        {t('quotations.print.total')}: {formatAmount(m.price)} ({t('quotations.print.excludingTax')}
        )
      </Typography.Title>
    </div>
  );
}

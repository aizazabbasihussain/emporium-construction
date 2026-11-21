import { formatAmount, formatDate, profitabilityPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { profitabilityApi, type ProjectFinancials } from './api';
import { AlertTags, percentText, useErrorText } from './PortfolioPage';

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return <Descriptions.Item label={label}>{children}</Descriptions.Item>;
}

/** The financial page of one project (spec section 5). */
export function ProjectPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [draftDate, setDraftDate] = useState('');
  const [asOf, setAsOf] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [forecastDate, setForecastDate] = useState('');
  const [amountError, setAmountError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const projectId = id ?? '';

  const project = useQuery({
    queryKey: ['profitability', 'project', projectId, asOf],
    queryFn: () => profitabilityApi.project(projectId, asOf || undefined),
    enabled: projectId !== '',
    retry: false,
  });
  const save = useMutation({
    mutationFn: () =>
      profitabilityApi.setForecast(projectId, {
        costToComplete: amount.trim(),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        ...(forecastDate === '' ? {} : { forecastDate }),
      }),
    onSuccess: async () => {
      setError(null);
      setNotice(t('profitability.project.forecastSaved'));
      setAmount('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['profitability'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const download = useMutation({
    mutationFn: (format: 'csv' | 'xlsx') =>
      profitabilityApi.download({ projectId, asOf: asOf || undefined }, format),
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    if (!/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
      setAmountError(true);
      return;
    }
    setAmountError(false);
    setNotice(null);
    save.mutate();
  };

  const data: ProjectFinancials | undefined = project.data;
  const na = t('profitability.project.notComputable');
  const money = (value: string) => formatAmount(value);

  return (
    <div>
      <Link to="/profitability">{t('profitability.project.back')}</Link>
      <Typography.Title level={3}>
        {data === undefined ? t('profitability.title') : `${data.code} ${data.name}`}
      </Typography.Title>
      {error !== null && <Alert type="error" message={error} />}
      {notice !== null && <Alert type="success" message={notice} />}
      {project.isError && <Alert type="error" message={errorText(project.error)} />}

      <Space wrap style={{ margin: '12px 0' }}>
        <Input
          type="date"
          aria-label={t('profitability.portfolio.asOf')}
          style={{ width: 170 }}
          value={draftDate}
          onChange={(event) => setDraftDate(event.target.value)}
          onBlur={() => setAsOf(draftDate)}
        />
        <Button loading={download.isPending} onClick={() => download.mutate('csv')}>
          {t('profitability.portfolio.exportCsv')}
        </Button>
        <Button loading={download.isPending} onClick={() => download.mutate('xlsx')}>
          {t('profitability.portfolio.exportXlsx')}
        </Button>
      </Space>

      {data !== undefined && (
        <>
          <Descriptions
            bordered
            size="small"
            column={1}
            title={t('profitability.project.contract')}
          >
            <Figure label={t('profitability.figures.contractValue')}>
              {money(data.contractValue)}
            </Figure>
            <Figure label={t('profitability.figures.billedBase')}>
              {money(data.billedBase)} ({percentText(data.billedPercent, na)})
            </Figure>
            <Figure label={t('profitability.figures.billedGross')}>
              {money(data.billedGross)}
            </Figure>
            <Figure label={t('profitability.figures.collectedGross')}>
              {money(data.collectedGross)}
            </Figure>
            <Figure label={t('profitability.figures.collectedBase')}>
              {money(data.collectedBase)} ({percentText(data.collectedPercent, na)})
            </Figure>
            <Figure label={t('profitability.figures.withheldTax')}>
              {money(data.withheldTax)}
            </Figure>
            <Figure label={t('profitability.figures.outstandingReceivable')}>
              {money(data.outstandingReceivable)}
            </Figure>
            <Figure label={t('profitability.project.oldestDue')}>
              {data.oldestDueDate === null ? na : formatDate(data.oldestDueDate)}
            </Figure>
          </Descriptions>

          <Descriptions
            bordered
            size="small"
            column={1}
            style={{ marginTop: 16 }}
            title={t('profitability.project.cost')}
          >
            <Figure label={t('profitability.figures.committed')}>{money(data.committed)}</Figure>
            <Figure label={t('profitability.figures.approved')}>{money(data.approved)}</Figure>
            <Figure label={t('profitability.figures.posted')}>{money(data.posted)}</Figure>
            <Figure label={t('profitability.figures.costToDate')}>
              {money(data.costToDate)} ({percentText(data.costPercentOfBudget, na)})
            </Figure>
            <Figure label={t('profitability.figures.budget')}>{money(data.budget)}</Figure>
            <Figure
              label={t(
                data.costToCompleteSource === 'forecast'
                  ? 'profitability.figures.costToCompleteForecast'
                  : 'profitability.figures.costToComplete',
              )}
            >
              {money(data.costToComplete)}
            </Figure>
          </Descriptions>

          <Descriptions
            bordered
            size="small"
            column={1}
            style={{ marginTop: 16 }}
            title={t('profitability.project.margin')}
          >
            <Figure label={t('profitability.figures.expectedMargin')}>
              {money(data.expectedMargin)} ({percentText(data.expectedMarginPercent, na)})
            </Figure>
            <Figure label={t('profitability.figures.currentMargin')}>
              {money(data.currentMargin)} ({percentText(data.currentMarginPercent, na)})
            </Figure>
          </Descriptions>

          <Descriptions
            bordered
            size="small"
            column={1}
            style={{ marginTop: 16 }}
            title={t('profitability.project.cash')}
          >
            <Figure label={t('profitability.figures.paidOutVendors')}>
              {money(data.paidOutVendors)}
            </Figure>
            <Figure label={t('profitability.figures.paidOutWages')}>
              {money(data.paidOutWages)}
            </Figure>
            <Figure label={t('profitability.figures.paidOutExpenses')}>
              {money(data.paidOutExpenses)}
            </Figure>
            <Figure label={t('profitability.figures.paidOut')}>{money(data.paidOut)}</Figure>
            <Figure label={t('profitability.figures.cashPosition')}>
              <Typography.Text type={data.cashPosition.startsWith('-') ? 'danger' : undefined}>
                {money(data.cashPosition)}
              </Typography.Text>
              {data.cashPosition.startsWith('-') && (
                <> — {t('profitability.project.negativeCash')}</>
              )}
            </Figure>
          </Descriptions>

          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('profitability.project.alertsNow')}
          </Typography.Title>
          {data.thresholds === null ? (
            <Typography.Text type="secondary">
              {t('profitability.project.noThresholds')}
            </Typography.Text>
          ) : data.alerts.length === 0 ? (
            <Typography.Text>{t('profitability.project.noAlertsNow')}</Typography.Text>
          ) : (
            <AlertTags codes={data.alerts} />
          )}

          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {t('profitability.project.forecast')}
          </Typography.Title>
          <Typography.Paragraph>
            {data.forecast === null
              ? t('profitability.project.forecastNone')
              : t('profitability.project.forecastLatest', {
                  amount: money(data.forecast.costToComplete),
                  date: formatDate(data.forecast.forecastDate),
                })}
          </Typography.Paragraph>
          {can(profitabilityPermissions.forecastSet) && (
            <Space wrap align="start">
              <div>
                <Input
                  aria-label={t('profitability.project.forecastAmount')}
                  placeholder={t('profitability.project.forecastAmount')}
                  status={amountError ? 'error' : undefined}
                  style={{ width: 200 }}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                {amountError && (
                  <div role="alert">
                    <Typography.Text type="danger">
                      {t('profitability.project.amountRequired')}
                    </Typography.Text>
                  </div>
                )}
              </div>
              <Input
                aria-label={t('profitability.project.forecastNote')}
                placeholder={t('profitability.project.forecastNote')}
                style={{ width: 240 }}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <Input
                type="date"
                aria-label={t('profitability.project.forecastDate')}
                style={{ width: 170 }}
                value={forecastDate}
                onChange={(event) => setForecastDate(event.target.value)}
              />
              <Button type="primary" loading={save.isPending} onClick={submit}>
                {t('profitability.project.forecastSave')}
              </Button>
            </Space>
          )}
        </>
      )}
    </div>
  );
}

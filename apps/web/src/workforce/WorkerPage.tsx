import { formatDate, formatAmount, workforcePermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { WorkerAccountControl } from '../workerportal/AccountControl';
import { workforceApi, type Rate } from './api';
import {
  emptyRate,
  karachiToday,
  rateBody,
  rateProblem,
  useErrorText,
  type RateDraft,
} from './form';

/** One worker: details, the team they are in, and (for those who may see pay) the rate history. */
export function WorkerPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [rate, setRate] = useState<RateDraft>(emptyRate(karachiToday()));
  const [leftOn, setLeftOn] = useState(karachiToday());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const worker = useQuery({
    queryKey: ['workforce-worker', id],
    queryFn: () => workforceApi.worker(id),
  });
  const trades = useQuery({ queryKey: ['workforce-trades'], queryFn: workforceApi.trades });
  const showRates = can(perm.rateRead);
  const rates = useQuery({
    queryKey: ['workforce-rates', id],
    queryFn: () => workforceApi.rates(id),
    enabled: showRates,
  });

  const fail = (cause: unknown) => {
    setMessage(null);
    setError(errorText(cause));
  };
  const addRate = useMutation({
    mutationFn: () => workforceApi.addRate(id, rateBody(rate)),
    onSuccess: async () => {
      setError(null);
      setMessage(t('workforce.rates.saved'));
      setRate(emptyRate(karachiToday()));
      await queryClient.invalidateQueries({ queryKey: ['workforce-rates', id] });
    },
    onError: fail,
  });
  const leave = useMutation({
    mutationFn: (version: number) => workforceApi.deactivate(id, version, leftOn),
    onSuccess: async (next) => {
      setError(null);
      setMessage(t('workforce.worker.deactivated'));
      queryClient.setQueryData(['workforce-worker', id], next);
      await queryClient.invalidateQueries({ queryKey: ['workforce-workers'] });
      await queryClient.invalidateQueries({ queryKey: ['workforce-rates', id] });
    },
    onError: fail,
  });

  if (worker.isError) return <Alert type="error" message={t('common.loadError')} />;
  const current = worker.data;
  if (current === undefined) return null;
  const tradeName = trades.data?.find((trade) => trade.code === current.tradeCode)?.name;
  const rateIssue = rateProblem(rate);

  return (
    <div>
      <Link to="/workforce/workers">{t('workforce.worker.back')}</Link>
      <Typography.Title level={3}>
        {current.fullName} <Tag>{t(`workforce.status.${current.status}`)}</Tag>
      </Typography.Title>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="success" message={message} style={{ marginBottom: 12 }} />}
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('workforce.field.code')}>{current.code}</Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.trade')}>
          {tradeName ?? current.tradeCode}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.employmentType')}>
          {t(`workforce.employment.${current.employmentType}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.fatherName')}>
          {current.fatherName ?? ''}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.cnic')}>
          {current.cnic ?? ''}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.phone')}>
          {current.phone ?? ''}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.joinedOn')}>
          {formatDate(current.joinedOn)}
        </Descriptions.Item>
        <Descriptions.Item label={t('workforce.field.leftOn')}>
          {current.leftOn === null ? '' : formatDate(current.leftOn)}
        </Descriptions.Item>
      </Descriptions>

      {showRates && (
        <section aria-label={t('workforce.rates.title')} style={{ marginBottom: 16 }}>
          <Typography.Title level={4}>{t('workforce.rates.title')}</Typography.Title>
          <Table<Rate>
            rowKey="id"
            size="small"
            pagination={false}
            loading={rates.isLoading}
            locale={{ emptyText: t('workforce.rates.empty') }}
            dataSource={rates.data ?? []}
            columns={[
              {
                title: t('workforce.rates.basis'),
                render: (_, row) => t(`workforce.payBasis.${row.payBasis}`),
              },
              {
                title: t('workforce.rates.amount'),
                align: 'right',
                render: (_, row) => formatAmount(row.amount),
              },
              {
                title: t('workforce.rates.from'),
                render: (_, row) => formatDate(row.effectiveFrom),
              },
              {
                title: t('workforce.rates.to'),
                render: (_, row) => (row.effectiveTo === null ? '' : formatDate(row.effectiveTo)),
              },
            ]}
          />
          {can(perm.rateManage) && current.status === 'active' && (
            <Space style={{ marginTop: 12 }} wrap>
              <Select
                style={{ minWidth: 160 }}
                aria-label={t('workforce.rates.basis')}
                value={rate.payBasis}
                onChange={(value: RateDraft['payBasis']) => setRate({ ...rate, payBasis: value })}
                options={(['daily_rate', 'monthly_salary'] as const).map((basis) => ({
                  value: basis,
                  label: t(`workforce.payBasis.${basis}`),
                }))}
              />
              <Input
                style={{ width: 140 }}
                inputMode="decimal"
                aria-label={t('workforce.rates.amount')}
                value={rate.amount}
                onChange={(event) => setRate({ ...rate, amount: event.target.value })}
              />
              <Input
                type="date"
                aria-label={t('workforce.rates.from')}
                value={rate.effectiveFrom}
                onChange={(event) => setRate({ ...rate, effectiveFrom: event.target.value })}
              />
              <Button
                type="primary"
                disabled={rateIssue !== null}
                loading={addRate.isPending}
                onClick={() => addRate.mutate()}
              >
                {t('workforce.rates.add')}
              </Button>
            </Space>
          )}
        </section>
      )}

      {can(perm.workerManage) && current.status === 'active' && (
        <Space wrap>
          <Input
            type="date"
            aria-label={t('workforce.field.leftOn')}
            value={leftOn}
            onChange={(event) => setLeftOn(event.target.value)}
          />
          <Button
            danger
            disabled={!/^\d{4}-\d{2}-\d{2}$/.test(leftOn)}
            loading={leave.isPending}
            onClick={() => leave.mutate(current.version)}
          >
            {t('workforce.worker.deactivate')}
          </Button>
        </Space>
      )}

      <WorkerAccountControl workerId={id} />
    </div>
  );
}

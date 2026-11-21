import { formatDateTimeUtc, profitabilityPermissions } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { profitabilityApi, type Alert as AlertRow, type Threshold } from './api';
import { useErrorText } from './PortfolioPage';

interface Draft {
  marginFloorPercent: string;
  overspendPercent: string;
  receivableAgeDays: string;
  active: boolean;
}

const draftOf = (threshold: Threshold | undefined): Draft => ({
  marginFloorPercent: threshold?.marginFloorPercent ?? '',
  overspendPercent: threshold?.overspendPercent ?? '',
  receivableAgeDays: threshold === undefined ? '' : String(threshold.receivableAgeDays),
  active: threshold?.active ?? true,
});

function ThresholdForm({
  threshold,
  onDone,
  onError,
}: {
  threshold?: Threshold | undefined;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(draftOf(threshold));
  const [invalid, setInvalid] = useState(false);
  const body = () => ({
    marginFloorPercent: draft.marginFloorPercent.trim(),
    overspendPercent: draft.overspendPercent.trim(),
    receivableAgeDays: Number(draft.receivableAgeDays),
    active: draft.active,
  });
  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: ['profitability'] });
    onDone();
  };
  const save = useMutation({
    mutationFn: () =>
      threshold === undefined
        ? profitabilityApi.createThreshold(body())
        : profitabilityApi.updateThreshold(threshold, body()),
    onSuccess: done,
    onError: (cause) => onError(errorText(cause)),
  });
  const remove = useMutation({
    mutationFn: () => profitabilityApi.removeThreshold(threshold as Threshold),
    onSuccess: done,
    onError: (cause) => onError(errorText(cause)),
  });
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const submit = () => {
    const values = body();
    const bad =
      !/^\d+(\.\d{1,4})?$/.test(values.marginFloorPercent) ||
      !/^\d+(\.\d{1,4})?$/.test(values.overspendPercent) ||
      !Number.isInteger(values.receivableAgeDays) ||
      values.receivableAgeDays < 0 ||
      draft.receivableAgeDays.trim() === '';
    setInvalid(bad);
    if (!bad) save.mutate();
  };
  return (
    <Space wrap align="start" style={{ marginBottom: 8 }}>
      <Input
        aria-label={t('profitability.alertList.marginFloor')}
        placeholder={t('profitability.alertList.marginFloor')}
        style={{ width: 150 }}
        value={draft.marginFloorPercent}
        onChange={(event) => set({ marginFloorPercent: event.target.value })}
      />
      <Input
        aria-label={t('profitability.alertList.overspend')}
        placeholder={t('profitability.alertList.overspend')}
        style={{ width: 150 }}
        value={draft.overspendPercent}
        onChange={(event) => set({ overspendPercent: event.target.value })}
      />
      <Input
        aria-label={t('profitability.alertList.ageDays')}
        placeholder={t('profitability.alertList.ageDays')}
        style={{ width: 200 }}
        value={draft.receivableAgeDays}
        onChange={(event) => set({ receivableAgeDays: event.target.value })}
      />
      <Checkbox checked={draft.active} onChange={(event) => set({ active: event.target.checked })}>
        {t('profitability.alertList.active')}
      </Checkbox>
      <Button type="primary" loading={save.isPending} onClick={submit}>
        {t('profitability.alertList.save')}
      </Button>
      {threshold !== undefined && (
        <Button danger loading={remove.isPending} onClick={() => remove.mutate()}>
          {t('profitability.alertList.remove')}
        </Button>
      )}
      {invalid && (
        <span role="alert">
          <Typography.Text type="danger">
            {t('profitability.errors.invalid_threshold')}
          </Typography.Text>
        </span>
      )}
    </Space>
  );
}

/** The alert list and, for management, the thresholds that raise the alerts (BR-4). */
export function AlertsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const errorText = useErrorText();
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alerts = useQuery({
    queryKey: ['profitability', 'alerts', onlyOpen],
    queryFn: () => profitabilityApi.alerts(onlyOpen),
    retry: false,
  });
  const thresholds = useQuery({
    queryKey: ['profitability', 'thresholds'],
    queryFn: () => profitabilityApi.thresholds(),
    retry: false,
  });
  const company = (thresholds.data ?? []).filter((row) => row.scope === 'company');
  const projectRows = (thresholds.data ?? []).filter((row) => row.scope === 'project');
  const saved = () => {
    setError(null);
    setNotice(t('profitability.alertList.saved'));
  };
  const failed = (message: string) => {
    setNotice(null);
    setError(message);
  };

  return (
    <div>
      <Typography.Title level={3}>{t('profitability.alertList.title')}</Typography.Title>
      <Typography.Paragraph>{t('profitability.alertList.intro')}</Typography.Paragraph>
      <Link to="/profitability">{t('profitability.project.back')}</Link>
      {error !== null && <Alert type="error" message={error} />}
      {notice !== null && <Alert type="success" message={notice} />}
      {alerts.isError && <Alert type="error" message={errorText(alerts.error)} />}

      <div style={{ margin: '12px 0' }}>
        <Checkbox checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)}>
          {t('profitability.alertList.onlyOpen')}
        </Checkbox>
      </div>
      <Table<AlertRow>
        size="small"
        rowKey="id"
        loading={alerts.isLoading}
        pagination={false}
        dataSource={alerts.data ?? []}
        locale={{ emptyText: t('profitability.alertList.empty') }}
        columns={[
          {
            key: 'project',
            title: t('profitability.columns.project'),
            render: (_, row) => (
              <Link to={`/profitability/projects/${row.projectId}`}>
                {row.projectCode} {row.projectName}
              </Link>
            ),
          },
          {
            key: 'alert',
            title: t('profitability.columns.alerts'),
            render: (_, row) => t(`profitability.alerts.${row.alertCode}`),
          },
          {
            key: 'raised',
            title: t('profitability.alertList.raised'),
            render: (_, row) => formatDateTimeUtc(row.raisedAt),
          },
          {
            key: 'cleared',
            title: t('profitability.alertList.cleared'),
            render: (_, row) =>
              row.clearedAt === null
                ? t('profitability.alertList.open')
                : formatDateTimeUtc(row.clearedAt),
          },
        ]}
      />

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        {t('profitability.alertList.thresholds')}
      </Typography.Title>
      {(thresholds.data ?? []).length === 0 && (
        <Typography.Paragraph type="secondary">
          {t('profitability.alertList.noThresholds')}
        </Typography.Paragraph>
      )}
      {company.map((row) => (
        <div key={`${row.id}-${row.version}`}>
          <Typography.Text strong>{t('profitability.alertList.company')}</Typography.Text>
          {can(profitabilityPermissions.thresholdManage) ? (
            <ThresholdForm threshold={row} onDone={saved} onError={failed} />
          ) : (
            <Typography.Paragraph>
              {row.marginFloorPercent}% / {row.overspendPercent}% / {row.receivableAgeDays}
            </Typography.Paragraph>
          )}
        </div>
      ))}
      {projectRows.length > 0 && (
        <Typography.Paragraph type="secondary">
          {t('profitability.alertList.thresholdScope')}: {projectRows.length}
        </Typography.Paragraph>
      )}
      {can(profitabilityPermissions.thresholdManage) && company.length === 0 && (
        <div>
          <Typography.Text strong>{t('profitability.alertList.add')}</Typography.Text>
          <ThresholdForm onDone={saved} onError={failed} />
        </div>
      )}
    </div>
  );
}

import { formatDate, formatDateTimeUtc, quotationsPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { AcceptDialog, RejectDialog } from './ActionDialogs';
import { quotationsApi, stageBody, type Quotation, type Stage } from './api';
import { MarginPanel } from './MarginPanel';
import { PrintPreview } from './PrintPreview';
import { StageEditor, stageProblem } from './StageEditor';

function QuotationEditor({ quotation }: { quotation: Quotation }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const draft = quotation.status === 'draft';
  const [title, setTitle] = useState(quotation.title);
  const [price, setPrice] = useState(quotation.price);
  const [validity, setValidity] = useState(String(quotation.validityDays));
  const [scope, setScope] = useState(quotation.scopeText);
  const [inclusions, setInclusions] = useState(quotation.inclusions);
  const [exclusions, setExclusions] = useState(quotation.exclusions);
  const [terms, setTerms] = useState(quotation.terms);
  const [stages, setStages] = useState<Stage[]>(quotation.stages);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<'accept' | 'reject' | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    setTitle(quotation.title);
    setPrice(quotation.price);
    setValidity(String(quotation.validityDays));
    setScope(quotation.scopeText);
    setInclusions(quotation.inclusions);
    setExclusions(quotation.exclusions);
    setTerms(quotation.terms);
    setStages(quotation.stages);
  }, [quotation]);

  const messageOf = (cause: unknown) =>
    cause instanceof ApiError
      ? t(`quotations.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
  const fail = (cause: unknown) => {
    setSaved(false);
    setError(messageOf(cause));
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['quotations'] });

  const save = useMutation({
    mutationFn: () =>
      quotationsApi.update(quotation.id, {
        title,
        price: price.trim(),
        validityDays: Number(validity),
        scopeText: scope,
        inclusions,
        exclusions,
        terms,
        stages: stages.map(stageBody),
        version: quotation.version,
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await refresh();
    },
    onError: fail,
  });

  const step = useMutation({
    mutationFn: (run: () => Promise<Quotation>) => run(),
    onSuccess: async () => {
      setError(null);
      setSaved(false);
      setDialog(null);
      await refresh();
    },
    onError: fail,
  });

  const revise = useMutation({
    mutationFn: () => quotationsApi.revise(quotation.id),
    onSuccess: async (next) => {
      await refresh();
      void navigate(`/quotations/${next.id}`);
    },
    onError: fail,
  });

  const download = useMutation({
    mutationFn: async () => {
      const blob = await quotationsApi.pdf(quotation.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    },
    onError: fail,
  });

  const canSave = draft && can(perm.update) && stageProblem(stages) === null;
  const revisable = ['issued', 'rejected', 'expired'].includes(quotation.status);

  return (
    <div>
      <Link to="/quotations">{t('quotations.back')}</Link>
      <Typography.Title level={3}>
        {quotation.displayNumber} <Tag>{t(`quotations.status.${quotation.status}`)}</Tag>
        {quotation.revision > 1 && (
          <Tag>{t('quotations.revision', { revision: quotation.revision })}</Tag>
        )}
      </Typography.Title>
      {!draft && (
        <Alert type="info" message={t('quotations.readOnly')} style={{ marginBottom: 12 }} />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {saved && <Alert type="success" message={t('common.saved')} style={{ marginBottom: 12 }} />}

      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('quotations.field.sector')}>
          {t(`quotations.sector.${quotation.sector}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('quotations.approval.title')}>
          {quotation.approval.status === 'pending'
            ? t('quotations.approval.pending', { role: quotation.approval.currentRole })
            : t(`quotations.approval.${quotation.approval.status}`, {
                defaultValue: quotation.approval.status,
              })}
        </Descriptions.Item>
        {quotation.expiresOn !== null && (
          <Descriptions.Item label={t('quotations.field.expiresOn')}>
            {formatDate(quotation.expiresOn)}
          </Descriptions.Item>
        )}
      </Descriptions>

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Input
          addonBefore={t('quotations.field.title')}
          aria-label={t('quotations.field.title')}
          disabled={!draft}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Space wrap>
          <Input
            addonBefore={t('quotations.field.price')}
            aria-label={t('quotations.field.price')}
            inputMode="decimal"
            disabled={!draft}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <Input
            addonBefore={t('quotations.field.validity')}
            aria-label={t('quotations.field.validity')}
            inputMode="numeric"
            disabled={!draft}
            value={validity}
            onChange={(event) => setValidity(event.target.value)}
          />
        </Space>
        {(
          [
            ['scope', scope, setScope],
            ['inclusions', inclusions, setInclusions],
            ['exclusions', exclusions, setExclusions],
            ['terms', terms, setTerms],
          ] as const
        ).map(([key, value, set]) => (
          <Input.TextArea
            key={key}
            aria-label={t(`quotations.field.${key}`)}
            placeholder={t(`quotations.field.${key}`)}
            rows={3}
            disabled={!draft}
            value={value}
            onChange={(event) => set(event.target.value)}
          />
        ))}
        {quotation.margin !== null && <MarginPanel margin={quotation.margin} />}
        <StageEditor stages={stages} onChange={setStages} disabled={!draft} />

        <Space wrap>
          {draft && can(perm.update) && (
            <Button
              type="primary"
              disabled={!canSave}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('quotations.action.save')}
            </Button>
          )}
          {draft && can(perm.submit) && (
            <Button
              loading={step.isPending}
              onClick={() =>
                step.mutate(() => quotationsApi.submit(quotation.id, quotation.version))
              }
            >
              {t('quotations.action.submit')}
            </Button>
          )}
          {quotation.status === 'approved' && can(perm.issue) && (
            <Button
              type="primary"
              loading={step.isPending}
              onClick={() =>
                step.mutate(() => quotationsApi.issue(quotation.id, quotation.version))
              }
            >
              {t('quotations.action.issue')}
            </Button>
          )}
          {quotation.status === 'issued' && can(perm.accept) && (
            <Button type="primary" onClick={() => setDialog('accept')}>
              {t('quotations.action.accept')}
            </Button>
          )}
          {quotation.status === 'issued' && can(perm.reject) && (
            <Button danger onClick={() => setDialog('reject')}>
              {t('quotations.action.reject')}
            </Button>
          )}
          {revisable && can(perm.create) && (
            <Button loading={revise.isPending} onClick={() => revise.mutate()}>
              {t('quotations.action.revise')}
            </Button>
          )}
          <Button onClick={() => setPreview(!preview)}>{t('quotations.action.print')}</Button>
          <Button loading={download.isPending} onClick={() => download.mutate()}>
            {t('quotations.action.pdf')}
          </Button>
        </Space>

        {preview && <PrintPreview id={quotation.id} />}

        <Table
          rowKey={(_, index) => String(index)}
          size="small"
          pagination={false}
          title={() => t('quotations.history.title')}
          dataSource={quotation.history}
          columns={[
            { title: t('quotations.history.at'), render: (_, row) => formatDateTimeUtc(row.at) },
            {
              title: t('quotations.history.change'),
              render: (_, row) => t(`quotations.status.${row.toStatus}`),
            },
            { title: t('quotations.history.note'), dataIndex: 'note' },
          ]}
        />
      </Space>

      {dialog === 'accept' && (
        <AcceptDialog
          quotationId={quotation.id}
          sector={quotation.sector}
          error={error}
          busy={step.isPending}
          onCancel={() => setDialog(null)}
          onConfirm={(input) =>
            step.mutate(() =>
              quotationsApi.accept(quotation.id, { version: quotation.version, ...input }),
            )
          }
        />
      )}
      {dialog === 'reject' && (
        <RejectDialog
          error={error}
          busy={step.isPending}
          onCancel={() => setDialog(null)}
          onConfirm={(reason) =>
            step.mutate(() =>
              quotationsApi.reject(quotation.id, { version: quotation.version, reason }),
            )
          }
        />
      )}
    </div>
  );
}

export function QuotationEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const quotation = useQuery({
    queryKey: ['quotations', 'one', id],
    queryFn: () => quotationsApi.get(id as string),
    enabled: id !== undefined,
  });
  if (quotation.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (quotation.data === undefined) return null;
  return <QuotationEditor quotation={quotation.data} />;
}

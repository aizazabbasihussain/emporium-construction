import {
  formatAmount,
  formatDate,
  formatDateTimeUtc,
  variationEntityType,
  variationsPermissions as perm,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { useLineReferences } from '../estimation/lists';
import { AttachmentUploader } from '../files/AttachmentUploader';
import { variationsApi, type Variation, type VariationLine } from './api';
import { LinesEditor, linesProblem } from './LinesEditor';

type Dialog = 'approve' | 'reject' | null;

function ClientApproveDialog({
  variationId,
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  variationId: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (input: { reference: string; approvedOn: string }) => void;
}) {
  const { t } = useTranslation();
  const [reference, setReference] = useState('');
  const [approvedOn, setApprovedOn] = useState(new Date().toISOString().slice(0, 10));
  const [missing, setMissing] = useState(false);
  return (
    <Modal
      open
      title={t('variations.approve.title')}
      okText={t('variations.approve.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={() => {
        if (reference.trim() === '' || approvedOn === '') {
          setMissing(true);
          return;
        }
        setMissing(false);
        onConfirm({ reference: reference.trim(), approvedOn });
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {missing && <Alert type="error" message={t('variations.approve.incomplete')} />}
        {error !== null && <Alert type="error" message={error} />}
        <Input
          aria-label={t('variations.approve.reference')}
          placeholder={t('variations.approve.reference')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <Input
          type="date"
          addonBefore={t('variations.approve.date')}
          aria-label={t('variations.approve.date')}
          value={approvedOn}
          onChange={(event) => setApprovedOn(event.target.value)}
        />
        <Typography.Text>{t('variations.approve.document')}</Typography.Text>
        <AttachmentUploader entityType={variationEntityType} entityId={variationId} />
      </Space>
    </Modal>
  );
}

function ClientRejectDialog({
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <Modal
      open
      title={t('variations.reject.title')}
      okText={t('variations.reject.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onCancel}
      onOk={() => {
        if (reason.trim() === '') {
          setMissing(true);
          return;
        }
        onConfirm(reason.trim());
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {missing && <Alert type="error" message={t('variations.reject.incomplete')} />}
        {error !== null && <Alert type="error" message={error} />}
        <Input.TextArea
          aria-label={t('variations.reject.reason')}
          placeholder={t('variations.reject.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

function VariationEditor({ variation }: { variation: Variation }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { costCodeOptions } = useLineReferences();
  const draft = variation.status === 'draft';
  const [title, setTitle] = useState(variation.title);
  const [reason, setReason] = useState(variation.reason);
  const [discoveredOn, setDiscoveredOn] = useState(variation.discoveredOn);
  const [lines, setLines] = useState<VariationLine[]>(variation.lines);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    setTitle(variation.title);
    setReason(variation.reason);
    setDiscoveredOn(variation.discoveredOn);
    setLines(variation.lines);
  }, [variation]);

  const fail = (cause: unknown) => {
    setSaved(false);
    setError(
      cause instanceof ApiError
        ? t(`variations.errors.${cause.code}`, { defaultValue: cause.message })
        : t('common.saveError'),
    );
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['variations'] });

  const save = useMutation({
    mutationFn: () =>
      variationsApi.update(variation.id, variation.version, {
        title,
        reason,
        discoveredOn,
        lines: lines.map(({ description, costCodeId, costAmount, priceAmount }) => ({
          description,
          costCodeId,
          costAmount: costAmount.trim(),
          priceAmount: priceAmount.trim(),
        })),
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await refresh();
    },
    onError: fail,
  });

  const step = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setError(null);
      setSaved(false);
      setDialog(null);
      await refresh();
    },
    onError: fail,
  });

  const copy = useMutation({
    mutationFn: () => variationsApi.copy(variation.id),
    onSuccess: async (next) => {
      await refresh();
      void navigate(`/variations/${next.id}`);
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: () => variationsApi.remove(variation.id, variation.version),
    onSuccess: async () => {
      await refresh();
      void navigate(`/projects/${variation.projectId}`);
    },
    onError: fail,
  });

  const approval = variation.approval;
  const approved = approval.status === 'approved';
  const canSave = draft && can(perm.update) && linesProblem(lines) === null && title.trim() !== '';
  const labelOf = (id: string) => costCodeOptions.find((o) => o.value === id)?.label ?? id;

  return (
    <div>
      <Link to={`/projects/${variation.projectId}`}>{t('variations.back')}</Link>
      <Typography.Title level={3}>
        {variation.number} <Tag>{t(`variations.status.${variation.status}`)}</Tag>
      </Typography.Title>
      {!draft && (
        <Alert type="info" message={t('variations.readOnly')} style={{ marginBottom: 12 }} />
      )}
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {saved && <Alert type="success" message={t('common.saved')} style={{ marginBottom: 12 }} />}

      <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
        <Descriptions.Item label={t('variations.field.priceImpact')}>
          {formatAmount(variation.priceImpact)}
        </Descriptions.Item>
        <Descriptions.Item label={t('variations.field.costImpact')}>
          {formatAmount(variation.costImpact)}
        </Descriptions.Item>
        <Descriptions.Item label={t('variations.approval.title')}>
          {approval.status === 'pending'
            ? t('variations.approval.pending', { role: approval.currentRole })
            : t(`variations.approval.${approval.status}`, { defaultValue: approval.status })}
        </Descriptions.Item>
        {variation.clientApprovalRef !== null && (
          <Descriptions.Item label={t('variations.field.clientRef')}>
            {variation.clientApprovalRef}
            {variation.clientApprovedOn !== null && ` (${formatDate(variation.clientApprovedOn)})`}
          </Descriptions.Item>
        )}
      </Descriptions>

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Input
          addonBefore={t('variations.field.title')}
          aria-label={t('variations.field.title')}
          disabled={!draft}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Input.TextArea
          aria-label={t('variations.field.reason')}
          placeholder={t('variations.field.reason')}
          rows={3}
          disabled={!draft}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Input
          type="date"
          addonBefore={t('variations.field.discoveredOn')}
          aria-label={t('variations.field.discoveredOn')}
          disabled={!draft}
          value={discoveredOn}
          onChange={(event) => setDiscoveredOn(event.target.value)}
        />
        <LinesEditor
          lines={lines}
          costCodeOptions={costCodeOptions}
          readOnly={!draft}
          onChange={setLines}
        />

        <Space wrap>
          {draft && can(perm.update) && (
            <Button
              type="primary"
              disabled={!canSave}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('variations.action.save')}
            </Button>
          )}
          {draft && can(perm.update) && (
            <Button
              loading={step.isPending}
              onClick={() =>
                step.mutate(() => variationsApi.submitInternal(variation.id, variation.version))
              }
            >
              {t('variations.action.submitInternal')}
            </Button>
          )}
          {variation.status === 'pending_internal_approval' && approved && can(perm.update) && (
            <Button
              type="primary"
              loading={step.isPending}
              onClick={() =>
                step.mutate(() => variationsApi.sendToClient(variation.id, variation.version))
              }
            >
              {t('variations.action.sendToClient')}
            </Button>
          )}
          {variation.status === 'submitted_to_client' && can(perm.clientApprove) && (
            <Button type="primary" onClick={() => setDialog('approve')}>
              {t('variations.action.clientApprove')}
            </Button>
          )}
          {variation.status === 'submitted_to_client' && can(perm.clientApprove) && (
            <Button danger onClick={() => setDialog('reject')}>
              {t('variations.action.clientReject')}
            </Button>
          )}
          {['draft', 'pending_internal_approval', 'submitted_to_client'].includes(
            variation.status,
          ) &&
            can(perm.update) && (
              <Button
                danger
                loading={step.isPending}
                onClick={() =>
                  step.mutate(() => variationsApi.cancel(variation.id, variation.version))
                }
              >
                {t('variations.action.cancel')}
              </Button>
            )}
          {draft && can(perm.update) && (
            <Button danger loading={remove.isPending} onClick={() => remove.mutate()}>
              {t('variations.action.delete')}
            </Button>
          )}
          {variation.status === 'client_rejected' && can(perm.create) && (
            <Button loading={copy.isPending} onClick={() => copy.mutate()}>
              {t('variations.action.copy')}
            </Button>
          )}
        </Space>

        {variation.atRisk.byCostCode.length > 0 || Number(variation.atRisk.total) > 0 ? (
          <Table
            rowKey="costCodeId"
            size="small"
            pagination={false}
            title={() => (
              <Space direction="vertical" size={0}>
                <strong>{t('variations.atRisk.title')}</strong>
                <Typography.Text type="secondary">{t('variations.atRisk.hint')}</Typography.Text>
              </Space>
            )}
            dataSource={variation.atRisk.byCostCode}
            columns={[
              {
                title: t('variations.lines.costCode'),
                render: (_, row) => labelOf(row.costCodeId),
              },
              {
                title: t('variations.field.atRisk'),
                align: 'right',
                render: (_, row) => formatAmount(row.amount),
              },
            ]}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}>{t('variations.atRisk.total')}</Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <Tag color="red">{formatAmount(variation.atRisk.total)}</Tag>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        ) : (
          <Alert type="success" message={t('variations.atRisk.none')} />
        )}

        <Table
          rowKey={(_, index) => String(index)}
          size="small"
          pagination={false}
          title={() => t('variations.timeline.title')}
          dataSource={variation.history}
          columns={[
            { title: t('variations.timeline.at'), render: (_, row) => formatDateTimeUtc(row.at) },
            {
              title: t('variations.timeline.change'),
              render: (_, row) => t(`variations.status.${row.toStatus}`),
            },
            { title: t('variations.timeline.note'), dataIndex: 'note' },
          ]}
        />
      </Space>

      {dialog === 'approve' && (
        <ClientApproveDialog
          variationId={variation.id}
          error={error}
          busy={step.isPending}
          onCancel={() => setDialog(null)}
          onConfirm={(input) =>
            step.mutate(() =>
              variationsApi.clientApprove(variation.id, { version: variation.version, ...input }),
            )
          }
        />
      )}
      {dialog === 'reject' && (
        <ClientRejectDialog
          error={error}
          busy={step.isPending}
          onCancel={() => setDialog(null)}
          onConfirm={(reasonText) =>
            step.mutate(() =>
              variationsApi.clientReject(variation.id, variation.version, reasonText),
            )
          }
        />
      )}
    </div>
  );
}

export function VariationEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const variation = useQuery({
    queryKey: ['variations', 'one', id],
    queryFn: () => variationsApi.get(id as string),
    enabled: id !== undefined,
  });
  if (variation.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (variation.data === undefined) return null;
  return <VariationEditor variation={variation.data} />;
}

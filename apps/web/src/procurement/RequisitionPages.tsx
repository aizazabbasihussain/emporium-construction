import { formatAmount, procurementPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { procurementApi, type LineDraft, type RequisitionHeader } from './api';
import { emptyLine, linesProblem, ProcurementLinesEditor } from './LinesEditor';
import { useProcurementReferences } from './references';
import { useErrorText } from './shared';

/** BR-1: requisitions name a project (direct to site) or a store (replenishment). */
export function RequisitionsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<'project' | 'store'>('project');
  const [projectId, setProjectId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [requiredBy, setRequiredBy] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['requisitions'], queryFn: procurementApi.requisitions });

  const create = useMutation({
    mutationFn: () =>
      procurementApi.createRequisition({
        ...(target === 'project' ? { projectId } : { storeId: storeId.trim() }),
        ...(requiredBy === '' ? {} : { requiredBy }),
        note: note.trim(),
        lines: lines.map((l) => ({
          itemId: l.itemId,
          quantity: l.quantity.trim(),
          costCodeId: l.costCodeId,
          ...(l.rate.trim() === '' ? {} : { estimatedRate: l.rate.trim() }),
        })),
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['requisitions'] });
      void navigate(`/procurement/requisitions/${created.id}`);
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    const destination = target === 'project' ? projectId : storeId.trim();
    if (destination === '') {
      setError(t('procurement.requisition.destinationRequired'));
      return;
    }
    if (linesProblem(lines, false) !== null) {
      setError(t('procurement.requisition.linesIncomplete'));
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <h2>{t('procurement.requisition.title')}</h2>
        {can(perm.requisitionCreate) ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            {t('procurement.requisition.new')}
          </Button>
        ) : null}
      </Space>
      <Table<RequisitionHeader>
        rowKey="id"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('procurement.field.number'),
            render: (_, row) => (
              <Link to={`/procurement/requisitions/${row.id}`}>{row.number}</Link>
            ),
          },
          {
            title: t('procurement.field.destination'),
            render: (_, row) =>
              row.projectId === null
                ? t('procurement.destination.store')
                : refs.projectName(row.projectId),
          },
          { title: t('procurement.field.requiredBy'), dataIndex: 'requiredBy' },
          {
            title: t('procurement.field.status'),
            render: (_, row) => <Tag>{t(`procurement.requisition.status.${row.status}`)}</Tag>,
          },
        ]}
      />
      <Modal
        open={open}
        title={t('procurement.requisition.new')}
        width={900}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>,
          <Button key="create" type="primary" loading={create.isPending} onClick={submit}>
            {t('procurement.requisition.create')}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Radio.Group
            value={target}
            onChange={(event) => setTarget(event.target.value as 'project' | 'store')}
          >
            <Radio value="project">{t('procurement.destination.project')}</Radio>
            <Radio value="store">{t('procurement.destination.store')}</Radio>
          </Radio.Group>
          {target === 'project' ? (
            <Select
              aria-label={t('procurement.destination.project')}
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
              options={refs.projectOptions}
              value={projectId === '' ? undefined : projectId}
              onChange={setProjectId}
            />
          ) : (
            <Input
              aria-label={t('procurement.destination.storeId')}
              placeholder={t('procurement.destination.storeId')}
              value={storeId}
              onChange={(event) => setStoreId(event.target.value)}
            />
          )}
          <DatePicker
            aria-label={t('procurement.field.requiredBy')}
            onChange={(_, text) => setRequiredBy(typeof text === 'string' ? text : '')}
          />
          <Input
            aria-label={t('procurement.field.note')}
            placeholder={t('procurement.field.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <ProcurementLinesEditor
            lines={lines}
            itemOptions={refs.itemOptions}
            costCodeOptions={refs.costCodeOptions}
            rateLabel={t('procurement.lines.estimate')}
            onChange={setLines}
          />
          {error === null ? null : <Alert type="error" showIcon message={error} />}
        </Space>
      </Modal>
    </div>
  );
}

export function RequisitionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [vendors, setVendors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const requisition = useQuery({
    queryKey: ['requisition', id],
    queryFn: () => procurementApi.requisition(id),
  });
  const rfqs = useQuery({ queryKey: ['rfqs', id], queryFn: () => procurementApi.rfqs(id) });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['requisition', id] });
    void queryClient.invalidateQueries({ queryKey: ['requisitions'] });
  };
  const act = useMutation({
    mutationFn: (action: 'submit' | 'cancel') =>
      procurementApi.requisitionAction(id, action, requisition.data?.version ?? 0),
    onSuccess: refresh,
    onError: (cause) => setError(errorText(cause)),
  });
  const startRfq = useMutation({
    mutationFn: () => procurementApi.createRfq(id, vendors),
    onSuccess: (rfq) => void navigate(`/procurement/rfqs/${rfq.id}`),
    onError: (cause) => setError(errorText(cause)),
  });

  const data = requisition.data;
  if (data === undefined) return null;
  const sourcing = data.status === 'approved' || data.status === 'partly_ordered';
  return (
    <div>
      <h2>{data.number}</h2>
      <Descriptions column={2} size="small">
        <Descriptions.Item label={t('procurement.field.status')}>
          {t(`procurement.requisition.status.${data.status}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.field.destination')}>
          {data.projectId === null
            ? t('procurement.destination.store')
            : refs.projectName(data.projectId)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.field.requiredBy')}>
          {data.requiredBy ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.field.note')}>{data.note}</Descriptions.Item>
      </Descriptions>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={data.lines}
        columns={[
          { title: t('procurement.lines.item'), render: (_, l) => refs.itemName(l.itemId) },
          { title: t('procurement.lines.quantity'), dataIndex: 'quantity' },
          { title: t('procurement.lines.ordered'), dataIndex: 'orderedQty' },
          {
            title: t('procurement.lines.estimate'),
            render: (_, l) => (l.estimatedRate === null ? '-' : formatAmount(l.estimatedRate)),
          },
        ]}
      />
      <Space style={{ marginTop: 16 }}>
        {data.status === 'draft' && can(perm.requisitionCreate) ? (
          <Button type="primary" onClick={() => act.mutate('submit')}>
            {t('procurement.requisition.submit')}
          </Button>
        ) : null}
        {['draft', 'pending_approval', 'approved'].includes(data.status) &&
        can(perm.requisitionCreate) ? (
          <Button onClick={() => act.mutate('cancel')}>
            {t('procurement.requisition.cancel')}
          </Button>
        ) : null}
      </Space>
      {sourcing && can(perm.rfqManage) ? (
        <div style={{ marginTop: 24 }}>
          <h3>{t('procurement.rfq.title')}</h3>
          <Space>
            <Select
              mode="multiple"
              aria-label={t('procurement.rfq.vendors')}
              style={{ minWidth: 320 }}
              options={refs.vendorOptions}
              value={vendors}
              onChange={setVendors}
            />
            <Button disabled={vendors.length === 0} onClick={() => startRfq.mutate()}>
              {t('procurement.rfq.create')}
            </Button>
          </Space>
        </div>
      ) : null}
      {(rfqs.data?.items ?? []).map((rfq) => (
        <div key={rfq.id}>
          <Link to={`/procurement/rfqs/${rfq.id}`}>{rfq.number}</Link>
        </div>
      ))}
      {error === null ? null : (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} />
      )}
    </div>
  );
}

import { formatAmount, procurementPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import {
  procurementApi,
  type LineDraft,
  type PoBody,
  type PoHeader,
  type PurchaseOrder,
} from './api';
import { emptyLine, linesProblem, ProcurementLinesEditor } from './LinesEditor';
import { useProcurementReferences } from './references';
import { useErrorText } from './shared';

const today = () => new Date().toISOString().slice(0, 10);

const bodyOf = (
  vendorId: string,
  target: 'project' | 'store',
  destination: string,
  orderDate: string,
  terms: string,
  lines: LineDraft[],
): PoBody => ({
  vendorId,
  ...(target === 'project' ? { projectId: destination } : { storeId: destination.trim() }),
  orderDate,
  terms: terms.trim(),
  lines: lines.map((l) => ({
    ...(l.lineId === undefined ? {} : { lineId: l.lineId }),
    itemId: l.itemId,
    quantity: l.quantity.trim(),
    rate: l.rate.trim(),
    costCodeId: l.costCodeId,
  })),
});

/** The orders and the lines still to come (spec section 5: open PO list). */
export function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [target, setTarget] = useState<'project' | 'store'>('project');
  const [destination, setDestination] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const orders = useQuery({ queryKey: ['orders'], queryFn: () => procurementApi.orders() });
  const openLines = useQuery({ queryKey: ['open-lines'], queryFn: procurementApi.openLines });
  const create = useMutation({
    mutationFn: () =>
      procurementApi.createOrder(bodyOf(vendorId, target, destination, today(), terms, lines)),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void navigate(`/procurement/purchase-orders/${created.id}`);
    },
    onError: (cause) => setError(errorText(cause)),
  });
  const submit = () => {
    if (vendorId === '' || destination.trim() === '') {
      setError(t('procurement.order.incomplete'));
      return;
    }
    if (linesProblem(lines, true) !== null) {
      setError(t('procurement.requisition.linesIncomplete'));
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <h2>{t('procurement.order.title')}</h2>
        {can(perm.poCreate) ? (
          <Button type="primary" onClick={() => setOpen(true)}>
            {t('procurement.order.new')}
          </Button>
        ) : null}
      </Space>
      <Tabs
        items={[
          {
            key: 'orders',
            label: t('procurement.order.title'),
            children: (
              <Table<PoHeader>
                rowKey="id"
                loading={orders.isLoading}
                dataSource={orders.data?.items ?? []}
                columns={[
                  {
                    title: t('procurement.field.number'),
                    render: (_, row) => (
                      <Link to={`/procurement/purchase-orders/${row.id}`}>{row.number}</Link>
                    ),
                  },
                  {
                    title: t('procurement.order.vendor'),
                    render: (_, row) => refs.vendorName(row.vendorId),
                  },
                  {
                    title: t('procurement.order.total'),
                    render: (_, row) => formatAmount(row.total),
                  },
                  {
                    title: t('procurement.field.status'),
                    render: (_, row) => <Tag>{t(`procurement.order.status.${row.status}`)}</Tag>,
                  },
                ]}
              />
            ),
          },
          {
            key: 'open',
            label: t('procurement.order.openLines'),
            children: (
              <Table
                rowKey="lineId"
                loading={openLines.isLoading}
                dataSource={openLines.data ?? []}
                columns={[
                  {
                    title: t('procurement.field.number'),
                    render: (_, row) => (
                      <Link to={`/procurement/purchase-orders/${row.poId}`}>{row.poNumber}</Link>
                    ),
                  },
                  {
                    title: t('procurement.lines.item'),
                    render: (_, row) => refs.itemName(row.itemId),
                  },
                  { title: t('procurement.order.openQty'), dataIndex: 'openQty' },
                  { title: t('procurement.order.expected'), dataIndex: 'expectedDate' },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        open={open}
        width={900}
        title={t('procurement.order.new')}
        onCancel={() => setOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>,
          <Button key="create" type="primary" loading={create.isPending} onClick={submit}>
            {t('procurement.order.create')}
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select
            aria-label={t('procurement.order.vendor')}
            style={{ width: '100%' }}
            showSearch
            optionFilterProp="label"
            options={refs.vendorOptions}
            value={vendorId === '' ? undefined : vendorId}
            onChange={setVendorId}
          />
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
              options={refs.projectOptions}
              value={destination === '' ? undefined : destination}
              onChange={setDestination}
            />
          ) : (
            <Input
              aria-label={t('procurement.destination.storeId')}
              placeholder={t('procurement.destination.storeId')}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            />
          )}
          <Input
            aria-label={t('procurement.order.terms')}
            placeholder={t('procurement.order.terms')}
            value={terms}
            onChange={(event) => setTerms(event.target.value)}
          />
          <ProcurementLinesEditor
            lines={lines}
            itemOptions={refs.itemOptions}
            costCodeOptions={refs.costCodeOptions}
            rateLabel={t('procurement.lines.rate')}
            onChange={setLines}
          />
          {error === null ? null : <Alert type="error" showIcon message={error} />}
        </Space>
      </Modal>
    </div>
  );
}

const editable = (po: PurchaseOrder) => po.status === 'draft';
const draftsOf = (po: PurchaseOrder): LineDraft[] =>
  po.lines.map((l) => ({
    lineId: l.id,
    itemId: l.itemId,
    quantity: l.quantity,
    rate: l.rate,
    costCodeId: l.costCodeId,
  }));

/** One order: lines, actions, the print layout and the way into receiving. */
export function PurchaseOrderPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const refs = useProcurementReferences();
  const errorText = useErrorText();
  const [lines, setLines] = useState<LineDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const order = useQuery({ queryKey: ['order', id], queryFn: () => procurementApi.order(id) });
  const print = useQuery({
    queryKey: ['order-print', id],
    queryFn: () => procurementApi.printModel(id),
  });
  const refresh = () => {
    setLines(null);
    void queryClient.invalidateQueries({ queryKey: ['order', id] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const onError = (cause: unknown) => setError(errorText(cause));
  const act = useMutation({
    mutationFn: (action: 'submit' | 'close' | 'cancel') =>
      procurementApi.orderAction(id, action, order.data?.version ?? 0),
    onSuccess: refresh,
    onError,
  });
  const body = (po: PurchaseOrder, drafts: LineDraft[]) =>
    bodyOf(
      po.vendorId,
      po.projectId === null ? 'store' : 'project',
      po.projectId ?? po.storeId ?? '',
      po.orderDate,
      po.terms,
      drafts,
    );
  const save = useMutation({
    mutationFn: (v: { po: PurchaseOrder; drafts: LineDraft[] }) =>
      procurementApi.updateOrder(id, v.po.version, body(v.po, v.drafts)),
    onSuccess: refresh,
    onError,
  });
  const amend = useMutation({
    mutationFn: (v: { po: PurchaseOrder; drafts: LineDraft[] }) =>
      procurementApi.amendOrder(id, v.po.version, body(v.po, v.drafts)),
    onSuccess: refresh,
    onError,
  });

  const po = order.data;
  if (po === undefined) return null;
  const current = lines ?? draftsOf(po);
  const amendable = ['approved', 'partly_received', 'received'].includes(po.status);
  const receivable = po.status === 'approved' || po.status === 'partly_received';
  const complete = linesProblem(current, true) === null;
  return (
    <div>
      <h2>
        {po.number} <small>v{po.revision}</small>
      </h2>
      <Descriptions column={2} size="small">
        <Descriptions.Item label={t('procurement.order.vendor')}>
          {refs.vendorName(po.vendorId)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.field.status')}>
          {t(`procurement.order.status.${po.status}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.field.destination')}>
          {po.projectId === null
            ? t('procurement.destination.store')
            : refs.projectName(po.projectId)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.order.total')}>
          {formatAmount(po.total)}
        </Descriptions.Item>
        <Descriptions.Item label={t('procurement.order.terms')}>{po.terms}</Descriptions.Item>
        {print.data?.vendor.address ? (
          <Descriptions.Item label={t('procurement.order.vendorAddress')}>
            {print.data.vendor.address}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <ProcurementLinesEditor
        lines={current}
        itemOptions={refs.itemOptions}
        costCodeOptions={refs.costCodeOptions}
        rateLabel={t('procurement.lines.rate')}
        readOnly={!(editable(po) || amendable) || !can(perm.poCreate)}
        onChange={setLines}
      />
      <Space style={{ marginTop: 16 }} wrap>
        {editable(po) && can(perm.poCreate) ? (
          <>
            <Button disabled={!complete} onClick={() => save.mutate({ po, drafts: current })}>
              {t('common.save')}
            </Button>
            <Button type="primary" onClick={() => act.mutate('submit')}>
              {t('procurement.order.submit')}
            </Button>
          </>
        ) : null}
        {amendable && can(perm.poAmend) ? (
          <Button disabled={!complete} onClick={() => amend.mutate({ po, drafts: current })}>
            {t('procurement.order.amend')}
          </Button>
        ) : null}
        {amendable && can(perm.poClose) ? (
          <Button onClick={() => act.mutate('close')}>{t('procurement.order.close')}</Button>
        ) : null}
        {['draft', 'pending_approval', 'approved'].includes(po.status) && can(perm.poClose) ? (
          <Button onClick={() => act.mutate('cancel')}>{t('procurement.order.cancel')}</Button>
        ) : null}
        {receivable && can(perm.grnCreate) ? (
          <Link to={`/procurement/receiving/${po.id}`}>
            <Button type="primary">{t('procurement.receiving.receive')}</Button>
          </Link>
        ) : null}
        <Button onClick={() => window.print()}>{t('procurement.order.print')}</Button>
      </Space>
      {error === null ? null : (
        <Alert style={{ marginTop: 16 }} type="error" showIcon message={error} />
      )}
    </div>
  );
}

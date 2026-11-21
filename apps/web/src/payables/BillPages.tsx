import { billStatuses, formatAmount, formatDate, type BillStatus } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { payablesApi, type Bill, type BillBody, type PickOrder, type PickReceipt } from './api';
import { billProblem, lineAmount, optional, type BillFormLine } from './form';
import { failure, today, useVendors } from './hooks';

/** The bills queue by status (spec P2-05 section 5). */
export function BillsPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<BillStatus | undefined>(undefined);
  const { nameOf } = useVendors();
  const bills = useQuery({
    queryKey: ['payables', 'bills', status ?? 'all'],
    queryFn: () => payablesApi.bills(status),
  });
  return (
    <div>
      <Typography.Title level={3}>{t('payables.bills.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Select
          aria-label={t('payables.common.status')}
          allowClear
          placeholder={t('payables.common.status')}
          style={{ width: 200 }}
          value={status}
          onChange={(value) => setStatus(value)}
          options={billStatuses.map((value) => ({
            value,
            label: t(`payables.status.${value}`),
          }))}
        />
        <Link to="/payables/bills/new">
          <Button type="primary">{t('payables.bills.new')}</Button>
        </Link>
      </Space>
      {bills.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Bill>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('payables.bills.none') }}
        dataSource={bills.data?.items ?? []}
        columns={[
          {
            title: t('payables.bills.number'),
            render: (_, row) => <Link to={`/payables/bills/${row.id}`}>{row.number}</Link>,
          },
          { title: t('payables.common.vendor'), render: (_, row) => nameOf(row.vendorPartyId) },
          { title: t('payables.bills.invoiceNo'), dataIndex: 'vendorInvoiceNo' },
          { title: t('payables.bills.billDate'), render: (_, row) => formatDate(row.billDate) },
          { title: t('payables.bills.dueDate'), render: (_, row) => formatDate(row.dueDate) },
          {
            title: t('payables.bills.gross'),
            align: 'right',
            render: (_, row) => formatAmount(row.grossTotal),
          },
          {
            title: t('payables.common.status'),
            render: (_, row) => <Tag>{t(`payables.status.${row.status}`)}</Tag>,
          },
        ]}
      />
    </div>
  );
}

interface PickLine {
  grnId: string;
  grnLineId: string;
  label: string;
  quantity: string;
  rate: string;
}

/** A new bill with the order and receipt pick list (BR-1). */
export function BillEntryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { options } = useVendors();
  const [vendorPartyId, setVendorPartyId] = useState('');
  const [vendorInvoiceNo, setVendorInvoiceNo] = useState('');
  const [billDate, setBillDate] = useState(today());
  const [dueDate, setDueDate] = useState(today());
  const [nature, setNature] = useState('');
  const [notes, setNotes] = useState('');
  const [poId, setPoId] = useState('');
  const [lines, setLines] = useState<(BillFormLine & { label: string })[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const orders = useQuery({
    queryKey: ['payables', 'vendor-orders', vendorPartyId],
    queryFn: () => payablesApi.vendorOrders(vendorPartyId),
    enabled: vendorPartyId !== '',
  });
  const picks = useQuery({
    queryKey: ['payables', 'pick', poId],
    queryFn: async (): Promise<{ order: PickOrder; receipts: PickReceipt[] }> => {
      const order = await payablesApi.order(poId);
      const list = await payablesApi.orderReceipts(poId);
      return {
        order,
        receipts: await Promise.all(list.items.map((r) => payablesApi.receipt(r.id))),
      };
    },
    enabled: poId !== '',
  });

  const pickable: PickLine[] = (picks.data?.receipts ?? []).flatMap((receipt) =>
    receipt.lines.map((line) => {
      const poLine = picks.data?.order.lines.find((l) => l.id === line.poLineId);
      return {
        grnId: receipt.id,
        grnLineId: line.id,
        label: `${receipt.number} · ${poLine?.description ?? ''} #${poLine?.lineNo ?? ''}`,
        quantity: line.acceptedQty,
        rate: poLine?.rate ?? '0',
      };
    }),
  );

  const save = useMutation({
    mutationFn: () => {
      const body: BillBody = {
        vendorPartyId,
        vendorInvoiceNo: vendorInvoiceNo.trim(),
        billDate,
        dueDate,
        sourceType: 'purchase',
        ...(optional(nature) === undefined ? {} : { nature: nature.trim() }),
        ...(optional(notes) === undefined ? {} : { notes: notes.trim() }),
        lines: lines.map((line) => ({
          grnId: line.grnId,
          grnLineId: line.grnLineId,
          quantity: line.quantity.trim(),
          rate: line.rate.trim(),
        })),
      };
      return payablesApi.createBill(body);
    },
    onSuccess: (bill) => navigate(`/payables/bills/${bill.id}`),
    onError: (error) => setProblem(failure(t, error)),
  });

  const submit = () => {
    const found = billProblem({ vendorPartyId, vendorInvoiceNo, billDate, dueDate, lines });
    if (found !== null) {
      setProblem(t(`payables.bills.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };
  const setLine = (index: number, patch: Partial<BillFormLine>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <div>
      <Typography.Title level={3}>{t('payables.bills.newTitle')}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      <Space direction="vertical" style={{ maxWidth: 560, width: '100%' }}>
        <Select
          aria-label={t('payables.common.vendor')}
          placeholder={t('payables.common.vendor')}
          showSearch
          optionFilterProp="label"
          value={vendorPartyId === '' ? undefined : vendorPartyId}
          onChange={(value) => {
            setVendorPartyId(value);
            setPoId('');
            setLines([]);
          }}
          options={options}
        />
        <Input
          aria-label={t('payables.bills.invoiceNo')}
          placeholder={t('payables.bills.invoiceNo')}
          value={vendorInvoiceNo}
          onChange={(e) => setVendorInvoiceNo(e.target.value)}
        />
        <Input
          aria-label={t('payables.bills.billDate')}
          type="date"
          value={billDate}
          onChange={(e) => setBillDate(e.target.value)}
        />
        <Input
          aria-label={t('payables.bills.dueDate')}
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
        <Input
          aria-label={t('payables.bills.nature')}
          placeholder={t('payables.bills.nature')}
          value={nature}
          onChange={(e) => setNature(e.target.value)}
        />
        <Input
          aria-label={t('payables.common.notes')}
          placeholder={t('payables.common.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Space>

      {vendorPartyId !== '' && (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>{t('payables.bills.pick')}</Typography.Title>
          <Select
            aria-label={t('payables.bills.order')}
            placeholder={t('payables.bills.order')}
            style={{ width: 320 }}
            value={poId === '' ? undefined : poId}
            onChange={setPoId}
            options={(orders.data?.items ?? []).map((o) => ({ value: o.id, label: o.number }))}
          />
          <Table<PickLine>
            rowKey="grnLineId"
            size="small"
            pagination={false}
            style={{ marginTop: 8 }}
            locale={{ emptyText: t('payables.bills.noReceipts') }}
            dataSource={pickable}
            columns={[
              { title: t('payables.bills.receiptLine'), dataIndex: 'label' },
              {
                title: t('payables.bills.received'),
                align: 'right',
                render: (_, row) => row.quantity,
              },
              {
                title: t('payables.bills.orderRate'),
                align: 'right',
                render: (_, row) => formatAmount(row.rate),
              },
              {
                title: '',
                render: (_, row) => (
                  <Button
                    disabled={lines.some((l) => l.grnLineId === row.grnLineId)}
                    onClick={() => setLines([...lines, { ...row }])}
                  >
                    {t('payables.bills.add')}
                  </Button>
                ),
              },
            ]}
          />
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Typography.Title level={5}>{t('payables.bills.lines')}</Typography.Title>
        <Table<BillFormLine & { label: string }>
          rowKey="grnLineId"
          size="small"
          pagination={false}
          locale={{ emptyText: t('payables.bills.noLines') }}
          dataSource={lines}
          columns={[
            { title: t('payables.bills.receiptLine'), dataIndex: 'label' },
            {
              title: t('payables.bills.quantity'),
              render: (_, row, index) => (
                <Input
                  aria-label={`${t('payables.bills.quantity')} ${row.label}`}
                  value={row.quantity}
                  onChange={(e) => setLine(index, { quantity: e.target.value })}
                />
              ),
            },
            {
              title: t('payables.bills.rate'),
              render: (_, row, index) => (
                <Input
                  aria-label={`${t('payables.bills.rate')} ${row.label}`}
                  value={row.rate}
                  onChange={(e) => setLine(index, { rate: e.target.value })}
                />
              ),
            },
            {
              title: t('payables.bills.amount'),
              align: 'right',
              render: (_, row) => formatAmount(lineAmount(row.quantity, row.rate)),
            },
            {
              title: '',
              render: (_, row) => (
                <Button
                  onClick={() => setLines(lines.filter((l) => l.grnLineId !== row.grnLineId))}
                >
                  {t('payables.bills.remove')}
                </Button>
              ),
            },
          ]}
        />
      </div>
      <Button type="primary" style={{ marginTop: 16 }} loading={save.isPending} onClick={submit}>
        {t('payables.common.save')}
      </Button>
    </div>
  );
}

/** A bill with its match panel and the next step (match, submit, post, cancel). */
export function BillPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const client = useQueryClient();
  const { nameOf } = useVendors();
  const [overrideReason, setOverrideReason] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const bill = useQuery({
    queryKey: ['payables', 'bill', id],
    queryFn: () => payablesApi.bill(id),
  });
  const done = () => {
    setProblem(null);
    void client.invalidateQueries({ queryKey: ['payables'] });
  };
  const fail = (error: unknown) => setProblem(failure(t, error));
  const data = bill.data;
  const match = useMutation({
    mutationFn: () => payablesApi.match(data as Bill, overrideReason),
    onSuccess: done,
    onError: fail,
  });
  const step = useMutation({
    mutationFn: (action: 'submit' | 'post') => payablesApi.billAction(data as Bill, action),
    onSuccess: done,
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: () => payablesApi.cancelBill(data as Bill, reason),
    onSuccess: done,
    onError: fail,
  });
  if (bill.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (data === undefined) return null;
  const matchOf = (lineId: string) => data.matches.find((m) => m.billLineId === lineId);
  const cancellable =
    data.status !== 'cancelled' && data.status !== 'paid' && data.status !== 'partly_paid';

  return (
    <div>
      <Typography.Title level={3}>
        {data.number} <Tag>{t(`payables.status.${data.status}`)}</Tag>
      </Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {data.warnings.includes('above_open_commitments') && (
        <Alert
          type="warning"
          style={{ marginBottom: 8 }}
          message={t('payables.bills.aboveCommitments')}
        />
      )}
      <p>
        {nameOf(data.vendorPartyId)} · {data.vendorInvoiceNo} · {formatDate(data.billDate)} ·{' '}
        {formatDate(data.dueDate)}
      </p>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={data.lines}
        columns={[
          { title: t('payables.bills.description'), dataIndex: 'description' },
          { title: t('payables.bills.quantity'), dataIndex: 'quantity', align: 'right' },
          {
            title: t('payables.bills.rate'),
            align: 'right',
            render: (_, row) => formatAmount(row.rate),
          },
          {
            title: t('payables.bills.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          {
            title: t('payables.bills.match'),
            render: (_, row) => {
              const m = matchOf(row.id);
              if (m === undefined) return '';
              return m.withinTolerance
                ? t('payables.bills.matchOk')
                : t('payables.bills.matchVariance', {
                    qty: m.qtyVariance,
                    rate: formatAmount(m.rateVariance),
                  });
            },
          },
        ]}
      />
      <Space direction="vertical" style={{ marginTop: 12 }}>
        <div>
          {t('payables.bills.base')}: {formatAmount(data.baseAmount)} · {t('payables.bills.tax')}:{' '}
          {formatAmount(data.taxTotal)} · {t('payables.bills.gross')}:{' '}
          {formatAmount(data.grossTotal)}
        </div>
        <div>
          {t('payables.bills.withholding')}: {formatAmount(data.withholdingTotal)} ·{' '}
          {t('payables.bills.net')}: {formatAmount(data.netPayable)}
        </div>
        {data.matchOverrideReason !== null && (
          <div>
            {t('payables.bills.overridden')}: {data.matchOverrideReason}
          </div>
        )}
        {data.variances.map((v) => (
          <div key={v.id}>
            {t('payables.bills.variance', {
              amount: formatAmount(v.amount),
              treatment: t(`payables.treatment.${v.treatment}`),
            })}
          </div>
        ))}
      </Space>
      <Space style={{ marginTop: 12, display: 'flex' }} wrap>
        {data.status === 'draft' && (
          <>
            <Input
              aria-label={t('payables.bills.overrideReason')}
              placeholder={t('payables.bills.overrideReason')}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              style={{ width: 280 }}
            />
            <Button type="primary" loading={match.isPending} onClick={() => match.mutate()}>
              {t('payables.bills.runMatch')}
            </Button>
          </>
        )}
        {data.status === 'matched' && (
          <Button type="primary" loading={step.isPending} onClick={() => step.mutate('submit')}>
            {t('payables.bills.submit')}
          </Button>
        )}
        {data.status === 'pending_approval' && (
          <Typography.Text>
            {t('payables.bills.waiting', { role: data.approval.currentRole ?? '' })}
          </Typography.Text>
        )}
        {data.status === 'approved' && (
          <Button type="primary" loading={step.isPending} onClick={() => step.mutate('post')}>
            {t('payables.bills.post')}
          </Button>
        )}
        {cancellable && (
          <>
            <Input
              aria-label={t('payables.common.reason')}
              placeholder={t('payables.common.reason')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ width: 280 }}
            />
            <Button danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
              {t('payables.bills.cancel')}
            </Button>
          </>
        )}
      </Space>
    </div>
  );
}

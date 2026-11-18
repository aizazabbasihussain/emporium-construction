import { billingPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { billingApi, type ScheduleStage, type StageEdit } from './api';
import { isPositiveAmount, scheduleProblem } from './form';

const today = () => new Date().toISOString().slice(0, 10);

/** Billing of one project: the schedule, the advances, the new-invoice dialog and the invoices. */
export function ProjectBilling({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<StageEdit[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceDate, setAdvanceDate] = useState(today());

  const schedule = useQuery({
    queryKey: ['billing', projectId, 'schedule'],
    queryFn: () => billingApi.schedule(projectId),
  });
  const summary = useQuery({
    queryKey: ['billing', projectId, 'summary'],
    queryFn: () => billingApi.summary(projectId),
  });
  const invoices = useQuery({
    queryKey: ['billing', projectId, 'invoices'],
    queryFn: () => billingApi.invoices({ projectId }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['billing', projectId] });

  const saveSchedule = useMutation({
    mutationFn: (stages: StageEdit[]) => billingApi.editSchedule(projectId, stages),
    onSuccess: () => {
      setEditing(null);
      void refresh();
    },
  });
  const createInvoice = useMutation({
    mutationFn: () => billingApi.createInvoice(projectId, { scheduleIds: picked, invoiceDate }),
    onSuccess: (invoice) => {
      void refresh();
      void navigate(`/billing/invoices/${invoice.id}`);
    },
  });
  const requestAdvance = useMutation({
    mutationFn: () =>
      billingApi.requestAdvance({
        projectId,
        amount: advanceAmount.trim(),
        invoiceDate: advanceDate,
      }),
    onSuccess: ({ invoice }) => {
      void refresh();
      void navigate(`/billing/invoices/${invoice.id}`);
    },
  });

  const data = schedule.data;
  const planned = (data?.stages ?? []).filter((stage) => stage.status === 'planned');
  const invoicedNumbers = (data?.stages ?? [])
    .filter((stage) => stage.status !== 'planned')
    .map((stage) => stage.stageNo);

  const startEdit = () =>
    setEditing(
      planned.map((stage) => ({
        id: stage.id,
        stageNo: stage.stageNo,
        name: stage.name,
        amount: stage.amount,
      })),
    );
  const change = (index: number, patch: Partial<StageEdit>) =>
    setEditing((rows) => (rows ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const saveEdit = () => {
    const found = scheduleProblem(editing ?? [], invoicedNumbers);
    if (found !== null) {
      setProblem(t(`billing.schedule.problem.${found}`));
      return;
    }
    setProblem(null);
    saveSchedule.mutate((editing ?? []).map((row) => ({ ...row, amount: row.amount.trim() })));
  };

  const submitAdvance = () => {
    if (!isPositiveAmount(advanceAmount) || advanceDate === '') {
      setProblem(t('billing.advance.incomplete'));
      return;
    }
    setProblem(null);
    requestAdvance.mutate();
  };

  const submitInvoice = () => {
    if (picked.length === 0 || invoiceDate === '') {
      setProblem(t('billing.newInvoice.incomplete'));
      return;
    }
    setProblem(null);
    createInvoice.mutate();
  };

  return (
    <div>
      {summary.data !== undefined && (
        <Descriptions
          bordered
          size="small"
          column={3}
          title={t('billing.summary.title')}
          style={{ marginBottom: 16 }}
        >
          <Descriptions.Item label={t('billing.summary.contract')}>
            {formatAmount(summary.data.contractValue)}
          </Descriptions.Item>
          <Descriptions.Item label={t('billing.summary.billed')}>
            {formatAmount(summary.data.netBilled)}
          </Descriptions.Item>
          <Descriptions.Item label={t('billing.summary.remaining')}>
            {formatAmount(summary.data.remainingToBill)}
          </Descriptions.Item>
          <Descriptions.Item label={t('billing.summary.unappliedAdvance')}>
            {formatAmount(summary.data.unappliedAdvance)}
          </Descriptions.Item>
        </Descriptions>
      )}

      <Typography.Title level={4}>{t('billing.schedule.title')}</Typography.Title>
      {data !== undefined && !data.matchesContract && (
        <Alert
          type="warning"
          style={{ marginBottom: 12 }}
          message={t('billing.schedule.mismatch', {
            total: formatAmount(data.scheduleTotal),
            contract: formatAmount(data.contractValue),
          })}
        />
      )}
      {data?.pendingEditId != null && (
        <Alert type="info" style={{ marginBottom: 12 }} message={t('billing.schedule.pending')} />
      )}
      {editing === null ? (
        <>
          {can(perm.scheduleManage) && (
            <Button style={{ marginBottom: 12 }} onClick={startEdit}>
              {t('billing.schedule.edit')}
            </Button>
          )}
          <Table<ScheduleStage>
            rowKey="id"
            size="small"
            pagination={false}
            locale={{ emptyText: t('billing.schedule.empty') }}
            dataSource={data?.stages ?? []}
            columns={[
              { title: t('billing.schedule.stageNo'), dataIndex: 'stageNo' },
              { title: t('billing.schedule.name'), dataIndex: 'name' },
              {
                title: t('billing.schedule.amount'),
                align: 'right',
                render: (_, row) => formatAmount(row.amount),
              },
              {
                title: t('billing.schedule.source'),
                render: (_, row) => t(`billing.schedule.sources.${row.source}`),
              },
              {
                title: t('billing.schedule.status'),
                render: (_, row) => <Tag>{t(`billing.schedule.statuses.${row.status}`)}</Tag>,
              },
            ]}
          />
        </>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {problem !== null && <Alert type="error" message={problem} />}
          {editing.map((row, index) => (
            <Space key={row.id ?? `new-${index}`}>
              <Input
                aria-label={t('billing.schedule.stageNo')}
                style={{ width: 80 }}
                value={String(row.stageNo)}
                onChange={(event) => change(index, { stageNo: Number(event.target.value) })}
              />
              <Input
                aria-label={t('billing.schedule.name')}
                value={row.name}
                onChange={(event) => change(index, { name: event.target.value })}
              />
              <Input
                aria-label={t('billing.schedule.amount')}
                value={row.amount}
                onChange={(event) => change(index, { amount: event.target.value })}
              />
              <Button
                onClick={() => setEditing((rows) => (rows ?? []).filter((_, i) => i !== index))}
              >
                {t('billing.schedule.remove')}
              </Button>
            </Space>
          ))}
          <Space>
            <Button
              onClick={() =>
                setEditing((rows) => [
                  ...(rows ?? []),
                  {
                    stageNo:
                      Math.max(0, ...(rows ?? []).map((r) => r.stageNo), ...invoicedNumbers) + 1,
                    name: '',
                    amount: '',
                  },
                ])
              }
            >
              {t('billing.schedule.add')}
            </Button>
            <Button type="primary" loading={saveSchedule.isPending} onClick={saveEdit}>
              {t('billing.schedule.sendForApproval')}
            </Button>
            <Button onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
          </Space>
        </Space>
      )}

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        {t('billing.advance.title')}
      </Typography.Title>
      {can(perm.advanceManage) && (
        <Button style={{ marginBottom: 12 }} onClick={() => setAdvanceOpen(true)}>
          {t('billing.advance.request')}
        </Button>
      )}
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('billing.advance.empty') }}
        dataSource={summary.data?.advances ?? []}
        columns={[
          {
            title: t('billing.advance.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          {
            title: t('billing.advance.applied'),
            align: 'right',
            render: (_, row) => formatAmount(row.applied),
          },
          {
            title: t('billing.advance.receivedOn'),
            render: (_, row) => (row.receivedOn === null ? '' : formatDate(row.receivedOn)),
          },
          {
            title: t('billing.advance.status'),
            render: (_, row) => <Tag>{t(`billing.advance.statuses.${row.status}`)}</Tag>,
          },
          {
            title: t('billing.advance.invoice'),
            render: (_, row) =>
              row.invoiceId === null ? null : (
                <Link to={`/billing/invoices/${row.invoiceId}`}>{t('billing.advance.open')}</Link>
              ),
          },
        ]}
      />

      <Typography.Title level={4} style={{ marginTop: 24 }}>
        {t('billing.invoices.title')}
      </Typography.Title>
      {can(perm.invoiceCreate) && (
        <Button
          type="primary"
          style={{ marginBottom: 12 }}
          onClick={() => {
            setPicked([]);
            setProblem(null);
            setInvoiceOpen(true);
          }}
        >
          {t('billing.invoices.new')}
        </Button>
      )}
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('billing.invoices.empty') }}
        dataSource={invoices.data?.items ?? []}
        columns={[
          {
            title: t('billing.invoice.number'),
            render: (_, row) => (
              <Link to={`/billing/invoices/${row.id}`}>
                {row.number ?? t('billing.invoice.draftNumber')}
              </Link>
            ),
          },
          { title: t('billing.invoice.date'), render: (_, row) => formatDate(row.invoiceDate) },
          {
            title: t('billing.invoice.gross'),
            align: 'right',
            render: (_, row) => formatAmount(row.grossTotal),
          },
          {
            title: t('billing.invoice.status'),
            render: (_, row) => <Tag>{t(`billing.status.${row.status}`)}</Tag>,
          },
        ]}
      />

      <Modal
        open={invoiceOpen}
        title={t('billing.newInvoice.title')}
        okText={t('billing.newInvoice.create')}
        cancelText={t('common.cancel')}
        confirmLoading={createInvoice.isPending}
        onCancel={() => setInvoiceOpen(false)}
        onOk={submitInvoice}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {problem !== null && <Alert type="error" message={problem} />}
          <Typography.Text>{t('billing.newInvoice.stages')}</Typography.Text>
          <Checkbox.Group
            value={picked}
            onChange={(values) => setPicked(values)}
            options={planned.map((stage) => ({
              value: stage.id,
              label: `${stage.stageNo}. ${stage.name} - ${formatAmount(stage.amount)}`,
            }))}
            style={{ display: 'flex', flexDirection: 'column' }}
          />
          <Input
            type="date"
            addonBefore={t('billing.invoice.date')}
            aria-label={t('billing.invoice.date')}
            value={invoiceDate}
            onChange={(event) => setInvoiceDate(event.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        open={advanceOpen}
        title={t('billing.advance.requestTitle')}
        okText={t('billing.advance.create')}
        cancelText={t('common.cancel')}
        confirmLoading={requestAdvance.isPending}
        onCancel={() => setAdvanceOpen(false)}
        onOk={submitAdvance}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {problem !== null && <Alert type="error" message={problem} />}
          <Input
            addonBefore={t('billing.advance.amount')}
            aria-label={t('billing.advance.amount')}
            value={advanceAmount}
            onChange={(event) => setAdvanceAmount(event.target.value)}
          />
          <Input
            type="date"
            addonBefore={t('billing.invoice.date')}
            aria-label={t('billing.advance.date')}
            value={advanceDate}
            onChange={(event) => setAdvanceDate(event.target.value)}
          />
        </Space>
      </Modal>
    </div>
  );
}

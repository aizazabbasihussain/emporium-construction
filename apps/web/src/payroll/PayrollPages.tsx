import {
  costDifferenceTreatments,
  formatAmount,
  formatDate,
  payrollPaymentMethods,
  payrollPermissions,
  type CostDifferenceTreatment,
  type PayrollPaymentMethod,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { payrollApi, type Line, type Payment, type Run } from './api';
import { failure, monthLabel, today, useAccounts } from './hooks';

/** Runs and the creation of a run from an approved wage period (BR-1). */
export function RunsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const client = useQueryClient();
  const [periodId, setPeriodId] = useState('');
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: payrollApi.runs });
  const periods = useQuery({
    queryKey: ['payroll', 'periods'],
    queryFn: payrollApi.approvedPeriods,
    enabled: can(payrollPermissions.runCreate),
  });
  const used = new Set((runs.data?.items ?? []).map((run) => run.periodId));
  const options = (periods.data?.items ?? [])
    .filter((p) => p.status === 'approved' && !used.has(p.id))
    .map((p) => ({ value: p.id, label: monthLabel(p.year, p.month) }));
  const create = useMutation({
    mutationFn: () => payrollApi.create(periodId),
    onSuccess: () => {
      setPeriodId('');
      return client.invalidateQueries({ queryKey: ['payroll'] });
    },
  });
  return (
    <div>
      <Typography.Title level={3}>{t('payroll.runs.title')}</Typography.Title>
      {can(payrollPermissions.runCreate) && (
        <Space style={{ marginBottom: 12 }}>
          <Select
            aria-label={t('payroll.runs.period')}
            placeholder={t('payroll.runs.period')}
            style={{ width: 200 }}
            value={periodId === '' ? undefined : periodId}
            onChange={setPeriodId}
            options={options}
          />
          <Button
            type="primary"
            disabled={periodId === ''}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('payroll.runs.create')}
          </Button>
        </Space>
      )}
      {create.isError && <Alert type="error" message={failure(t, create.error)} />}
      {runs.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Run>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('payroll.runs.none') }}
        dataSource={runs.data?.items ?? []}
        columns={[
          {
            title: t('payroll.runs.period'),
            render: (_, run) => (
              <Link to={`/payroll/runs/${run.id}`}>{monthLabel(run.year, run.month)}</Link>
            ),
          },
          {
            title: t('payroll.common.status'),
            render: (_, run) => t(`payroll.status.${run.status}`),
          },
          {
            title: t('payroll.common.net'),
            align: 'right',
            render: (_, run) => formatAmount(run.totalNet),
          },
          {
            title: t('payroll.common.paid'),
            align: 'right',
            render: (_, run) => formatAmount(run.totalPaid),
          },
          {
            title: t('payroll.common.unpaid'),
            align: 'right',
            render: (_, run) => formatAmount(run.totalUnpaid),
          },
        ]}
      />
    </div>
  );
}

/** One run: cost difference summary, payment grid, finalize, reopen and payment reversal. */
export function RunPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const client = useQueryClient();
  const accounts = useAccounts();
  const [selected, setSelected] = useState<string[]>([]);
  const [treatment, setTreatment] = useState<CostDifferenceTreatment>('spread_to_projects');
  const [method, setMethod] = useState<PayrollPaymentMethod>('cash');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useQuery({ queryKey: ['payroll', 'run', id], queryFn: () => payrollApi.run(id) });
  const lines = useQuery({
    queryKey: ['payroll', 'lines', id],
    queryFn: () => payrollApi.lines(id),
  });
  const payments = useQuery({
    queryKey: ['payroll', 'payments', id],
    queryFn: () => payrollApi.payments(id),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['payroll'] });
  const act = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: (e) => setError(failure(t, e)),
  });
  const data = run.data;
  if (run.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (data === undefined) return null;
  const unpaid = (lines.data ?? []).filter((line) => line.paymentStatus === 'unpaid');
  const picked = selected.filter((lineId) => unpaid.some((line) => line.id === lineId));
  const lineIds = picked.length === 0 ? undefined : picked;
  const pay = () =>
    act.mutate(async () => {
      setMessage(null);
      const request = await payrollApi.requestPayment(id, lineIds);
      if (request.approvalDocId !== null) {
        setMessage(t('payroll.run.approvalRequested', { amount: formatAmount(request.amount) }));
      }
      await payrollApi.pay(id, {
        ...(lineIds === undefined ? {} : { lineIds }),
        paymentDate: date,
        method,
        accountId,
        ...(request.approvalDocId === null ? {} : { approvalDocId: request.approvalDocId }),
        version: data.version,
      });
      setSelected([]);
    });
  const finalized = data.status !== 'draft';
  const canReopen = data.status === 'finalized' && can(payrollPermissions.runReopen);
  const canReverse =
    can(payrollPermissions.paymentReverse) &&
    (payments.data ?? []).some((p) => p.status === 'paid');
  return (
    <div>
      <Typography.Title level={3}>
        {t('payroll.run.title', { period: monthLabel(data.year, data.month) })}
      </Typography.Title>
      <Space direction="vertical" style={{ marginBottom: 12 }}>
        <div>
          {t('payroll.common.status')}: <strong>{t(`payroll.status.${data.status}`)}</strong>
        </div>
        <div>
          {t('payroll.common.net')}: {formatAmount(data.totalNet)} · {t('payroll.common.paid')}:{' '}
          {formatAmount(data.totalPaid)} · {t('payroll.common.unpaid')}:{' '}
          {formatAmount(data.totalUnpaid)}
        </div>
        <div>
          {t('payroll.cost.gross')}: {formatAmount(data.cost.grossPay)} ·{' '}
          {t('payroll.cost.allocated')}: {formatAmount(data.cost.allocatedCost)} ·{' '}
          <strong>
            {t('payroll.cost.difference')}: {formatAmount(data.cost.difference)}
          </strong>
        </div>
      </Space>
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      {message !== null && <Alert type="info" message={message} style={{ marginBottom: 12 }} />}
      {data.status === 'draft' && can(payrollPermissions.runFinalize) && (
        <Space style={{ marginBottom: 12 }}>
          <Select
            aria-label={t('payroll.cost.treatment')}
            style={{ width: 260 }}
            value={treatment}
            onChange={setTreatment}
            options={costDifferenceTreatments.map((value) => ({
              value,
              label: t(`payroll.treatment.${value}`),
            }))}
          />
          <Button
            type="primary"
            onClick={() => act.mutate(() => payrollApi.finalize(data, treatment))}
          >
            {t('payroll.run.finalize')}
          </Button>
        </Space>
      )}
      {(canReopen || canReverse) && (
        <Space style={{ marginBottom: 12 }}>
          <Input
            aria-label={t('payroll.run.reason')}
            placeholder={t('payroll.run.reason')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: 260 }}
          />
          {canReopen && (
            <Button
              disabled={reason.trim() === ''}
              onClick={() => act.mutate(() => payrollApi.reopen(data, reason.trim()))}
            >
              {t('payroll.run.reopen')}
            </Button>
          )}
        </Space>
      )}
      {finalized && can(payrollPermissions.paymentCreate) && data.status !== 'paid' && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            aria-label={t('payroll.pay.method')}
            style={{ width: 160 }}
            value={method}
            onChange={setMethod}
            options={payrollPaymentMethods.map((value) => ({
              value,
              label: t(`payroll.method.${value}`),
            }))}
          />
          <Select
            aria-label={t('payroll.pay.account')}
            placeholder={t('payroll.pay.account')}
            style={{ width: 220 }}
            value={accountId === '' ? undefined : accountId}
            onChange={setAccountId}
            options={accounts}
          />
          <Input
            aria-label={t('payroll.pay.date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ width: 160 }}
          />
          <Button type="primary" disabled={accountId === '' || date === ''} onClick={pay}>
            {picked.length === 0
              ? t('payroll.pay.all')
              : t('payroll.pay.selected', { count: picked.length })}
          </Button>
        </Space>
      )}
      <Table<Line>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={lines.data ?? []}
        rowSelection={
          finalized
            ? {
                selectedRowKeys: picked,
                getCheckboxProps: (line) => ({ disabled: line.paymentStatus === 'paid' }),
                onChange: (keys) => setSelected(keys as string[]),
              }
            : undefined
        }
        columns={[
          { title: t('payroll.common.code'), dataIndex: 'workerCode' },
          { title: t('payroll.common.worker'), dataIndex: 'workerName' },
          {
            title: t('payroll.common.net'),
            align: 'right',
            render: (_, line) => formatAmount(line.netPay),
          },
          {
            title: t('payroll.common.status'),
            render: (_, line) => t(`payroll.lineStatus.${line.paymentStatus}`),
          },
          {
            title: t('payroll.pay.date'),
            render: (_, line) => (line.paidOn === null ? '' : formatDate(line.paidOn)),
          },
          {
            title: t('payroll.payslip.title'),
            render: (_, line) =>
              line.payslipNumber !== null && can(payrollPermissions.payslipRead) ? (
                <Link to={`/payroll/payslips/${line.id}`}>{line.payslipNumber}</Link>
              ) : (
                ''
              ),
          },
        ]}
      />
      {finalized && can(payrollPermissions.payslipRead) && (
        <p>
          <a href={`/payroll/runs/${id}/payslips.pdf`} target="_blank" rel="noreferrer">
            {t('payroll.payslip.pdf')}
          </a>
        </p>
      )}
      <Typography.Title level={4}>{t('payroll.payments.title')}</Typography.Title>
      <Table<Payment>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('payroll.payments.none') }}
        dataSource={payments.data ?? []}
        columns={[
          { title: t('payroll.pay.date'), render: (_, p) => formatDate(p.paymentDate) },
          { title: t('payroll.pay.method'), render: (_, p) => t(`payroll.method.${p.method}`) },
          {
            title: t('payroll.common.net'),
            align: 'right',
            render: (_, p) => formatAmount(p.amount),
          },
          {
            title: t('payroll.common.status'),
            render: (_, p) => t(`payroll.paymentStatus.${p.status}`),
          },
          {
            title: '',
            render: (_, p) =>
              p.status === 'paid' && canReverse ? (
                <Button
                  size="small"
                  disabled={reason.trim() === ''}
                  onClick={() => act.mutate(() => payrollApi.reverse(p, reason.trim()))}
                >
                  {t('payroll.payments.reverse')}
                </Button>
              ) : (
                ''
              ),
          },
        ]}
      />
    </div>
  );
}

/** Lines unpaid by run and age (BR-6). */
export function UnpaidPage() {
  const { t } = useTranslation();
  const report = useQuery({ queryKey: ['payroll', 'unpaid'], queryFn: payrollApi.unpaid });
  const data = report.data;
  return (
    <div>
      <Typography.Title level={3}>{t('payroll.unpaid.title')}</Typography.Title>
      {report.isError && <Alert type="error" message={t('common.loadError')} />}
      {data !== undefined && (
        <>
          <p>
            <strong>
              {t('payroll.unpaid.total')}: {formatAmount(data.total)}
            </strong>
          </p>
          <Table
            rowKey="runId"
            size="small"
            pagination={false}
            locale={{ emptyText: t('payroll.unpaid.none') }}
            dataSource={data.byRun}
            columns={[
              {
                title: t('payroll.runs.period'),
                render: (_, row) => (
                  <Link to={`/payroll/runs/${row.runId}`}>{monthLabel(row.year, row.month)}</Link>
                ),
              },
              { title: t('payroll.unpaid.count'), dataIndex: 'unpaidCount' },
              {
                title: t('payroll.common.unpaid'),
                align: 'right',
                render: (_, row) => formatAmount(row.unpaidAmount),
              },
              { title: t('payroll.unpaid.age'), dataIndex: 'oldestAgeDays' },
            ]}
          />
          <Table
            rowKey="lineId"
            size="small"
            pagination={false}
            style={{ marginTop: 12 }}
            dataSource={data.rows}
            columns={[
              { title: t('payroll.common.code'), dataIndex: 'workerCode' },
              { title: t('payroll.common.worker'), dataIndex: 'workerName' },
              {
                title: t('payroll.common.net'),
                align: 'right',
                render: (_, row) => formatAmount(row.netPay),
              },
              { title: t('payroll.unpaid.age'), dataIndex: 'ageDays' },
            ]}
          />
        </>
      )}
    </div>
  );
}

/** One payslip, printable; the rate appears only when the API returns it (BR-3). */
export function PayslipPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const slip = useQuery({
    queryKey: ['payroll', 'payslip', id],
    queryFn: () => payrollApi.payslip(id),
  });
  const data = slip.data;
  if (slip.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (data === undefined) return null;
  const rows: [string, string][] = [
    ['basic', data.basicPay],
    ['overtime', data.overtimePay],
    ['allowances', data.allowances],
    ['deductions', data.deductions],
    ['advance', data.advanceRecovery],
  ];
  return (
    <div>
      <Typography.Title level={3}>
        {t('payroll.payslip.heading', { number: data.number })}
      </Typography.Title>
      <p>
        {data.workerCode} {data.workerName} · {data.period}
      </p>
      {data.rate !== null && (
        <p>
          {t('payroll.payslip.rate')}: {formatAmount(data.rate)}
        </p>
      )}
      <Table
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={rows.map(([key, value]) => ({ key, value }))}
        columns={[
          { title: '', render: (_, row) => t(`payroll.payslip.${row.key}`) },
          { title: '', align: 'right', render: (_, row) => formatAmount(row.value) },
        ]}
      />
      <p>
        <strong>
          {t('payroll.payslip.net')}: {formatAmount(data.netPay)}
        </strong>
      </p>
      <p>
        {Object.entries(data.attendance)
          .map(([key, value]) => `${t(`payroll.attendance.${key}`)}: ${value}`)
          .join(' · ')}
      </p>
      <Button onClick={() => window.print()}>{t('payroll.payslip.print')}</Button>
    </div>
  );
}

import { formatAmount, formatDate, paymentMethods, type PaymentMethod } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { payablesApi, type Bill, type OpenBill, type Payment, type PaymentRun } from './api';
import { allocationTotal, optional, paymentProblem } from './form';
import { failure, today, useAccounts, useVendors } from './hooks';

/** Payments with the step each one needs next: submit, pay, certificate, cancel. */
export function PaymentsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { nameOf } = useVendors();
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [certificate, setCertificate] = useState('');
  const payments = useQuery({
    queryKey: ['payables', 'payments'],
    queryFn: () => payablesApi.payments(),
  });
  const refresh = () => {
    setProblem(null);
    void client.invalidateQueries({ queryKey: ['payables'] });
  };
  const step = useMutation({
    mutationFn: (args: { payment: Payment; action: 'submit' | 'pay' }) =>
      payablesApi.paymentAction(args.payment, args.action),
    onSuccess: refresh,
    onError: (error) => setProblem(failure(t, error)),
  });
  const cancel = useMutation({
    mutationFn: (payment: Payment) => payablesApi.cancelPayment(payment, reason),
    onSuccess: refresh,
    onError: (error) => setProblem(failure(t, error)),
  });
  const certify = useMutation({
    mutationFn: (payment: Payment) => payablesApi.certificate(payment, certificate.trim()),
    onSuccess: refresh,
    onError: (error) => setProblem(failure(t, error)),
  });

  return (
    <div>
      <Typography.Title level={3}>{t('payables.payments.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Link to="/payables/payments/new">
          <Button type="primary">{t('payables.payments.new')}</Button>
        </Link>
        <Input
          aria-label={t('payables.common.reason')}
          placeholder={t('payables.common.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: 240 }}
        />
        <Input
          aria-label={t('payables.payments.certificate')}
          placeholder={t('payables.payments.certificate')}
          value={certificate}
          onChange={(e) => setCertificate(e.target.value)}
          style={{ width: 240 }}
        />
      </Space>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {payments.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Payment>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('payables.payments.none') }}
        dataSource={payments.data?.items ?? []}
        columns={[
          { title: t('payables.payments.number'), dataIndex: 'number' },
          { title: t('payables.common.vendor'), render: (_, row) => nameOf(row.vendorPartyId) },
          { title: t('payables.common.date'), render: (_, row) => formatDate(row.paymentDate) },
          {
            title: t('payables.payments.method'),
            render: (_, row) => t(`payables.method.${row.method}`),
          },
          {
            title: t('payables.payments.cash'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
          {
            title: t('payables.payments.withheld'),
            align: 'right',
            render: (_, row) => formatAmount(row.withholdingDeducted),
          },
          {
            title: t('payables.common.status'),
            render: (_, row) => <Tag>{t(`payables.paymentStatus.${row.status}`)}</Tag>,
          },
          {
            title: '',
            render: (_, row) => (
              <Space wrap>
                {row.status === 'draft' && (
                  <Button onClick={() => step.mutate({ payment: row, action: 'submit' })}>
                    {t('payables.payments.submit')}
                  </Button>
                )}
                {row.status === 'approved' && (
                  <Button
                    type="primary"
                    onClick={() => step.mutate({ payment: row, action: 'pay' })}
                  >
                    {t('payables.payments.pay')}
                  </Button>
                )}
                {row.withholdingDeducted !== '0.00' && (
                  <Button disabled={certificate.trim() === ''} onClick={() => certify.mutate(row)}>
                    {t('payables.payments.saveCertificate')}
                  </Button>
                )}
                {row.status !== 'cancelled' && (
                  <Button danger disabled={reason.trim() === ''} onClick={() => cancel.mutate(row)}>
                    {t('payables.payments.cancel')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}

/** A payment allocated across one vendor's open bills (BR-7). */
export function PaymentBuilderPage() {
  const { t } = useTranslation();
  const { options } = useVendors();
  const accounts = useAccounts();
  const [vendorPartyId, setVendorPartyId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeDate, setChequeDate] = useState(today());
  const [reference, setReference] = useState('');
  const [rows, setRows] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Payment | null>(null);
  const open = useQuery({
    queryKey: ['payables', 'open-bills', vendorPartyId],
    queryFn: () => payablesApi.openBills(vendorPartyId),
    enabled: vendorPartyId !== '',
  });
  const save = useMutation({
    mutationFn: () =>
      payablesApi.createPayment({
        vendorPartyId,
        paymentDate: date,
        method,
        accountId,
        ...(method === 'cheque' ? { chequeNumber: chequeNumber.trim(), chequeDate } : {}),
        ...(optional(reference) === undefined ? {} : { reference: reference.trim() }),
        allocations: Object.entries(rows)
          .filter(([, value]) => value.trim() !== '')
          .map(([billId, amount]) => ({ billId, amount: amount.trim() })),
      }),
    onSuccess: (payment) => {
      setSaved(payment);
      setProblem(null);
    },
    onError: (error) => setProblem(failure(t, error)),
  });
  const submit = () => {
    const found = paymentProblem({
      vendorPartyId,
      accountId,
      date,
      method,
      chequeNumber,
      chequeDate,
      rows,
    });
    if (found !== null) {
      setProblem(t(`payables.payments.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('payables.payments.newTitle')}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {saved !== null && (
        <Alert
          type="success"
          style={{ marginBottom: 8 }}
          message={t('payables.payments.saved', {
            number: saved.number,
            cash: formatAmount(saved.amount),
            withheld: formatAmount(saved.withholdingDeducted),
          })}
        />
      )}
      <Space direction="vertical" style={{ maxWidth: 560, width: '100%' }}>
        <Select
          aria-label={t('payables.common.vendor')}
          placeholder={t('payables.common.vendor')}
          showSearch
          optionFilterProp="label"
          value={vendorPartyId === '' ? undefined : vendorPartyId}
          onChange={(value) => {
            setVendorPartyId(value);
            setRows({});
          }}
          options={options}
        />
        <Select
          aria-label={t('payables.payments.account')}
          placeholder={t('payables.payments.account')}
          value={accountId === '' ? undefined : accountId}
          onChange={setAccountId}
          options={accounts}
        />
        <Select
          aria-label={t('payables.payments.method')}
          value={method}
          onChange={setMethod}
          options={paymentMethods.map((value) => ({
            value,
            label: t(`payables.method.${value}`),
          }))}
        />
        <Input
          aria-label={t('payables.common.date')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        {method === 'cheque' && (
          <>
            <Input
              aria-label={t('payables.payments.chequeNumber')}
              placeholder={t('payables.payments.chequeNumber')}
              value={chequeNumber}
              onChange={(e) => setChequeNumber(e.target.value)}
            />
            <Input
              aria-label={t('payables.payments.chequeDate')}
              type="date"
              value={chequeDate}
              onChange={(e) => setChequeDate(e.target.value)}
            />
          </>
        )}
        <Input
          aria-label={t('payables.payments.reference')}
          placeholder={t('payables.payments.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </Space>
      {vendorPartyId !== '' && (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>
            {t('payables.payments.allocations')} {formatAmount(allocationTotal(rows))}
          </Typography.Title>
          <Table<OpenBill>
            rowKey="billId"
            size="small"
            pagination={false}
            locale={{ emptyText: t('payables.payments.noOpenBills') }}
            dataSource={open.data ?? []}
            columns={[
              { title: t('payables.bills.number'), dataIndex: 'number' },
              { title: t('payables.bills.invoiceNo'), dataIndex: 'vendorInvoiceNo' },
              { title: t('payables.bills.dueDate'), render: (_, row) => formatDate(row.dueDate) },
              {
                title: t('payables.payments.outstanding'),
                align: 'right',
                render: (_, row) => formatAmount(row.outstanding),
              },
              {
                title: t('payables.payments.allocate'),
                render: (_, row) => (
                  <Input
                    aria-label={`${t('payables.payments.allocate')} ${row.number}`}
                    value={rows[row.billId] ?? ''}
                    onChange={(e) => setRows({ ...rows, [row.billId]: e.target.value })}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
      <Button type="primary" style={{ marginTop: 16 }} loading={save.isPending} onClick={submit}>
        {t('payables.common.save')}
      </Button>
    </div>
  );
}

/** A payment run: the selected bills grouped by vendor under one approval (BR-11). */
export function PaymentRunsPage() {
  const { t } = useTranslation();
  const { nameOf } = useVendors();
  const accounts = useAccounts();
  const [selected, setSelected] = useState<string[]>([]);
  const [accountId, setAccountId] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [date, setDate] = useState(today());
  const [problem, setProblem] = useState<string | null>(null);
  const [run, setRun] = useState<PaymentRun | null>(null);
  const bills = useQuery({
    queryKey: ['payables', 'bills', 'payable'],
    queryFn: async (): Promise<Bill[]> => [
      ...(await payablesApi.bills('posted')).items,
      ...(await payablesApi.bills('partly_paid')).items,
    ],
  });
  const create = useMutation({
    mutationFn: () =>
      payablesApi.createRun({ billIds: selected, paymentDate: date, method, accountId }),
    onSuccess: (created) => {
      setRun(created);
      setProblem(null);
    },
    onError: (error) => setProblem(failure(t, error)),
  });
  const submit = () => {
    if (selected.length === 0) setProblem(t('payables.runs.problem.bills'));
    else if (accountId === '') setProblem(t('payables.runs.problem.account'));
    else create.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('payables.runs.title')}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {run !== null && (
        <Alert
          type="success"
          style={{ marginBottom: 8 }}
          message={t('payables.runs.created', {
            count: run.payments.length,
            total: formatAmount(run.total),
          })}
        />
      )}
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          aria-label={t('payables.payments.account')}
          placeholder={t('payables.payments.account')}
          style={{ width: 240 }}
          value={accountId === '' ? undefined : accountId}
          onChange={setAccountId}
          options={accounts}
        />
        <Select
          aria-label={t('payables.payments.method')}
          value={method}
          onChange={setMethod}
          style={{ width: 200 }}
          options={paymentMethods
            .filter((value) => value !== 'cheque')
            .map((value) => ({
              value,
              label: t(`payables.method.${value}`),
            }))}
        />
        <Input
          aria-label={t('payables.common.date')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Button type="primary" loading={create.isPending} onClick={submit}>
          {t('payables.runs.create')}
        </Button>
      </Space>
      <Table<Bill>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('payables.runs.none') }}
        dataSource={bills.data ?? []}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
        columns={[
          { title: t('payables.bills.number'), dataIndex: 'number' },
          { title: t('payables.common.vendor'), render: (_, row) => nameOf(row.vendorPartyId) },
          { title: t('payables.bills.dueDate'), render: (_, row) => formatDate(row.dueDate) },
          {
            title: t('payables.payments.outstanding'),
            align: 'right',
            render: (_, row) => formatAmount(row.outstanding),
          },
        ]}
      />
    </div>
  );
}

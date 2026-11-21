import { certificateBases, formatDate, type CertificateBasis } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { subcontractsApi, type BackCharge, type Certificate, type CertificateBody } from './api';
import { billProblem, certificateProblem, optional } from './form';
import { amountText, failure, today } from './hooks';

/** The fields of a certificate form, shared by the new and the edit screens. */
function CertificateFields(props: {
  value: { date: string; basis: CertificateBasis; cumulative: string; notes: string };
  onChange: (value: {
    date: string;
    basis: CertificateBasis;
    cumulative: string;
    notes: string;
  }) => void;
}) {
  const { t } = useTranslation();
  const { value, onChange } = props;
  return (
    <Space direction="vertical" style={{ maxWidth: 560, width: '100%' }}>
      <Input
        aria-label={t('subcontracts.certificates.date')}
        type="date"
        value={value.date}
        onChange={(e) => onChange({ ...value, date: e.target.value })}
      />
      <Select
        aria-label={t('subcontracts.certificates.basis')}
        value={value.basis}
        onChange={(basis) => onChange({ ...value, basis })}
        options={certificateBases.map((basis) => ({
          value: basis,
          label: t(`subcontracts.certificates.basisName.${basis}`),
        }))}
      />
      <Input
        aria-label={t('subcontracts.certificates.cumulative')}
        placeholder={t('subcontracts.certificates.cumulative')}
        inputMode="decimal"
        value={value.cumulative}
        onChange={(e) => onChange({ ...value, cumulative: e.target.value })}
      />
      <Input.TextArea
        aria-label={t('subcontracts.certificates.notes')}
        placeholder={t('subcontracts.certificates.notes')}
        value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value })}
      />
    </Space>
  );
}

const bodyOf = (form: {
  date: string;
  basis: CertificateBasis;
  cumulative: string;
  notes: string;
}): CertificateBody => ({
  certificateDate: form.date,
  basis: form.basis,
  ...(form.basis === 'percent_complete'
    ? { cumulativePercent: form.cumulative.trim() }
    : { cumulativeAmount: form.cumulative.trim() }),
  ...(optional(form.notes) === undefined ? {} : { notes: form.notes.trim() }),
});

/** A new certificate: cumulative percent or amount against the current contract (BR-2). */
export function CertificateNewPage() {
  const { t } = useTranslation();
  const { orderId = '' } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    date: today(),
    basis: 'percent_complete' as CertificateBasis,
    cumulative: '',
    notes: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const order = useQuery({
    queryKey: ['subcontracts', 'order', orderId],
    queryFn: () => subcontractsApi.order(orderId),
  });
  const save = useMutation({
    mutationFn: () => subcontractsApi.createCertificate(orderId, bodyOf(form)),
    onSuccess: (certificate) => navigate(`/subcontracts/certificates/${certificate.id}`),
    onError: (error) => setProblem(failure(t, error)),
  });
  const submit = () => {
    const found = certificateProblem(form);
    if (found !== null) {
      setProblem(t(`subcontracts.certificates.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };
  return (
    <div>
      <Typography.Title level={3}>{t('subcontracts.certificates.newTitle')}</Typography.Title>
      {order.data !== undefined && (
        <p>
          {order.data.number} · {t('subcontracts.certificates.previous')}:{' '}
          {amountText(order.data.certifiedAmount)} / {amountText(order.data.currentContractAmount)}
        </p>
      )}
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      <CertificateFields value={form} onChange={setForm} />
      <Button type="primary" style={{ marginTop: 8 }} loading={save.isPending} onClick={submit}>
        {t('subcontracts.common.save')}
      </Button>
    </div>
  );
}

/** One certificate: cumulative against the previous, its deductions, approval and billing. */
export function CertificatePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    date: string;
    basis: CertificateBasis;
    cumulative: string;
    notes: string;
  } | null>(null);
  const [bill, setBill] = useState({ vendorInvoiceNo: '', billDate: today(), dueDate: today() });
  const certificate = useQuery({
    queryKey: ['subcontracts', 'certificate', id],
    queryFn: () => subcontractsApi.certificate(id),
  });
  const order = useQuery({
    queryKey: ['subcontracts', 'order', certificate.data?.workOrderId ?? ''],
    queryFn: () => subcontractsApi.order(certificate.data?.workOrderId ?? ''),
    enabled: certificate.data !== undefined,
  });
  const command = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setError(null);
      setEdit(null);
      return client.invalidateQueries({ queryKey: ['subcontracts'] });
    },
    onError: (e) => setError(failure(t, e)),
  });
  if (certificate.isError) return <Alert type="error" message={t('common.loadError')} />;
  const current: Certificate | undefined = certificate.data;
  if (current === undefined) return null;

  const startEdit = () =>
    setEdit({
      date: current.certificateDate,
      basis: current.basis,
      cumulative:
        current.basis === 'percent_complete'
          ? current.cumulativePercent
          : (current.cumulativeAmount ?? ''),
      notes: current.notes ?? '',
    });
  const saveEdit = () => {
    if (edit === null) return;
    const found = certificateProblem(edit);
    if (found !== null) return setError(t(`subcontracts.certificates.problem.${found}`));
    return command.mutate(() => subcontractsApi.updateCertificate(current, bodyOf(edit)));
  };
  const createBill = () => {
    const found = billProblem(bill);
    if (found !== null) return setError(t(`subcontracts.certificates.billProblem.${found}`));
    return command.mutate(() =>
      subcontractsApi.billCertificate(current, {
        vendorInvoiceNo: bill.vendorInvoiceNo.trim(),
        billDate: bill.billDate,
        dueDate: bill.dueDate,
      }),
    );
  };

  return (
    <div>
      <Typography.Title level={3}>{current.number}</Typography.Title>
      {error !== null && <Alert type="warning" message={error} style={{ marginBottom: 8 }} />}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Tag>{t(`subcontracts.certificateStatus.${current.status}`)}</Tag>
          <Link to={`/subcontracts/work-orders/${current.workOrderId}`}>
            {order.data?.number ?? t('subcontracts.certificates.order')}
          </Link>
          <span>{formatDate(current.certificateDate)}</span>
          {current.approval.status === 'pending' && (
            <Tag color="gold">
              {t('subcontracts.orders.waiting', { role: current.approval.currentRole ?? '' })}
            </Tag>
          )}
        </Space>
        <table>
          <tbody>
            {(current.status === 'draft' || current.status === 'pending_approval') &&
              order.data !== undefined && (
                <tr>
                  <td>{t('subcontracts.certificates.previous')}</td>
                  <td>{amountText(order.data.certifiedAmount)}</td>
                </tr>
              )}
            <tr>
              <td>{t('subcontracts.certificates.cumulative')}</td>
              <td>
                {current.cumulativePercent}% · {amountText(current.cumulativeAmount)}
              </td>
            </tr>
            <tr>
              <td>{t('subcontracts.certificates.gross')}</td>
              <td>{amountText(current.thisCertificateAmount)}</td>
            </tr>
            <tr>
              <td>{t('subcontracts.certificates.deductions')}</td>
              <td>{amountText(current.deductions)}</td>
            </tr>
            <tr>
              <td>{t('subcontracts.certificates.net')}</td>
              <td>{amountText(current.netCertified)}</td>
            </tr>
          </tbody>
        </table>
        <Table<BackCharge>
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: t('subcontracts.backCharges.none') }}
          dataSource={current.backCharges}
          columns={[
            { title: t('subcontracts.backCharges.description'), dataIndex: 'description' },
            {
              title: t('subcontracts.common.amount'),
              align: 'right',
              render: (_, row) => amountText(row.amount),
            },
          ]}
        />
        <Space wrap>
          {current.status === 'draft' && (
            <>
              <Button onClick={startEdit}>{t('subcontracts.certificates.edit')}</Button>
              <Button
                type="primary"
                onClick={() =>
                  command.mutate(() => subcontractsApi.certificateAction(current, 'submit'))
                }
              >
                {t('subcontracts.certificates.submit')}
              </Button>
            </>
          )}
          {(current.status === 'draft' || current.status === 'pending_approval') && (
            <Button
              onClick={() =>
                command.mutate(() => subcontractsApi.certificateAction(current, 'cancel'))
              }
            >
              {t('subcontracts.certificates.cancel')}
            </Button>
          )}
        </Space>
        {edit !== null && (
          <div>
            <CertificateFields value={edit} onChange={setEdit} />
            <Button style={{ marginTop: 8 }} onClick={saveEdit}>
              {t('subcontracts.common.save')}
            </Button>
          </div>
        )}
        {current.status === 'certified' && (
          <Space wrap>
            <Input
              aria-label={t('subcontracts.certificates.invoiceNo')}
              placeholder={t('subcontracts.certificates.invoiceNo')}
              value={bill.vendorInvoiceNo}
              onChange={(e) => setBill({ ...bill, vendorInvoiceNo: e.target.value })}
            />
            <Input
              aria-label={t('subcontracts.certificates.billDate')}
              type="date"
              value={bill.billDate}
              onChange={(e) => setBill({ ...bill, billDate: e.target.value })}
            />
            <Input
              aria-label={t('subcontracts.certificates.dueDate')}
              type="date"
              value={bill.dueDate}
              onChange={(e) => setBill({ ...bill, dueDate: e.target.value })}
            />
            <Button type="primary" onClick={createBill}>
              {t('subcontracts.certificates.bill')}
            </Button>
          </Space>
        )}
        {current.billId !== null && (
          <Link to={`/payables/bills/${current.billId}`}>
            {t('subcontracts.certificates.openBill')}
          </Link>
        )}
      </Space>
    </div>
  );
}

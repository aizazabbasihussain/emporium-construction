import { formatAmount, formatDate, receiptMethods, type ReceiptMethod } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { cashbookApi } from '../cashbook/api';
import { masterApi, type Party } from '../master/api';
import { receivablesApi, type OpenInvoice, type Receipt, type ReceiptBody } from './api';
import { allocatedTotal, optional, receiptProblem, type AllocationRow } from './form';

const today = () => new Date().toISOString().slice(0, 10);

/** A new receipt with its allocation grid (spec P2-04 section 5, BR-2 to BR-5). */
export function ReceiptEntryPage() {
  const { t } = useTranslation();
  const [partyId, setPartyId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState<ReceiptMethod>('bank_transfer');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [withheld, setWithheld] = useState('');
  const [certificate, setCertificate] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [chequeDate, setChequeDate] = useState(today());
  const [rows, setRows] = useState<Record<string, AllocationRow>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Receipt | null>(null);

  const customers = useQuery({
    queryKey: ['master-parties', 'clients'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'client', status: 'active' }),
  });
  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  const open = useQuery({
    queryKey: ['receivables', 'open-invoices', partyId],
    queryFn: () => receivablesApi.openInvoices(partyId),
    enabled: partyId !== '',
  });
  const isCheque = method === 'cheque' || method === 'pdc';
  const rowOf = (invoiceId: string): AllocationRow =>
    rows[invoiceId] ?? { invoiceId, amount: '', withheld: '' };
  const setRow = (invoiceId: string, patch: Partial<AllocationRow>) =>
    setRows({ ...rows, [invoiceId]: { ...rowOf(invoiceId), ...patch } });
  const list = Object.values(rows);

  const suggest = useMutation({
    mutationFn: () => receivablesApi.suggest(partyId, amount.trim()),
    onSuccess: (suggestion) =>
      setRows(
        Object.fromEntries(
          suggestion.map((line) => [
            line.invoiceId,
            { invoiceId: line.invoiceId, amount: line.amount, withheld: '' },
          ]),
        ),
      ),
  });

  const save = useMutation({
    mutationFn: () => {
      const allocations: NonNullable<ReceiptBody['allocations']> = list.flatMap((row) => [
        ...(optional(row.amount) === undefined
          ? []
          : [{ kind: 'invoice' as const, invoiceId: row.invoiceId, amount: row.amount.trim() }]),
        ...(optional(row.withheld) === undefined
          ? []
          : [
              {
                kind: 'withholding' as const,
                invoiceId: row.invoiceId,
                amount: row.withheld.trim(),
              },
            ]),
      ]);
      const body: ReceiptBody = {
        partyId,
        receiptDate: date,
        method,
        amount: amount.trim(),
        ...(isCheque || accountId === '' ? {} : { accountId }),
        ...(optional(reference) === undefined ? {} : { reference: reference.trim() }),
        ...(optional(withheld) === undefined ? {} : { withheldAmount: withheld.trim() }),
        ...(optional(certificate) === undefined
          ? {}
          : { withholdingCertificateRef: certificate.trim() }),
        ...(isCheque
          ? { cheque: { chequeNumber: chequeNumber.trim(), bankName: bankName.trim(), chequeDate } }
          : {}),
        ...(allocations.length === 0 ? {} : { allocations }),
      };
      return receivablesApi.createReceipt(body);
    },
    onSuccess: (receipt) => {
      setSaved(receipt);
      setProblem(null);
    },
    onError: (error) =>
      setProblem(
        error instanceof ApiError
          ? t(`receivables.errors.${error.code}`, { defaultValue: error.message })
          : t('common.loadError'),
      ),
  });

  const submit = () => {
    const found = receiptProblem({
      partyId,
      accountId,
      date,
      amount,
      withheld,
      cheque: isCheque,
      chequeNumber,
      bankName,
      chequeDate,
      rows: list,
    });
    if (found !== null) {
      setProblem(t(`receivables.receipt.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('receivables.receipt.title')}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      {saved !== null && (
        <Alert
          type="success"
          style={{ marginBottom: 8 }}
          message={t('receivables.receipt.saved', { number: saved.number })}
          description={
            <div>
              {Number(saved.unallocated) > 0 && (
                <div>
                  {t('receivables.receipt.unallocated', {
                    amount: formatAmount(saved.unallocated),
                  })}
                </div>
              )}
              {saved.withholdingFlags
                .filter((flag) => flag.flagged)
                .map((flag) => (
                  <div key={flag.invoiceId}>
                    {t('receivables.receipt.flagged', {
                      invoice: flag.invoiceId,
                      difference: formatAmount(flag.difference),
                    })}
                  </div>
                ))}
            </div>
          }
        />
      )}
      <Space direction="vertical" style={{ maxWidth: 560, width: '100%' }}>
        <Select
          aria-label={t('receivables.common.customer')}
          placeholder={t('receivables.common.customer')}
          showSearch
          optionFilterProp="label"
          value={partyId === '' ? undefined : partyId}
          onChange={(value) => {
            setPartyId(value);
            setRows({});
          }}
          options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          style={{ width: '100%' }}
        />
        <Select
          aria-label={t('receivables.receipt.method')}
          value={method}
          onChange={setMethod}
          options={receiptMethods.map((value) => ({
            value,
            label: t(`receivables.method.${value}`),
          }))}
        />
        {!isCheque && (
          <Select
            aria-label={t('receivables.receipt.account')}
            placeholder={t('receivables.receipt.account')}
            value={accountId === '' ? undefined : accountId}
            onChange={setAccountId}
            options={(accounts.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} ${a.name}`,
            }))}
          />
        )}
        <Input
          aria-label={t('receivables.common.date')}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Input
          aria-label={t('receivables.common.amount')}
          placeholder={t('receivables.common.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {isCheque && (
          <>
            <Input
              aria-label={t('receivables.receipt.chequeNumber')}
              placeholder={t('receivables.receipt.chequeNumber')}
              value={chequeNumber}
              onChange={(e) => setChequeNumber(e.target.value)}
            />
            <Input
              aria-label={t('receivables.receipt.bank')}
              placeholder={t('receivables.receipt.bank')}
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
            />
            <Input
              aria-label={t('receivables.receipt.chequeDate')}
              type="date"
              value={chequeDate}
              onChange={(e) => setChequeDate(e.target.value)}
            />
          </>
        )}
        <Input
          aria-label={t('receivables.receipt.reference')}
          placeholder={t('receivables.receipt.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <Input
          aria-label={t('receivables.receipt.withheld')}
          placeholder={t('receivables.receipt.withheld')}
          value={withheld}
          onChange={(e) => setWithheld(e.target.value)}
        />
        <Input
          aria-label={t('receivables.receipt.certificate')}
          placeholder={t('receivables.receipt.certificate')}
          value={certificate}
          onChange={(e) => setCertificate(e.target.value)}
        />
      </Space>

      {partyId !== '' && (
        <div style={{ marginTop: 16 }}>
          <Space style={{ marginBottom: 8 }}>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {t('receivables.receipt.allocations')}
            </Typography.Title>
            <Button
              disabled={amount.trim() === ''}
              loading={suggest.isPending}
              onClick={() => suggest.mutate()}
            >
              {t('receivables.receipt.suggest')}
            </Button>
            <span>{formatAmount(allocatedTotal(list))}</span>
          </Space>
          <Table<OpenInvoice>
            rowKey="invoiceId"
            size="small"
            pagination={false}
            locale={{ emptyText: t('receivables.receipt.noInvoices') }}
            dataSource={open.data ?? []}
            columns={[
              {
                title: t('receivables.receipt.invoice'),
                render: (_, row) => row.number ?? row.invoiceId,
              },
              {
                title: t('receivables.receipt.dueDate'),
                render: (_, row) => formatDate(row.dueDate),
              },
              {
                title: t('receivables.receipt.outstanding'),
                align: 'right',
                render: (_, row) => formatAmount(row.outstanding),
              },
              {
                title: t('receivables.receipt.allocatable'),
                align: 'right',
                render: (_, row) => formatAmount(row.allocatable),
              },
              {
                title: t('receivables.receipt.allocate'),
                render: (_, row) => (
                  <Input
                    aria-label={`${t('receivables.receipt.allocate')} ${row.number ?? row.invoiceId}`}
                    value={rowOf(row.invoiceId).amount}
                    onChange={(e) => setRow(row.invoiceId, { amount: e.target.value })}
                  />
                ),
              },
              {
                title: t('receivables.receipt.withholding'),
                render: (_, row) => (
                  <Input
                    aria-label={`${t('receivables.receipt.withholding')} ${row.number ?? row.invoiceId}`}
                    value={rowOf(row.invoiceId).withheld}
                    onChange={(e) => setRow(row.invoiceId, { withheld: e.target.value })}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
      <Button type="primary" style={{ marginTop: 16 }} loading={save.isPending} onClick={submit}>
        {t('receivables.common.save')}
      </Button>
    </div>
  );
}

import { cashMethods, type CashMethod } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { cashbookApi } from './api';
import { entryProblem, optional, transferProblem } from './form';

const today = () => new Date().toISOString().slice(0, 10);

/** A new receipt, payment or transfer (spec P2-03 section 5). */
export function EntryPage({ kind }: { kind: 'receipt' | 'payment' | 'transfer' }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [txnDate, setTxnDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CashMethod>('cash');
  const [reference, setReference] = useState('');
  const [description, setDescription] = useState('');
  const [tag, setTag] = useState('');
  const [approvalDocId, setApprovalDocId] = useState('');
  const [requested, setRequested] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['cashbook', 'accounts', false],
    queryFn: () => cashbookApi.accounts(false),
  });
  const options = (accounts.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} ${a.name}${a.balance === undefined ? '' : ` (${a.balance})`}`,
  }));

  const save = useMutation<unknown>({
    mutationFn: () => {
      if (kind === 'transfer') {
        return cashbookApi.transfer({
          fromAccountId: accountId,
          toAccountId,
          txnDate,
          amount: amount.trim(),
          ...(optional(reference) === undefined ? {} : { reference: reference.trim() }),
          ...(optional(description) === undefined ? {} : { description: description.trim() }),
        });
      }
      const body = {
        accountId,
        txnDate,
        amount: amount.trim(),
        method,
        ...(optional(reference) === undefined ? {} : { reference: reference.trim() }),
        ...(optional(description) === undefined ? {} : { description: description.trim() }),
        ...(optional(tag) === undefined ? {} : { accountTag: tag.trim() }),
        ...(optional(approvalDocId) === undefined ? {} : { approvalDocId: approvalDocId.trim() }),
      };
      return kind === 'receipt' ? cashbookApi.receipt(body) : cashbookApi.payment(body);
    },
    onSuccess: () => void navigate('/cashbook/book'),
  });
  const ask = useMutation({
    mutationFn: () =>
      cashbookApi.requestApproval({ docType: 'payment', amount: amount.trim(), accountId }),
    onSuccess: (result) => {
      setApprovalDocId(result.approvalDocId);
      setRequested(true);
    },
  });

  const found =
    kind === 'transfer'
      ? transferProblem({ fromAccountId: accountId, toAccountId, txnDate, amount })
      : entryProblem({ accountId, txnDate, amount });
  const submit = () => {
    if (found !== null) {
      setProblem(t(`cashbook.entry.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };
  const askApproval = () => {
    const missing = entryProblem({ accountId, txnDate, amount });
    if (missing === 'account' || missing === 'amount') {
      setProblem(t(`cashbook.entry.problem.${missing}`));
      return;
    }
    setProblem(null);
    ask.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t(`cashbook.entry.title.${kind}`)}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      <Space direction="vertical" style={{ maxWidth: 480, width: '100%' }}>
        <Select
          aria-label={t(kind === 'transfer' ? 'cashbook.entry.from' : 'cashbook.txn.account')}
          placeholder={t(kind === 'transfer' ? 'cashbook.entry.from' : 'cashbook.txn.account')}
          options={options}
          value={accountId === '' ? undefined : accountId}
          onChange={setAccountId}
          style={{ width: '100%' }}
        />
        {kind === 'transfer' && (
          <Select
            aria-label={t('cashbook.entry.to')}
            placeholder={t('cashbook.entry.to')}
            options={options}
            value={toAccountId === '' ? undefined : toAccountId}
            onChange={setToAccountId}
            style={{ width: '100%' }}
          />
        )}
        <Input
          aria-label={t('cashbook.txn.date')}
          type="date"
          value={txnDate}
          onChange={(e) => setTxnDate(e.target.value)}
        />
        <Input
          aria-label={t('cashbook.entry.amount')}
          placeholder={t('cashbook.entry.amount')}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {kind !== 'transfer' && (
          <Select
            aria-label={t('cashbook.entry.method')}
            value={method}
            onChange={setMethod}
            options={cashMethods.map((value) => ({ value, label: t(`cashbook.method.${value}`) }))}
          />
        )}
        <Input
          aria-label={t('cashbook.entry.reference')}
          placeholder={t('cashbook.entry.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <Input
          aria-label={t('cashbook.txn.description')}
          placeholder={t('cashbook.txn.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {kind !== 'transfer' && (
          <Input
            aria-label={t('cashbook.txn.tag')}
            placeholder={t('cashbook.txn.tag')}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        )}
        {kind === 'payment' && (
          <Space.Compact style={{ width: '100%' }}>
            <Input
              aria-label={t('cashbook.entry.approval')}
              placeholder={t('cashbook.entry.approval')}
              value={approvalDocId}
              onChange={(e) => setApprovalDocId(e.target.value)}
            />
            <Button loading={ask.isPending} onClick={askApproval}>
              {t('cashbook.entry.askApproval')}
            </Button>
          </Space.Compact>
        )}
        {requested && <Alert type="info" message={t('cashbook.entry.requested')} />}
        <Button type="primary" loading={save.isPending} onClick={submit}>
          {t('cashbook.entry.save')}
        </Button>
      </Space>
    </div>
  );
}

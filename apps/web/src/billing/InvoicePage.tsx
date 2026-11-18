import { billingPermissions as perm, formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { billingApi, type CreditNote, type Invoice } from './api';
import { isPositiveAmount, optionalAmount } from './form';

/** One invoice: its figures with the tax preview, the actions of its state, and its credit notes. */
export function InvoicePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [creditMode, setCreditMode] = useState<'partial' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const invoice = useQuery({
    queryKey: ['billing', 'invoice', id],
    queryFn: () => billingApi.invoice(id),
  });
  const data = invoice.data;
  const draft = data?.status === 'draft';
  const preview = useQuery({
    queryKey: ['billing', 'invoice', id, 'preview'],
    queryFn: () => billingApi.preview(id),
    enabled: draft,
    retry: false,
  });
  const credits = useQuery({
    queryKey: ['billing', 'invoice', id, 'credits'],
    queryFn: () => billingApi.creditNotes(id),
    enabled: data !== undefined && data.number !== null,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['billing'] });

  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => void refresh(),
  });
  const download = useMutation({
    mutationFn: async () => {
      window.open(URL.createObjectURL(await billingApi.pdf(id)), '_blank');
    },
  });
  const credit = useMutation({
    mutationFn: () =>
      creditMode === 'cancel'
        ? billingApi.cancelByCreditNote(id, reason.trim())
        : billingApi.createCreditNote(id, {
            reason: reason.trim(),
            ...(optionalAmount(amount) === undefined ? {} : { baseAmount: amount.trim() }),
          }),
    onSuccess: () => {
      setCreditMode(null);
      setReason('');
      setAmount('');
      void refresh();
    },
  });

  const sendCredit = () => {
    if (
      reason.trim() === '' ||
      (creditMode === 'partial' && amount.trim() !== '' && !isPositiveAmount(amount))
    ) {
      setProblem(t('billing.credit.incomplete'));
      return;
    }
    setProblem(null);
    credit.mutate();
  };

  if (data === undefined) return null;
  const figures = draft ? preview.data : data;
  const issued = data.status === 'issued';

  return (
    <div>
      <Link to={`/projects/${data.projectId}`}>{t('billing.back')}</Link>
      <Typography.Title level={3}>
        {data.number ?? t('billing.invoice.draftNumber')}{' '}
        <Tag>{t(`billing.status.${data.status}`)}</Tag>
      </Typography.Title>
      {data.approval.status === 'pending' && (
        <Alert type="info" style={{ marginBottom: 12 }} message={t('billing.invoice.waiting')} />
      )}
      <Space style={{ marginBottom: 16 }} wrap>
        {draft && can(perm.invoiceCreate) && (
          <Button
            type="primary"
            onClick={() => act.mutate(() => billingApi.submit(id, data.version))}
          >
            {t('billing.action.submit')}
          </Button>
        )}
        {data.status === 'approved' && can(perm.invoiceIssue) && (
          <Button
            type="primary"
            onClick={() => act.mutate(() => billingApi.issue(id, data.version))}
          >
            {t('billing.action.issue')}
          </Button>
        )}
        {['draft', 'pending_approval', 'approved'].includes(data.status) &&
          can(perm.invoiceCreate) && (
            <Button danger onClick={() => act.mutate(() => billingApi.cancel(id, data.version))}>
              {t('billing.action.cancel')}
            </Button>
          )}
        {issued && can(perm.creditNoteCreate) && (
          <>
            <Button onClick={() => setCreditMode('partial')}>
              {t('billing.action.creditNote')}
            </Button>
            <Button danger onClick={() => setCreditMode('cancel')}>
              {t('billing.action.cancelByCreditNote')}
            </Button>
          </>
        )}
        <Button loading={download.isPending} onClick={() => download.mutate()}>
          {t('billing.action.pdf')}
        </Button>
      </Space>

      {draft && preview.isError && (
        <Alert
          type="error"
          style={{ marginBottom: 12 }}
          message={
            preview.error instanceof ApiError ? preview.error.message : t('billing.preview.error')
          }
        />
      )}
      <Descriptions
        bordered
        size="small"
        column={2}
        title={draft ? t('billing.preview.title') : t('billing.invoice.figures')}
      >
        <Descriptions.Item label={t('billing.invoice.date')}>
          {formatDate(data.invoiceDate)}
        </Descriptions.Item>
        <Descriptions.Item label={t('billing.invoice.due')}>
          {formatDate(
            figures !== undefined && 'dueDate' in figures ? figures.dueDate : data.dueDate,
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('billing.invoice.authority')}>
          {figures !== undefined && 'authorityCode' in figures ? (figures.authorityCode ?? '') : ''}{' '}
          {figures !== undefined && 'registrationNumber' in figures
            ? (figures.registrationNumber ?? '')
            : ''}
        </Descriptions.Item>
        <Descriptions.Item label={t('billing.invoice.base')}>
          {formatAmount(data.baseAmount)}
        </Descriptions.Item>
        {figures !== undefined && (
          <>
            <Descriptions.Item label={t('billing.invoice.recovery')}>
              {formatAmount(figures.advanceRecovery)}
            </Descriptions.Item>
            <Descriptions.Item label={t('billing.invoice.taxable')}>
              {formatAmount(figures.taxableBase)}
            </Descriptions.Item>
            <Descriptions.Item label={t('billing.invoice.tax')}>
              {formatAmount(figures.taxTotal)}
            </Descriptions.Item>
            <Descriptions.Item label={t('billing.invoice.gross')}>
              {formatAmount(figures.grossTotal)}
            </Descriptions.Item>
            <Descriptions.Item label={t('billing.invoice.withholding')}>
              {formatAmount(figures.withholdingExpected)}
            </Descriptions.Item>
            <Descriptions.Item label={t('billing.invoice.advanceMode')}>
              {t(
                figures.taxOnAdvanceAtReceipt
                  ? 'billing.invoice.deduction'
                  : 'billing.invoice.reducesBase',
              )}
            </Descriptions.Item>
          </>
        )}
      </Descriptions>

      <Table<Invoice['lines'][number]>
        rowKey="lineNo"
        size="small"
        pagination={false}
        style={{ marginTop: 16 }}
        dataSource={data.lines}
        columns={[
          { title: t('billing.line.description'), dataIndex: 'description' },
          {
            title: t('billing.line.amount'),
            align: 'right',
            render: (_, row) => formatAmount(row.amount),
          },
        ]}
      />

      {data.number !== null && (
        <>
          <Typography.Title level={4} style={{ marginTop: 24 }}>
            {t('billing.credit.title')}
          </Typography.Title>
          <Table<CreditNote>
            rowKey="id"
            size="small"
            pagination={false}
            locale={{ emptyText: t('billing.credit.empty') }}
            dataSource={credits.data ?? []}
            columns={[
              {
                title: t('billing.credit.number'),
                render: (_, row) => row.number ?? t('billing.invoice.draftNumber'),
              },
              { title: t('billing.credit.reason'), dataIndex: 'reason' },
              {
                title: t('billing.credit.gross'),
                align: 'right',
                render: (_, row) => formatAmount(row.grossTotal),
              },
              {
                title: t('billing.credit.status'),
                render: (_, row) => (
                  <Tag>
                    {row.status === 'issued'
                      ? t('billing.credit.issued')
                      : t(`billing.credit.approval.${row.approval.status}`)}
                  </Tag>
                ),
              },
              {
                title: '',
                render: (_, row) =>
                  can(perm.creditNoteCreate) && row.status === 'draft' ? (
                    row.approval.status === 'approved' ? (
                      <Button
                        size="small"
                        onClick={() =>
                          act.mutate(() => billingApi.issueCreditNote(row.id, row.version))
                        }
                      >
                        {t('billing.credit.issue')}
                      </Button>
                    ) : ['none', 'rejected', 'returned', 'cancelled'].includes(
                        row.approval.status,
                      ) ? (
                      <Button
                        size="small"
                        onClick={() =>
                          act.mutate(() => billingApi.submitCreditNote(row.id, row.version))
                        }
                      >
                        {t('billing.credit.submit')}
                      </Button>
                    ) : null
                  ) : null,
              },
            ]}
          />
        </>
      )}

      <Modal
        open={creditMode !== null}
        title={
          creditMode === 'cancel'
            ? t('billing.credit.cancelTitle')
            : t('billing.credit.dialogTitle')
        }
        okText={creditMode === 'cancel' ? t('billing.credit.cancelOk') : t('billing.credit.create')}
        cancelText={t('common.cancel')}
        confirmLoading={credit.isPending}
        onCancel={() => setCreditMode(null)}
        onOk={sendCredit}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {problem !== null && <Alert type="error" message={problem} />}
          <Input.TextArea
            aria-label={t('billing.credit.reason')}
            placeholder={t('billing.credit.reason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {creditMode === 'partial' && (
            <Input
              addonBefore={t('billing.credit.amount')}
              aria-label={t('billing.credit.amount')}
              placeholder={t('billing.credit.amountHint')}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          )}
        </Space>
      </Modal>
    </div>
  );
}

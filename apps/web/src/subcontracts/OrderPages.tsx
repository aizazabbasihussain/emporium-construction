import { formatDate, workOrderStatuses, type WorkOrderStatus } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  subcontractsApi,
  type BackCharge,
  type Certificate,
  type Variation,
  type WorkOrder,
  type WorkOrderHeader,
} from './api';
import { backChargeProblem, optional, orderProblem, variationProblem } from './form';
import { amountText, failure, useCostCodes, useProjects, useSubcontractors } from './hooks';

/** The work orders queue by status (spec P2-06 section 5). */
export function WorkOrdersPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkOrderStatus | undefined>(undefined);
  const { nameOf } = useSubcontractors();
  const orders = useQuery({
    queryKey: ['subcontracts', 'orders', status ?? 'all'],
    queryFn: () => subcontractsApi.orders(status),
  });
  return (
    <div>
      <Typography.Title level={3}>{t('subcontracts.orders.title')}</Typography.Title>
      <Space style={{ marginBottom: 12 }}>
        <Select
          aria-label={t('subcontracts.common.status')}
          allowClear
          placeholder={t('subcontracts.common.status')}
          style={{ width: 220 }}
          value={status}
          onChange={(value) => setStatus(value)}
          options={workOrderStatuses.map((value) => ({
            value,
            label: t(`subcontracts.status.${value}`),
          }))}
        />
        <Link to="/subcontracts/work-orders/new">
          <Button type="primary">{t('subcontracts.orders.new')}</Button>
        </Link>
      </Space>
      {orders.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<WorkOrderHeader>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('subcontracts.orders.none') }}
        dataSource={orders.data?.items ?? []}
        columns={[
          {
            title: t('subcontracts.orders.number'),
            render: (_, row) => (
              <Link to={`/subcontracts/work-orders/${row.id}`}>{row.number}</Link>
            ),
          },
          { title: t('subcontracts.orders.titleField'), dataIndex: 'title' },
          {
            title: t('subcontracts.common.subcontractor'),
            render: (_, row) => nameOf(row.partyId),
          },
          {
            title: t('subcontracts.orders.contract'),
            align: 'right',
            render: (_, row) => amountText(row.currentContractAmount),
          },
          {
            title: t('subcontracts.orders.certified'),
            align: 'right',
            render: (_, row) => amountText(row.certifiedAmount),
          },
          {
            title: t('subcontracts.common.status'),
            render: (_, row) => <Tag>{t(`subcontracts.status.${row.status}`)}</Tag>,
          },
        ]}
      />
    </div>
  );
}

/** A new work order (BR-1). Retention is not offered: it is out of scope (BR-8). */
export function WorkOrderFormPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useProjects();
  const parties = useSubcontractors();
  const codes = useCostCodes();
  const [projectId, setProjectId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [title, setTitle] = useState('');
  const [scopeText, setScopeText] = useState('');
  const [contractAmount, setContractAmount] = useState('');
  const [costCodeId, setCostCodeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chosenCode = costCodeId === '' ? codes.subcontractCode : costCodeId;

  const save = useMutation({
    mutationFn: () =>
      subcontractsApi.createOrder({
        projectId,
        partyId,
        title: title.trim(),
        contractAmount: contractAmount.trim(),
        costCodeId: chosenCode,
        ...(optional(scopeText) === undefined ? {} : { scopeText: scopeText.trim() }),
        ...(startDate === '' ? {} : { startDate }),
        ...(endDate === '' ? {} : { endDate }),
      }),
    onSuccess: (order) => navigate(`/subcontracts/work-orders/${order.id}`),
    onError: (error) => setProblem(failure(t, error)),
  });

  const submit = () => {
    const found = orderProblem({
      projectId,
      partyId,
      title,
      contractAmount,
      costCodeId: chosenCode,
      startDate,
      endDate,
    });
    if (found !== null) {
      setProblem(t(`subcontracts.orders.problem.${found}`));
      return;
    }
    setProblem(null);
    save.mutate();
  };

  return (
    <div>
      <Typography.Title level={3}>{t('subcontracts.orders.newTitle')}</Typography.Title>
      {problem !== null && <Alert type="warning" message={problem} style={{ marginBottom: 8 }} />}
      <Space direction="vertical" style={{ maxWidth: 560, width: '100%' }}>
        <Select
          aria-label={t('subcontracts.common.project')}
          placeholder={t('subcontracts.common.project')}
          showSearch
          optionFilterProp="label"
          value={projectId === '' ? undefined : projectId}
          onChange={setProjectId}
          options={projects.options}
        />
        <Select
          aria-label={t('subcontracts.common.subcontractor')}
          placeholder={t('subcontracts.common.subcontractor')}
          showSearch
          optionFilterProp="label"
          value={partyId === '' ? undefined : partyId}
          onChange={setPartyId}
          options={parties.options}
        />
        <Input
          aria-label={t('subcontracts.orders.titleField')}
          placeholder={t('subcontracts.orders.titleField')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input.TextArea
          aria-label={t('subcontracts.orders.scope')}
          placeholder={t('subcontracts.orders.scope')}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
        />
        <Input
          aria-label={t('subcontracts.orders.contractAmount')}
          placeholder={t('subcontracts.orders.contractAmount')}
          inputMode="decimal"
          value={contractAmount}
          onChange={(e) => setContractAmount(e.target.value)}
        />
        <Select
          aria-label={t('subcontracts.common.costCode')}
          placeholder={t('subcontracts.common.costCode')}
          showSearch
          optionFilterProp="label"
          value={chosenCode === '' ? undefined : chosenCode}
          onChange={setCostCodeId}
          options={codes.options}
        />
        <Input
          aria-label={t('subcontracts.orders.startDate')}
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <Input
          aria-label={t('subcontracts.orders.endDate')}
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
        <Button type="primary" loading={save.isPending} onClick={submit}>
          {t('subcontracts.common.save')}
        </Button>
      </Space>
    </div>
  );
}

/** One work order: its commitment, approval, variations, certificates and back-charges. */
export function WorkOrderPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const client = useQueryClient();
  const { nameOf } = useSubcontractors();
  const projects = useProjects();
  const codes = useCostCodes();
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [variation, setVariation] = useState({ amount: '', reason: '' });
  const [charge, setCharge] = useState({
    description: '',
    amount: '',
    recoversCost: false,
    costCodeId: '',
  });

  const order = useQuery({
    queryKey: ['subcontracts', 'order', id],
    queryFn: () => subcontractsApi.order(id),
  });
  const certificates = useQuery({
    queryKey: ['subcontracts', 'certificates', id],
    queryFn: () => subcontractsApi.certificates(id),
  });
  const charges = useQuery({
    queryKey: ['subcontracts', 'back-charges', id],
    queryFn: () => subcontractsApi.backCharges(id),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['subcontracts'] });
  const command = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setError(null);
      return refresh();
    },
    onError: (e) => setError(failure(t, e)),
  });

  if (order.isError) return <Alert type="error" message={t('common.loadError')} />;
  const current: WorkOrder | undefined = order.data;
  if (current === undefined) return null;

  const addVariation = () => {
    const found = variationProblem(variation);
    if (found !== null) return setError(t(`subcontracts.variations.problem.${found}`));
    setVariation({ amount: '', reason: '' });
    return command.mutate(() =>
      subcontractsApi.addVariation(id, {
        amount: variation.amount.trim(),
        reason: variation.reason.trim(),
      }),
    );
  };
  const addCharge = () => {
    const found = backChargeProblem(charge);
    if (found !== null) return setError(t(`subcontracts.backCharges.problem.${found}`));
    setCharge({ description: '', amount: '', recoversCost: false, costCodeId: '' });
    return command.mutate(() =>
      subcontractsApi.addBackCharge(id, {
        description: charge.description.trim(),
        amount: charge.amount.trim(),
        ...(charge.recoversCost ? { recoversCost: true, costCodeId: charge.costCodeId } : {}),
      }),
    );
  };
  const open = current.status === 'active';
  const head: WorkOrderHeader = current;

  return (
    <div>
      <Typography.Title level={3}>
        {current.number} · {current.title}
      </Typography.Title>
      {error !== null && <Alert type="warning" message={error} style={{ marginBottom: 8 }} />}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Tag>{t(`subcontracts.status.${current.status}`)}</Tag>
          <span>{nameOf(current.partyId)}</span>
          <span>{projects.nameOf(current.projectId)}</span>
          {current.startDate !== null && <span>{formatDate(current.startDate)}</span>}
          {current.endDate !== null && <span>→ {formatDate(current.endDate)}</span>}
        </Space>
        <Space wrap size="large">
          <span>
            {t('subcontracts.orders.contract')}: {amountText(current.currentContractAmount)}
          </span>
          <span>
            {t('subcontracts.orders.certified')}: {amountText(current.certifiedAmount)}
          </span>
          <span>
            {t('subcontracts.orders.committed')}: {amountText(current.committedAmount)}
          </span>
          {current.approval.status === 'pending' && (
            <Tag color="gold">
              {t('subcontracts.orders.waiting', { role: current.approval.currentRole ?? '' })}
            </Tag>
          )}
        </Space>
        <Space wrap>
          {current.status === 'draft' && (
            <Button
              type="primary"
              onClick={() => command.mutate(() => subcontractsApi.orderAction(head, 'submit'))}
            >
              {t('subcontracts.orders.submit')}
            </Button>
          )}
          {(current.status === 'draft' || open) && (
            <Button
              onClick={() => command.mutate(() => subcontractsApi.orderAction(head, 'cancel'))}
            >
              {t('subcontracts.orders.cancel')}
            </Button>
          )}
          {(open || current.status === 'completed') && (
            <>
              <Input
                aria-label={t('subcontracts.orders.closeReason')}
                placeholder={t('subcontracts.orders.closeReason')}
                style={{ width: 260 }}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                onClick={() => command.mutate(() => subcontractsApi.closeOrder(head, reason))}
              >
                {t('subcontracts.orders.close')}
              </Button>
            </>
          )}
          <Link to={`/subcontracts/work-orders/${id}/ledger`}>
            {t('subcontracts.orders.ledger')}
          </Link>
        </Space>

        <Typography.Title level={4}>{t('subcontracts.variations.title')}</Typography.Title>
        <Table<Variation>
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: t('subcontracts.variations.none') }}
          dataSource={current.variations}
          columns={[
            { title: '#', dataIndex: 'seq' },
            {
              title: t('subcontracts.common.amount'),
              align: 'right',
              render: (_, row) => amountText(row.amount),
            },
            { title: t('subcontracts.variations.reason'), dataIndex: 'reason' },
            {
              title: t('subcontracts.common.status'),
              render: (_, row) => <Tag>{t(`subcontracts.variationStatus.${row.status}`)}</Tag>,
            },
            {
              title: '',
              render: (_, row) =>
                row.status === 'draft' && (
                  <Space>
                    <Button
                      size="small"
                      onClick={() =>
                        command.mutate(() => subcontractsApi.decideVariation(row, 'approve'))
                      }
                    >
                      {t('subcontracts.variations.approve')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        command.mutate(() => subcontractsApi.decideVariation(row, 'reject'))
                      }
                    >
                      {t('subcontracts.variations.reject')}
                    </Button>
                  </Space>
                ),
            },
          ]}
        />
        {open && (
          <Space wrap>
            <Input
              aria-label={t('subcontracts.variations.amount')}
              placeholder={t('subcontracts.variations.amount')}
              value={variation.amount}
              onChange={(e) => setVariation({ ...variation, amount: e.target.value })}
            />
            <Input
              aria-label={t('subcontracts.variations.reason')}
              placeholder={t('subcontracts.variations.reason')}
              value={variation.reason}
              onChange={(e) => setVariation({ ...variation, reason: e.target.value })}
            />
            <Button onClick={addVariation}>{t('subcontracts.variations.add')}</Button>
          </Space>
        )}

        <Typography.Title level={4}>{t('subcontracts.certificates.title')}</Typography.Title>
        <Table<Certificate>
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: t('subcontracts.certificates.none') }}
          dataSource={certificates.data ?? []}
          columns={[
            {
              title: t('subcontracts.certificates.number'),
              render: (_, row) => (
                <Link to={`/subcontracts/certificates/${row.id}`}>{row.number}</Link>
              ),
            },
            {
              title: t('subcontracts.certificates.date'),
              render: (_, row) => formatDate(row.certificateDate),
            },
            { title: '%', dataIndex: 'cumulativePercent' },
            {
              title: t('subcontracts.certificates.net'),
              align: 'right',
              render: (_, row) => amountText(row.netCertified),
            },
            {
              title: t('subcontracts.common.status'),
              render: (_, row) => <Tag>{t(`subcontracts.certificateStatus.${row.status}`)}</Tag>,
            },
          ]}
        />
        {open && (
          <Link to={`/subcontracts/work-orders/${id}/certificates/new`}>
            <Button>{t('subcontracts.certificates.new')}</Button>
          </Link>
        )}

        <Typography.Title level={4}>{t('subcontracts.backCharges.title')}</Typography.Title>
        <Table<BackCharge>
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: t('subcontracts.backCharges.none') }}
          dataSource={charges.data ?? []}
          columns={[
            { title: t('subcontracts.backCharges.description'), dataIndex: 'description' },
            {
              title: t('subcontracts.common.amount'),
              align: 'right',
              render: (_, row) => amountText(row.amount),
            },
            {
              title: t('subcontracts.backCharges.recovers'),
              render: (_, row) => (row.recoversCost ? t('common.yes') : t('common.no')),
            },
            {
              title: t('subcontracts.backCharges.linked'),
              render: (_, row) =>
                row.certificateId !== null && (
                  <Link to={`/subcontracts/certificates/${row.certificateId}`}>
                    {t('subcontracts.backCharges.certificate')}
                  </Link>
                ),
            },
          ]}
        />
        {open && (
          <Space wrap>
            <Input
              aria-label={t('subcontracts.backCharges.description')}
              placeholder={t('subcontracts.backCharges.description')}
              value={charge.description}
              onChange={(e) => setCharge({ ...charge, description: e.target.value })}
            />
            <Input
              aria-label={t('subcontracts.backCharges.amount')}
              placeholder={t('subcontracts.backCharges.amount')}
              value={charge.amount}
              onChange={(e) => setCharge({ ...charge, amount: e.target.value })}
            />
            <Checkbox
              checked={charge.recoversCost}
              onChange={(e) => setCharge({ ...charge, recoversCost: e.target.checked })}
            >
              {t('subcontracts.backCharges.recovers')}
            </Checkbox>
            {charge.recoversCost && (
              <Select
                aria-label={t('subcontracts.backCharges.costCode')}
                placeholder={t('subcontracts.backCharges.costCode')}
                style={{ width: 220 }}
                value={charge.costCodeId === '' ? undefined : charge.costCodeId}
                onChange={(value) => setCharge({ ...charge, costCodeId: value })}
                options={codes.options}
              />
            )}
            <Button onClick={addCharge}>{t('subcontracts.backCharges.add')}</Button>
          </Space>
        )}
      </Space>
    </div>
  );
}

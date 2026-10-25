import { estimateLineKinds, estimateSuppliers, estimationPermissions } from '@emporium/shared';
import { formatAmount } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Col, Input, Row, Select, Space, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { estimationApi, type Estimate, type EstimateLine } from './api';
import { useLineReferences } from './lists';
import { MarginPanel } from './MarginPanel';

const blank = (v: string) => v.trim();

function EstimateEditor({ estimate }: { estimate: Estimate }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { costCodeOptions, unitOptions } = useLineReferences();
  const draft = estimate.status === 'draft';
  const [title, setTitle] = useState(estimate.title);
  const [price, setPrice] = useState(estimate.proposedPrice ?? '');
  const [overhead, setOverhead] = useState(estimate.overheadPercent);
  const [contingency, setContingency] = useState(estimate.contingencyPercent);
  const [target, setTarget] = useState(estimate.targetMarginPercent);
  const [lines, setLines] = useState<EstimateLine[]>(estimate.lines);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLines(estimate.lines);
    setTitle(estimate.title);
    setPrice(estimate.proposedPrice ?? '');
    setOverhead(estimate.overheadPercent);
    setContingency(estimate.contingencyPercent);
    setTarget(estimate.targetMarginPercent);
  }, [estimate]);

  const fail = (cause: unknown) => {
    setSaved(false);
    setError(
      cause instanceof ApiError
        ? t(`estimation.errors.${cause.code}`, { defaultValue: cause.message })
        : t('common.saveError'),
    );
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['estimation'] });

  const save = useMutation({
    mutationFn: () =>
      estimationApi.updateEstimate(estimate.id, {
        title,
        workType: estimate.workType,
        sector: estimate.sector,
        leadId: estimate.leadId,
        partyId: estimate.partyId,
        overheadPercent: overhead,
        contingencyPercent: contingency,
        targetMarginPercent: target,
        proposedPrice: blank(price) === '' ? null : blank(price),
        version: estimate.version,
        lines: lines.map((line) => ({
          description: line.description,
          lineKind: line.lineKind,
          itemId: line.itemId,
          costCodeId: line.costCodeId,
          unitCode: line.unitCode,
          quantity: line.quantity,
          rate: line.rate,
          suppliedBy: line.suppliedBy,
          note: line.note,
        })),
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      await refresh();
    },
    onError: fail,
  });
  const lock = useMutation({
    mutationFn: () => estimationApi.lock(estimate.id, estimate.version),
    onSuccess: async () => {
      setError(null);
      await refresh();
    },
    onError: fail,
  });
  const revise = useMutation({
    mutationFn: () => estimationApi.revise(estimate.id),
    onSuccess: async (revision) => {
      await refresh();
      void navigate(`/estimation/estimates/${revision.id}`);
    },
    onError: fail,
  });

  const change = (index: number, patch: Partial<EstimateLine>) => {
    setSaved(false);
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const missing = (line: EstimateLine) => line.suppliedBy === 'company' && Number(line.rate) === 0;

  return (
    <div>
      <Typography.Title level={3}>
        {estimate.number} <Tag>{t('estimation.revision', { revision: estimate.revision })}</Tag>
        <Tag color={draft ? 'blue' : estimate.status === 'locked' ? 'green' : 'default'}>
          {t(`estimation.status.${estimate.status}`)}
        </Tag>
      </Typography.Title>
      <Link to="/estimation/estimates">{t('estimation.back')}</Link>
      {error !== null && <Alert type="error" message={error} style={{ margin: '8px 0' }} />}
      {saved && <Alert type="success" message={t('common.saved')} style={{ margin: '8px 0' }} />}
      {!draft && (
        <Alert type="info" message={t('estimation.readOnly')} style={{ margin: '8px 0' }} />
      )}
      <Row gutter={16}>
        <Col xs={24} lg={16}>
          <Space wrap style={{ margin: '8px 0' }}>
            <Input
              aria-label={t('estimation.field.title')}
              disabled={!draft}
              style={{ width: 280 }}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Input
              aria-label={t('estimation.field.price')}
              disabled={!draft}
              addonBefore={t('estimation.field.price')}
              style={{ width: 240 }}
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
            <Input
              aria-label={t('estimation.field.overhead')}
              disabled={!draft}
              addonBefore={t('estimation.field.overhead')}
              addonAfter="%"
              style={{ width: 200 }}
              value={overhead}
              onChange={(event) => setOverhead(event.target.value)}
            />
            <Input
              aria-label={t('estimation.field.contingency')}
              disabled={!draft}
              addonBefore={t('estimation.field.contingency')}
              addonAfter="%"
              style={{ width: 220 }}
              value={contingency}
              onChange={(event) => setContingency(event.target.value)}
            />
            <Input
              aria-label={t('estimation.field.target')}
              disabled={!draft}
              addonBefore={t('estimation.field.target')}
              addonAfter="%"
              style={{ width: 200 }}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </Space>
          <Table<EstimateLine>
            size="small"
            rowKey={(_, index) => String(index)}
            pagination={false}
            dataSource={lines}
            rowClassName={(line) => (missing(line) ? 'rate-missing' : '')}
            columns={[
              {
                title: t('estimation.line.description'),
                render: (_, line, index) => (
                  <Input
                    aria-label={t('estimation.line.description')}
                    disabled={!draft}
                    value={line.description}
                    onChange={(event) => change(index, { description: event.target.value })}
                  />
                ),
              },
              {
                title: t('estimation.line.kind'),
                render: (_, line, index) => (
                  <Select
                    aria-label={t('estimation.line.kind')}
                    disabled={!draft}
                    style={{ width: 140 }}
                    value={line.lineKind}
                    onChange={(value) => change(index, { lineKind: value })}
                    options={estimateLineKinds.map((value) => ({
                      value,
                      label: t(`estimation.lineKind.${value}`),
                    }))}
                  />
                ),
              },
              {
                title: t('estimation.line.costCode'),
                render: (_, line, index) => (
                  <Select
                    aria-label={t('estimation.line.costCode')}
                    disabled={!draft}
                    style={{ width: 170 }}
                    value={line.costCodeId}
                    onChange={(value) => change(index, { costCodeId: value })}
                    options={costCodeOptions}
                  />
                ),
              },
              {
                title: t('estimation.line.unit'),
                render: (_, line, index) => (
                  <Select
                    aria-label={t('estimation.line.unit')}
                    disabled={!draft}
                    style={{ width: 80 }}
                    value={line.unitCode}
                    onChange={(value) => change(index, { unitCode: value })}
                    options={unitOptions}
                  />
                ),
              },
              {
                title: t('estimation.line.quantity'),
                render: (_, line, index) => (
                  <Input
                    aria-label={t('estimation.line.quantity')}
                    disabled={!draft}
                    style={{ width: 100 }}
                    value={line.quantity}
                    onChange={(event) => change(index, { quantity: event.target.value })}
                  />
                ),
              },
              {
                title: t('estimation.line.rate'),
                render: (_, line, index) => (
                  <Space>
                    <Input
                      aria-label={t('estimation.line.rate')}
                      disabled={!draft}
                      style={{ width: 110 }}
                      value={line.rate}
                      onChange={(event) => change(index, { rate: event.target.value })}
                    />
                    {missing(line) && <Tag color="red">{t('estimation.line.rateMissing')}</Tag>}
                  </Space>
                ),
              },
              {
                title: t('estimation.line.suppliedBy'),
                render: (_, line, index) => (
                  <Select
                    aria-label={t('estimation.line.suppliedBy')}
                    disabled={!draft}
                    style={{ width: 100 }}
                    value={line.suppliedBy}
                    onChange={(value) => change(index, { suppliedBy: value })}
                    options={estimateSuppliers.map((value) => ({
                      value,
                      label: t(`estimation.supplier.${value}`),
                    }))}
                  />
                ),
              },
              {
                title: t('estimation.line.total'),
                align: 'right',
                render: (_, line) =>
                  line.lineTotal === undefined ? '' : formatAmount(line.lineTotal),
              },
              {
                render: (_, __, index) =>
                  draft && (
                    <Button
                      onClick={() => {
                        setSaved(false);
                        setLines(lines.filter((_l, i) => i !== index));
                      }}
                    >
                      {t('estimation.remove')}
                    </Button>
                  ),
              },
            ]}
          />
          {draft && (
            <Space style={{ marginTop: 12 }}>
              <Button
                onClick={() =>
                  setLines([
                    ...lines,
                    {
                      description: '',
                      lineKind: 'material',
                      itemId: null,
                      costCodeId: costCodeOptions[0]?.value ?? '',
                      unitCode: 'nos',
                      quantity: '0',
                      rate: '0',
                      suppliedBy: 'company',
                      note: null,
                    },
                  ])
                }
              >
                {t('estimation.addLine')}
              </Button>
              {can(estimationPermissions.estimateUpdate) && (
                <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  {t('common.save')}
                </Button>
              )}
              {can(estimationPermissions.estimateLock) && (
                <Button loading={lock.isPending} onClick={() => lock.mutate()}>
                  {t('estimation.lock')}
                </Button>
              )}
            </Space>
          )}
          {estimate.status === 'locked' && can(estimationPermissions.estimateCreate) && (
            <Button
              style={{ marginTop: 12 }}
              loading={revise.isPending}
              onClick={() => revise.mutate()}
            >
              {t('estimation.revise')}
            </Button>
          )}
        </Col>
        <Col xs={24} lg={8}>
          <MarginPanel
            lines={lines}
            terms={{
              overheadPercent: overhead,
              contingencyPercent: contingency,
              targetMarginPercent: target,
              proposedPrice: blank(price) === '' ? null : blank(price),
            }}
          />
        </Col>
      </Row>
    </div>
  );
}

export function EstimateEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const estimate = useQuery({
    queryKey: ['estimation', 'estimate', id],
    queryFn: () => estimationApi.estimate(id),
  });
  if (estimate.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (estimate.data === undefined) return null;
  return <EstimateEditor estimate={estimate.data} />;
}

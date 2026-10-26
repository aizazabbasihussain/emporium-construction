import { formatAmount, variationsPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Modal, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { useLineReferences } from '../estimation/lists';
import { variationsApi, type VariationHeader, type VariationLine } from './api';
import { emptyLine, LinesEditor, linesProblem } from './LinesEditor';

/** The variations of a project: the contract value, the list and the new-variation dialog. */
export function ProjectVariations({ projectId, active }: { projectId: string; active: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { costCodeOptions } = useLineReferences();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [reason, setReason] = useState('');
  const [discoveredOn, setDiscoveredOn] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<VariationLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['variations', projectId],
    queryFn: () => variationsApi.list(projectId),
  });
  const contract = useQuery({
    queryKey: ['variations', projectId, 'contract'],
    queryFn: () => variationsApi.contractValue(projectId),
  });

  const create = useMutation({
    mutationFn: () =>
      variationsApi.create(projectId, {
        title: title.trim(),
        reason: reason.trim(),
        discoveredOn,
        lines,
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['variations', projectId] });
      void navigate(`/variations/${created.id}`);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`variations.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const submit = () => {
    if (title.trim() === '' || discoveredOn === '') {
      setError(t('variations.newDialog.incomplete'));
      return;
    }
    const problem = linesProblem(lines);
    if (problem !== null) {
      setError(t(`variations.lines.${problem}`));
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <div>
      {contract.data !== undefined && (
        <Descriptions
          bordered
          size="small"
          column={3}
          title={t('variations.contract.title')}
          style={{ marginBottom: 16 }}
        >
          <Descriptions.Item label={t('variations.contract.original')}>
            {formatAmount(contract.data.originalContractValue)}
          </Descriptions.Item>
          <Descriptions.Item label={t('variations.contract.approved')}>
            {formatAmount(contract.data.approvedPriceImpact)}
          </Descriptions.Item>
          <Descriptions.Item label={t('variations.contract.current')}>
            {formatAmount(contract.data.currentContractValue)}
          </Descriptions.Item>
        </Descriptions>
      )}
      {can(perm.create) && active && (
        <Button type="primary" style={{ marginBottom: 12 }} onClick={() => setOpen(true)}>
          {t('variations.new')}
        </Button>
      )}
      <Table<VariationHeader>
        rowKey="id"
        pagination={false}
        locale={{ emptyText: t('variations.empty') }}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('variations.field.number'),
            render: (_, row) => <Link to={`/variations/${row.id}`}>{row.number}</Link>,
          },
          { title: t('variations.field.title'), dataIndex: 'title' },
          {
            title: t('variations.field.status'),
            render: (_, row) => <Tag>{t(`variations.status.${row.status}`)}</Tag>,
          },
          {
            title: t('variations.field.priceImpact'),
            align: 'right',
            render: (_, row) => formatAmount(row.priceImpact),
          },
          {
            title: t('variations.field.costImpact'),
            align: 'right',
            render: (_, row) => formatAmount(row.costImpact),
          },
          {
            title: t('variations.field.atRisk'),
            align: 'right',
            render: (_, row) =>
              Number(row.atRiskTotal) > 0 ? (
                <Tag color="red">{formatAmount(row.atRiskTotal)}</Tag>
              ) : (
                formatAmount(row.atRiskTotal)
              ),
          },
        ]}
      />
      <Modal
        open={open}
        width={900}
        title={t('variations.newDialog.title')}
        okText={t('variations.newDialog.create')}
        cancelText={t('common.cancel')}
        confirmLoading={create.isPending}
        onCancel={() => setOpen(false)}
        onOk={submit}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {error !== null && <Alert type="error" message={error} />}
          <Input
            aria-label={t('variations.field.title')}
            placeholder={t('variations.field.title')}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Input.TextArea
            aria-label={t('variations.field.reason')}
            placeholder={t('variations.field.reason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Input
            type="date"
            addonBefore={t('variations.field.discoveredOn')}
            aria-label={t('variations.field.discoveredOn')}
            value={discoveredOn}
            onChange={(event) => setDiscoveredOn(event.target.value)}
          />
          <LinesEditor lines={lines} costCodeOptions={costCodeOptions} onChange={setLines} />
        </Space>
      </Modal>
    </div>
  );
}

import {
  employmentTypes,
  workerStatuses,
  workforcePermissions as perm,
  formatDate,
  type WorkerStatus,
} from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { workforceApi, type Worker } from './api';
import {
  emptyWorker,
  karachiToday,
  useErrorText,
  workerBody,
  workerProblem,
  type WorkerDraft,
} from './form';

/** The workers the caller may see; a supervisor gets only the members of their own teams. */
export function WorkersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [text, setText] = useState('');
  const [tradeCode, setTradeCode] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<WorkerStatus | undefined>('active');
  const [draft, setDraft] = useState<WorkerDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trades = useQuery({ queryKey: ['workforce-trades'], queryFn: workforceApi.trades });
  const list = useQuery({
    queryKey: ['workforce-workers', text, tradeCode, status],
    queryFn: () =>
      workforceApi.workers({
        ...(text.trim() === '' ? {} : { text: text.trim() }),
        ...(tradeCode === undefined ? {} : { tradeCode }),
        ...(status === undefined ? {} : { status }),
      }),
  });
  const tradeName = (code: string) =>
    trades.data?.find((trade) => trade.code === code)?.name ?? code;

  const create = useMutation({
    mutationFn: (value: WorkerDraft) => workforceApi.createWorker(workerBody(value)),
    onSuccess: async () => {
      setDraft(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['workforce-workers'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const problem = draft === null ? null : workerProblem(draft);
  const patch = (change: Partial<WorkerDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...change }));

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('workforce.workers.title')}
        </Typography.Title>
        {can(perm.workerManage) && (
          <Button type="primary" onClick={() => setDraft(emptyWorker(karachiToday()))}>
            {t('workforce.workers.new')}
          </Button>
        )}
      </Space>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          allowClear
          style={{ width: 240 }}
          aria-label={t('common.search')}
          placeholder={t('workforce.workers.searchHint')}
          onSearch={(value) => setText(value)}
        />
        <Select
          allowClear
          style={{ minWidth: 180 }}
          aria-label={t('workforce.field.trade')}
          placeholder={t('workforce.workers.allTrades')}
          value={tradeCode}
          onChange={(value: string | undefined) => setTradeCode(value)}
          options={(trades.data ?? []).map((trade) => ({ value: trade.code, label: trade.name }))}
        />
        <Select
          allowClear
          style={{ minWidth: 160 }}
          aria-label={t('workforce.field.status')}
          placeholder={t('workforce.workers.allStatuses')}
          value={status}
          onChange={(value: WorkerStatus | undefined) => setStatus(value)}
          options={workerStatuses.map((s) => ({ value: s, label: t(`workforce.status.${s}`) }))}
        />
      </Space>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      <Table<Worker>
        rowKey="id"
        size="small"
        scroll={{ x: 'max-content' }}
        loading={list.isLoading}
        locale={{ emptyText: t('workforce.workers.empty') }}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: t('workforce.field.code'),
            render: (_, worker) => (
              <Link to={`/workforce/workers/${worker.id}`}>{worker.code}</Link>
            ),
          },
          { title: t('workforce.field.fullName'), dataIndex: 'fullName' },
          { title: t('workforce.field.trade'), render: (_, worker) => tradeName(worker.tradeCode) },
          {
            title: t('workforce.field.employmentType'),
            render: (_, worker) => t(`workforce.employment.${worker.employmentType}`),
          },
          { title: t('workforce.field.cnic'), render: (_, worker) => worker.cnic ?? '' },
          {
            title: t('workforce.field.status'),
            render: (_, worker) => <Tag>{t(`workforce.status.${worker.status}`)}</Tag>,
          },
        ]}
      />
      <Modal
        open={draft !== null}
        title={t('workforce.workers.new')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: problem !== null, loading: create.isPending }}
        onOk={() => draft !== null && create.mutate(draft)}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
      >
        {draft !== null && (
          <Form layout="vertical">
            {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
            <Form.Item label={t('workforce.field.fullName')} required>
              <Input
                aria-label={t('workforce.field.fullName')}
                value={draft.fullName}
                onChange={(event) => patch({ fullName: event.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('workforce.field.fatherName')}>
              <Input
                aria-label={t('workforce.field.fatherName')}
                value={draft.fatherName}
                onChange={(event) => patch({ fatherName: event.target.value })}
              />
            </Form.Item>
            <Form.Item
              label={t('workforce.field.cnic')}
              extra={t('workforce.workers.cnicHint')}
              validateStatus={problem === 'cnic' ? 'error' : undefined}
              help={problem === 'cnic' ? t('workforce.workers.cnicInvalid') : undefined}
            >
              <Input
                aria-label={t('workforce.field.cnic')}
                value={draft.cnic}
                onChange={(event) => patch({ cnic: event.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('workforce.field.phone')}>
              <Input
                aria-label={t('workforce.field.phone')}
                value={draft.phone}
                onChange={(event) => patch({ phone: event.target.value })}
              />
            </Form.Item>
            <Form.Item label={t('workforce.field.trade')} required>
              <Select
                aria-label={t('workforce.field.trade')}
                value={draft.tradeCode === '' ? undefined : draft.tradeCode}
                onChange={(value: string) => patch({ tradeCode: value })}
                options={(trades.data ?? []).map((trade) => ({
                  value: trade.code,
                  label: trade.name,
                }))}
              />
            </Form.Item>
            <Form.Item label={t('workforce.field.employmentType')} required>
              <Select
                aria-label={t('workforce.field.employmentType')}
                value={draft.employmentType}
                onChange={(value: WorkerDraft['employmentType']) =>
                  patch({ employmentType: value })
                }
                options={employmentTypes.map((e) => ({
                  value: e,
                  label: t(`workforce.employment.${e}`),
                }))}
              />
            </Form.Item>
            <Form.Item label={t('workforce.field.joinedOn')} required>
              <Input
                type="date"
                aria-label={t('workforce.field.joinedOn')}
                value={draft.joinedOn}
                onChange={(event) => patch({ joinedOn: event.target.value })}
              />
              {draft.joinedOn !== '' && (
                <Typography.Text type="secondary">{formatDate(draft.joinedOn)}</Typography.Text>
              )}
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  );
}

import { formatAmount, formatDate } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, List, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { approvalsApi, type ApprovalRequest } from './api';

export function ApprovalsInboxPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ApprovalRequest | null>(null);
  const [comment, setComment] = useState('');
  const [needsComment, setNeedsComment] = useState(false);
  const [decided, setDecided] = useState(false);

  const inbox = useQuery({ queryKey: ['approvals-inbox'], queryFn: () => approvalsApi.inbox() });

  const act = useMutation({
    mutationFn: (action: 'approve' | 'reject' | 'return') =>
      approvalsApi.act(
        (selected as ApprovalRequest).id,
        action,
        comment,
        (selected as ApprovalRequest).version,
      ),
    onSuccess: async () => {
      setSelected(null);
      setComment('');
      setDecided(true);
      await queryClient.invalidateQueries({ queryKey: ['approvals-inbox'] });
    },
  });

  const failure = (error: unknown): string =>
    error instanceof ApiError
      ? t(`approvals.errors.${error.code}`, { defaultValue: error.message })
      : t('common.saveError');

  const decide = (action: 'approve' | 'reject' | 'return') => {
    if (action !== 'approve' && comment.trim() === '') {
      setNeedsComment(true);
      return;
    }
    setNeedsComment(false);
    act.mutate(action);
  };

  return (
    <div>
      <Typography.Title level={3}>{t('approvals.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('approvals.hint')}</Typography.Paragraph>
      {inbox.isError && <Alert type="error" message={t('common.loadError')} />}
      {decided && <Alert type="success" message={t('approvals.decided')} />}
      <Table<ApprovalRequest>
        rowKey="id"
        size="small"
        loading={inbox.isLoading}
        dataSource={inbox.data?.items ?? []}
        locale={{ emptyText: t('approvals.empty') }}
        pagination={false}
        columns={[
          {
            title: t('approvals.columns.document'),
            render: (_, r) => `${r.docType} #${r.revision}`,
          },
          { title: t('approvals.columns.amount'), render: (_, r) => formatAmount(r.amount) },
          {
            title: t('approvals.columns.step'),
            render: (_, r) =>
              t('approvals.step', {
                step: r.currentStep,
                total: r.steps.length,
                role: r.currentRole,
              }),
          },
          {
            title: t('approvals.columns.submitted'),
            render: (_, r) => formatDate(r.submittedAt.slice(0, 10)),
          },
          {
            title: '',
            render: (_, r) => (
              <Button
                size="small"
                onClick={() => {
                  setSelected(r);
                  setDecided(false);
                  setNeedsComment(false);
                  act.reset();
                }}
              >
                {t('approvals.open')} {r.docType}
              </Button>
            ),
          },
        ]}
      />

      {selected && (
        <Space direction="vertical" size="middle" style={{ display: 'flex', marginTop: 16 }}>
          <Typography.Title level={4}>{t('approvals.detail')}</Typography.Title>
          <Typography.Text>
            {selected.docType} #{selected.revision} — {formatAmount(selected.amount)}
          </Typography.Text>
          <Typography.Title level={5}>{t('approvals.history')}</Typography.Title>
          <List
            size="small"
            locale={{ emptyText: t('approvals.noHistory') }}
            dataSource={selected.actions}
            renderItem={(a) => (
              <List.Item>
                {t(`approvals.actions.${a.action}`)} —{' '}
                {t('approvals.step', {
                  step: a.stepNo,
                  total: selected.steps.length,
                  role: selected.steps.find((s) => s.stepNo === a.stepNo)?.roleCode,
                })}
                {a.comment ? `: ${a.comment}` : ''}
              </List.Item>
            )}
          />
          <label>
            {t('approvals.comment')}
            <Input.TextArea
              aria-label={t('approvals.comment')}
              rows={2}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {needsComment && <Alert type="warning" message={t('approvals.commentRequired')} />}
          {act.isError && <Alert type="error" message={failure(act.error)} />}
          <Space>
            <Button type="primary" loading={act.isPending} onClick={() => decide('approve')}>
              {t('approvals.approve')}
            </Button>
            <Button danger loading={act.isPending} onClick={() => decide('reject')}>
              {t('approvals.reject')}
            </Button>
            <Button loading={act.isPending} onClick={() => decide('return')}>
              {t('approvals.returnBack')}
            </Button>
          </Space>
        </Space>
      )}
    </div>
  );
}

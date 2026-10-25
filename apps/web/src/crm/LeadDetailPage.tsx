import { crmPermissions, formatAmount, formatDate, siteVisitEntityType } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Form, Input, List, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { AttachmentUploader } from '../files/AttachmentUploader';
import { dateRule } from '../master/rules';
import { crmApi, type CrmReference } from './api';
import { LeadForm } from './LeadForm';
import { StageChangeDialog } from './StageChangeDialog';

function useFailure() {
  const { t } = useTranslation();
  return (cause: unknown): string =>
    cause instanceof ApiError
      ? t(`crm.errors.${cause.code}`, { defaultValue: cause.message })
      : t('common.saveError');
}

function AddVisit({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const failure = useFailure();
  const [form] = Form.useForm<{ visitDate: string; notes?: string }>();
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (values: { visitDate: string; notes?: string | undefined }) =>
      crmApi.addVisit(leadId, values),
    onSuccess: async () => {
      form.resetFields();
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['crm', 'lead', leadId] });
    },
    onError: (cause) => setError(failure(cause)),
  });
  return (
    <Form form={form} layout="inline" style={{ marginTop: 12 }}>
      <Form.Item
        name="visitDate"
        label={t('crm.visit.date')}
        rules={[{ required: true, message: t('common.required') }, dateRule(t)]}
      >
        <Input placeholder="yyyy-mm-dd" />
      </Form.Item>
      <Form.Item name="notes" label={t('crm.visit.notes')}>
        <Input />
      </Form.Item>
      <Button
        type="primary"
        loading={add.isPending}
        onClick={() =>
          void form.validateFields().then(
            (values) => add.mutate(values),
            () => undefined,
          )
        }
      >
        {t('crm.visit.add')}
      </Button>
      {error !== null && <Alert type="error" message={error} style={{ marginTop: 8 }} />}
    </Form>
  );
}

function AddFollowUp({ leadId }: { leadId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const failure = useFailure();
  const [form] = Form.useForm<{ dueDate: string; note?: string }>();
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (values: { dueDate: string; note?: string | undefined }) =>
      crmApi.addFollowUp(leadId, values),
    onSuccess: async () => {
      form.resetFields();
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
    },
    onError: (cause) => setError(failure(cause)),
  });
  return (
    <Form form={form} layout="inline" style={{ marginTop: 12 }}>
      <Form.Item
        name="dueDate"
        label={t('crm.followUp.dueDate')}
        rules={[{ required: true, message: t('common.required') }, dateRule(t)]}
      >
        <Input placeholder="yyyy-mm-dd" />
      </Form.Item>
      <Form.Item name="note" label={t('crm.followUp.note')}>
        <Input />
      </Form.Item>
      <Button
        type="primary"
        loading={add.isPending}
        onClick={() =>
          void form.validateFields().then(
            (values) => add.mutate(values),
            () => undefined,
          )
        }
      >
        {t('crm.followUp.add')}
      </Button>
      {error !== null && <Alert type="error" message={error} style={{ marginTop: 8 }} />}
    </Form>
  );
}

export function LeadDetailPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const failure = useFailure();
  const { id = '' } = useParams();
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({ queryKey: ['crm', 'lead', id], queryFn: () => crmApi.detail(id) });
  const reference = useQuery({ queryKey: ['crm', 'reference'], queryFn: crmApi.reference });
  const done = useMutation({
    mutationFn: ({ followUpId, version }: { followUpId: string; version: number }) =>
      crmApi.completeFollowUp(followUpId, version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crm'] }),
    onError: (cause) => setError(failure(cause)),
  });

  if (detail.isError) return <Alert type="error" message={t('common.loadError')} />;
  if (!detail.data || !reference.data) return null;
  const { lead, visits, followUps, history } = detail.data;
  const ref: CrmReference = reference.data;
  const stageName = (code: string | null) =>
    code === null ? '' : (ref.stages.find((stage) => stage.code === code)?.name ?? code);

  return (
    <div>
      <Typography.Title level={3}>
        {lead.number} <Tag>{stageName(lead.stageCode)}</Tag>
        {lead.hasOverdueFollowUp && <Tag color="red">{t('crm.followUp.overdue')}</Tag>}
      </Typography.Title>
      <Link to="/crm/leads">{t('crm.lead.back')}</Link>
      <Space style={{ margin: '12px 0', display: 'flex' }}>
        {can(crmPermissions.leadUpdate) && (
          <>
            <Button onClick={() => setEditing(true)}>{t('crm.lead.edit')}</Button>
            <Button onClick={() => setMoving(true)}>{t('crm.stage.change')}</Button>
          </>
        )}
      </Space>
      {error !== null && <Alert type="error" message={error} />}
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label={t('crm.lead.contactName')}>{lead.contactName}</Descriptions.Item>
        <Descriptions.Item label={t('crm.lead.contactPhone')}>
          {lead.contactPhone}
        </Descriptions.Item>
        <Descriptions.Item label={t('crm.lead.workType')}>
          {t(`crm.workType.${lead.workType}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('crm.lead.sector')}>
          {t(`crm.sector.${lead.sector}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('crm.lead.expectedValue')}>
          {lead.expectedValue === null ? '' : formatAmount(lead.expectedValue)}
        </Descriptions.Item>
        <Descriptions.Item label={t('crm.lead.siteAddress')}>{lead.siteAddress}</Descriptions.Item>
        {lead.lossReasonCode !== null && (
          <Descriptions.Item label={t('crm.stage.lossReason')}>
            {ref.lossReasons.find((reason) => reason.code === lead.lossReasonCode)?.name}
          </Descriptions.Item>
        )}
        <Descriptions.Item label={t('crm.lead.description')} span={2}>
          {lead.description}
        </Descriptions.Item>
      </Descriptions>

      <Typography.Title level={4}>{t('crm.timeline.title')}</Typography.Title>
      <List
        size="small"
        bordered
        dataSource={history}
        renderItem={(entry) => (
          <List.Item>
            {formatDate(entry.at)}:{' '}
            {entry.fromStage === null
              ? t('crm.timeline.created', { to: stageName(entry.toStage) })
              : t('crm.timeline.moved', {
                  from: stageName(entry.fromStage),
                  to: stageName(entry.toStage),
                })}
          </List.Item>
        )}
      />

      <Typography.Title level={4}>{t('crm.visit.title')}</Typography.Title>
      <List
        bordered
        locale={{ emptyText: t('crm.visit.empty') }}
        dataSource={visits}
        renderItem={(visit) => (
          <List.Item>
            <div style={{ width: '100%' }}>
              <Typography.Text strong>{formatDate(visit.visitDate)}</Typography.Text> {visit.notes}
              <AttachmentUploader entityType={siteVisitEntityType} entityId={visit.id} />
            </div>
          </List.Item>
        )}
      />
      {can(crmPermissions.visitManage) && lead.stageKind === 'open' && (
        <AddVisit leadId={lead.id} />
      )}

      <Typography.Title level={4}>{t('crm.followUp.title')}</Typography.Title>
      <List
        bordered
        locale={{ emptyText: t('crm.followUp.empty') }}
        dataSource={followUps}
        renderItem={(followUp) => (
          <List.Item
            actions={
              followUp.status === 'open' && can(crmPermissions.followupManage)
                ? [
                    <Button
                      key="done"
                      size="small"
                      onClick={() =>
                        done.mutate({ followUpId: followUp.id, version: followUp.version })
                      }
                    >
                      {t('crm.followUp.markDone')}
                    </Button>,
                  ]
                : []
            }
          >
            {formatDate(followUp.dueDate)} {followUp.note}{' '}
            <Tag>{t(`crm.followUp.status.${followUp.status}`)}</Tag>
            {followUp.overdue && <Tag color="red">{t('crm.followUp.overdue')}</Tag>}
          </List.Item>
        )}
      />
      {can(crmPermissions.followupManage) && lead.stageKind === 'open' && (
        <AddFollowUp leadId={lead.id} />
      )}

      <LeadForm open={editing} lead={lead} reference={ref} onClose={() => setEditing(false)} />
      {moving && (
        <StageChangeDialog open lead={lead} reference={ref} onClose={() => setMoving(false)} />
      )}
    </div>
  );
}

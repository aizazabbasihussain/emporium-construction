import { crmPermissions, formatAmount, leadSectors } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { crmApi, type CrmReference, type Lead } from './api';
import { LeadForm } from './LeadForm';
import { StageChangeDialog } from './StageChangeDialog';

const PAGE_SIZE = 20;

function LeadTags({ lead }: { lead: Lead }) {
  const { t } = useTranslation();
  return lead.hasOverdueFollowUp ? <Tag color="red">{t('crm.followUp.overdue')}</Tag> : null;
}

function Board({
  leads,
  reference,
  canMove,
  onMove,
}: {
  leads: Lead[];
  reference: CrmReference;
  canMove: boolean;
  onMove: (lead: Lead) => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }} aria-label={t('crm.view.board')}>
      {reference.stages
        .filter((stage) => stage.active)
        .map((stage) => {
          const inStage = leads.filter((lead) => lead.stageCode === stage.code);
          return (
            <Card
              key={stage.code}
              size="small"
              style={{ minWidth: 240 }}
              title={`${stage.name} (${inStage.length})`}
              data-testid={`stage-${stage.code}`}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                {inStage.map((lead) => (
                  <Card key={lead.id} size="small" type="inner">
                    <Link to={`/crm/leads/${lead.id}`}>{lead.number}</Link> <LeadTags lead={lead} />
                    <div>{lead.contactName}</div>
                    {lead.expectedValue !== null && <div>{formatAmount(lead.expectedValue)}</div>}
                    {canMove && lead.stageKind === 'open' && (
                      <Button size="small" onClick={() => onMove(lead)}>
                        {t('crm.stage.change')} {lead.number}
                      </Button>
                    )}
                  </Card>
                ))}
              </Space>
            </Card>
          );
        })}
    </div>
  );
}

export function LeadsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [view, setView] = useState<'list' | 'board'>('list');
  const [text, setText] = useState('');
  const [stageCode, setStageCode] = useState<string | undefined>(undefined);
  const [sector, setSector] = useState<string | undefined>(undefined);
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Lead | null>(null);

  const reference = useQuery({ queryKey: ['crm', 'reference'], queryFn: crmApi.reference });
  const board = view === 'board';
  const leads = useQuery({
    queryKey: ['crm', 'leads', view, text, stageCode, sector, overdue, page],
    queryFn: () =>
      crmApi.leads({
        q: text.trim() === '' ? undefined : text.trim(),
        stageCode,
        sector,
        overdue: overdue ? true : undefined,
        limit: board ? 200 : PAGE_SIZE,
        offset: board ? 0 : (page - 1) * PAGE_SIZE,
      }),
  });
  const canUpdate = can(crmPermissions.leadUpdate);
  const stageName = (code: string) =>
    reference.data?.stages.find((stage) => stage.code === code)?.name ?? code;

  return (
    <div>
      <Typography.Title level={3}>{t('crm.lead.title')}</Typography.Title>
      {leads.isError && <Alert type="error" message={t('common.loadError')} />}
      <Space style={{ margin: '12px 0' }} wrap>
        <Segmented
          value={view}
          onChange={(value) => setView(value as 'list' | 'board')}
          options={[
            { value: 'list', label: t('crm.view.list') },
            { value: 'board', label: t('crm.view.board') },
          ]}
        />
        <Input.Search
          aria-label={t('common.search')}
          placeholder={t('common.search')}
          allowClear
          onSearch={(value) => {
            setText(value);
            setPage(1);
          }}
        />
        <Select
          aria-label={t('crm.lead.stage')}
          placeholder={t('crm.lead.stage')}
          allowClear
          style={{ width: 180 }}
          value={stageCode}
          onChange={(value: string | undefined) => {
            setStageCode(value);
            setPage(1);
          }}
          options={(reference.data?.stages ?? []).map((stage) => ({
            value: stage.code,
            label: stage.name,
          }))}
        />
        <Select
          aria-label={t('crm.lead.sector')}
          placeholder={t('crm.lead.sector')}
          allowClear
          style={{ width: 160 }}
          value={sector}
          onChange={(value: string | undefined) => {
            setSector(value);
            setPage(1);
          }}
          options={leadSectors.map((value) => ({ value, label: t(`crm.sector.${value}`) }))}
        />
        <Checkbox
          checked={overdue}
          onChange={(event) => {
            setOverdue(event.target.checked);
            setPage(1);
          }}
        >
          {t('crm.followUp.overdueOnly')}
        </Checkbox>
        {can(crmPermissions.leadCreate) && reference.data && (
          <Button type="primary" onClick={() => setCreating(true)}>
            {t('crm.lead.new')}
          </Button>
        )}
      </Space>
      {board && reference.data ? (
        <Board
          leads={leads.data?.items ?? []}
          reference={reference.data}
          canMove={canUpdate}
          onMove={setMoving}
        />
      ) : (
        <Table<Lead>
          rowKey="id"
          loading={leads.isLoading}
          dataSource={leads.data?.items ?? []}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: leads.data?.total ?? 0,
            showSizeChanger: false,
            onChange: setPage,
          }}
          columns={[
            {
              title: t('crm.lead.number'),
              render: (_, lead) => (
                <Space>
                  <Link to={`/crm/leads/${lead.id}`}>{lead.number}</Link>
                  <LeadTags lead={lead} />
                </Space>
              ),
            },
            { title: t('crm.lead.contactName'), dataIndex: 'contactName' },
            {
              title: t('crm.lead.workType'),
              render: (_, lead) => t(`crm.workType.${lead.workType}`),
            },
            { title: t('crm.lead.sector'), render: (_, lead) => t(`crm.sector.${lead.sector}`) },
            { title: t('crm.lead.stage'), render: (_, lead) => stageName(lead.stageCode) },
            {
              title: t('crm.lead.expectedValue'),
              render: (_, lead) =>
                lead.expectedValue === null ? '' : formatAmount(lead.expectedValue),
            },
          ]}
        />
      )}
      {reference.data && (
        <LeadForm open={creating} reference={reference.data} onClose={() => setCreating(false)} />
      )}
      {reference.data && moving !== null && (
        <StageChangeDialog
          open
          lead={moving}
          reference={reference.data}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

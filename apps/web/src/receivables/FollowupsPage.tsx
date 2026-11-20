import { formatDate, receivablesPermissions as perm } from '@emporium/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { masterApi, type Party } from '../master/api';
import { receivablesApi, type Followup } from './api';

const today = () => new Date().toISOString().slice(0, 10);

/** Open collection follow-ups; a bounced cheque opens one by itself (BR-6). */
export function FollowupsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [partyId, setPartyId] = useState('');
  const [dueDate, setDueDate] = useState(today());
  const [note, setNote] = useState('');

  const customers = useQuery({
    queryKey: ['master-parties', 'clients'],
    queryFn: () =>
      masterApi.listAll<Party>('/master/parties', { role: 'client', status: 'active' }),
  });
  const list = useQuery({
    queryKey: ['receivables', 'followups'],
    queryFn: receivablesApi.followups,
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ['receivables', 'followups'] });
  const create = useMutation({
    mutationFn: () => receivablesApi.createFollowup({ partyId, dueDate, note: note.trim() }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const finish = useMutation({ mutationFn: receivablesApi.finishFollowup, onSuccess: refresh });
  const names = new Map((customers.data ?? []).map((p) => [p.id, p.name]));
  const manage = can(perm.receiptCreate);

  return (
    <div>
      <Typography.Title level={3}>{t('receivables.followups.title')}</Typography.Title>
      {list.isError && <Alert type="error" message={t('common.loadError')} />}
      {manage && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Select
            aria-label={t('receivables.common.customer')}
            placeholder={t('receivables.common.customer')}
            showSearch
            optionFilterProp="label"
            value={partyId === '' ? undefined : partyId}
            onChange={setPartyId}
            options={(customers.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            style={{ width: 240 }}
          />
          <Input
            aria-label={t('receivables.followups.due')}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
          <Input
            aria-label={t('receivables.followups.note')}
            placeholder={t('receivables.followups.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            type="primary"
            disabled={partyId === '' || note.trim() === ''}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('receivables.followups.add')}
          </Button>
        </Space>
      )}
      <Table<Followup>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('receivables.followups.empty') }}
        dataSource={list.data ?? []}
        columns={[
          {
            title: t('receivables.common.customer'),
            render: (_, row) => names.get(row.partyId) ?? row.partyId,
          },
          { title: t('receivables.followups.due'), render: (_, row) => formatDate(row.dueDate) },
          { title: t('receivables.followups.note'), render: (_, row) => row.note },
          {
            title: '',
            render: (_, row) =>
              manage && (
                <Button loading={finish.isPending} onClick={() => finish.mutate(row)}>
                  {t('receivables.followups.done')}
                </Button>
              ),
          },
        ]}
      />
    </div>
  );
}

import { projectSectors, type ProjectSector } from '@emporium/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Input, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { masterApi, type Party } from '../master/api';
import { projectsApi, type ProjectDetail } from './api';

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: ProjectDetail) => void;
}

/** BR-3: a manual project needs a name, a client and a contract value. */
export function NewProjectDialog({ open, onClose, onCreated }: NewProjectDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [partyId, setPartyId] = useState<string | undefined>(undefined);
  const [sector, setSector] = useState<ProjectSector>('private');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clients = useQuery({
    queryKey: ['master-parties', 'clients'],
    queryFn: () => masterApi.list<Party>('/master/parties', { role: 'client', limit: 200 }),
  });

  const create = useMutation({
    mutationFn: () =>
      projectsApi.create({
        name: name.trim(),
        partyId,
        sector,
        originalContractValue: value.trim(),
      }),
    onSuccess: (project) => {
      setError(null);
      onCreated(project);
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`projects.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  return (
    <Modal
      open={open}
      title={t('projects.newDialog.title')}
      onCancel={onClose}
      onOk={() => {
        if (name.trim() === '' || partyId === undefined || value.trim() === '') {
          setError(t('projects.newDialog.incomplete'));
        } else {
          create.mutate();
        }
      }}
      okText={t('projects.newDialog.create')}
      cancelText={t('common.cancel')}
      confirmLoading={create.isPending}
      destroyOnClose
    >
      {error !== null && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input
          aria-label={t('projects.field.name')}
          placeholder={t('projects.field.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Select
          aria-label={t('projects.field.client')}
          placeholder={t('projects.field.client')}
          style={{ width: '100%' }}
          value={partyId}
          onChange={setPartyId}
          options={(clients.data?.items ?? []).map((party) => ({
            value: party.id,
            label: party.name,
          }))}
        />
        <Select
          aria-label={t('projects.field.sector')}
          style={{ width: '100%' }}
          value={sector}
          onChange={setSector}
          options={projectSectors.map((option) => ({
            value: option,
            label: t(`projects.sector.${option}`),
          }))}
        />
        <Input
          aria-label={t('projects.field.contractValue')}
          placeholder={t('projects.field.contractValue')}
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Space>
    </Modal>
  );
}

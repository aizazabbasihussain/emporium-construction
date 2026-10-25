import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { crmApi, type CrmReference, type Lead } from './api';

export interface StageChangeDialogProps {
  lead: Lead;
  reference: CrmReference;
  open: boolean;
  onClose: () => void;
  /** Called with the updated lead after the API accepted the move. */
  onMoved?: (lead: Lead) => void;
}

/**
 * Moves a lead to another stage (BR-2, BR-3). The loss reason is asked only for a lost stage; the
 * API checks every rule again, including the client and the reopen permission.
 */
export function StageChangeDialog({
  lead,
  reference,
  open,
  onClose,
  onMoved,
}: StageChangeDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [stageCode, setStageCode] = useState<string | undefined>(undefined);
  const [lossReasonCode, setLossReasonCode] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const target = reference.stages.find((stage) => stage.code === stageCode);
  const needsReason = target?.kind === 'lost';

  const move = useMutation({
    mutationFn: () =>
      crmApi.moveStage(lead.id, {
        stageCode: stageCode as string,
        lossReasonCode: needsReason ? lossReasonCode : undefined,
        version: lead.version,
      }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['crm'] });
      setStageCode(undefined);
      setLossReasonCode(undefined);
      setError(null);
      onMoved?.(updated);
      onClose();
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError
          ? t(`crm.errors.${cause.code}`, { defaultValue: cause.message })
          : t('common.saveError'),
      ),
  });

  const submit = () => {
    if (stageCode === undefined) {
      setError(t('crm.stage.chooseStage'));
    } else if (needsReason && lossReasonCode === undefined) {
      setError(t('crm.stage.reasonRequired'));
    } else {
      setError(null);
      move.mutate();
    }
  };

  return (
    <Modal
      open={open}
      title={t('crm.stage.title', { number: lead.number })}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Form layout="vertical">
        <Form.Item label={t('crm.stage.target')}>
          <Select
            aria-label={t('crm.stage.target')}
            value={stageCode}
            onChange={setStageCode}
            options={reference.stages
              .filter((stage) => stage.active && stage.code !== lead.stageCode)
              .map((stage) => ({ value: stage.code, label: stage.name }))}
          />
        </Form.Item>
        {needsReason && (
          <Form.Item label={t('crm.stage.lossReason')} required>
            <Select
              aria-label={t('crm.stage.lossReason')}
              value={lossReasonCode}
              onChange={setLossReasonCode}
              options={reference.lossReasons.map((reason) => ({
                value: reason.code,
                label: reason.name,
              }))}
            />
          </Form.Item>
        )}
        {target?.kind === 'won' && lead.partyId === null && (
          <Alert type="info" message={t('crm.stage.clientCreated')} style={{ marginBottom: 12 }} />
        )}
        {error !== null && <Alert type="error" message={error} />}
        <Space style={{ marginTop: 12 }}>
          <Button type="primary" loading={move.isPending} onClick={submit}>
            {t('crm.stage.move')}
          </Button>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
        </Space>
      </Form>
    </Modal>
  );
}

import { formatAmount } from '@emporium/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Select, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inventoryApi, type Movement } from './api';
import { useInventoryReferences } from './references';
import { DECIMAL, today, useErrorText } from './shared';

/** Issues material to a project. Large fields and few steps, so a storekeeper can use it on a phone (BR-3). */
export function IssuePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refs = useInventoryReferences();
  const errorText = useErrorText();
  const [storeId, setStoreId] = useState<string | undefined>(undefined);
  const [itemId, setItemId] = useState<string | undefined>(undefined);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [costCodeId, setCostCodeId] = useState<string | undefined>(undefined);
  const [quantity, setQuantity] = useState('');
  const [clientOwned, setClientOwned] = useState(false);
  const [ownerId, setOwnerId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Movement | null>(null);

  const issue = useMutation({
    mutationFn: inventoryApi.issue,
    onSuccess: (movement) => {
      setDone(movement);
      void queryClient.invalidateQueries({ queryKey: ['inventory-stock'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-ledger'] });
    },
    onError: (cause) => setError(errorText(cause)),
  });

  const submit = () => {
    setDone(null);
    if (storeId === undefined || itemId === undefined || projectId === undefined) {
      setError(t('inventory.issue.missing'));
      return;
    }
    if (!DECIMAL.test(quantity.trim()) || Number(quantity) <= 0) {
      setError(t('inventory.validation.quantity'));
      return;
    }
    if (clientOwned && ownerId === undefined) {
      setError(t('inventory.issue.ownerRequired'));
      return;
    }
    // BR-3: company stock needs a cost code from the form or from the item.
    if (!clientOwned && costCodeId === undefined && refs.defaultCostCode(itemId) === null) {
      setError(t('inventory.issue.costCodeRequired'));
      return;
    }
    setError(null);
    issue.mutate({
      storeId,
      itemId,
      quantity: quantity.trim(),
      costObject: { type: 'project', id: projectId },
      businessDate: today(),
      ...(costCodeId === undefined || clientOwned ? {} : { costCodeId }),
      ...(clientOwned && ownerId !== undefined
        ? { ownership: 'client' as const, ownerPartyId: ownerId }
        : {}),
    });
  };

  const defaultCode =
    itemId === undefined
      ? undefined
      : refs.costCodeOptions.find((o) => o.value === refs.defaultCostCode(itemId));

  return (
    <div style={{ maxWidth: 560 }}>
      <Typography.Title level={3}>{t('inventory.issue.title')}</Typography.Title>
      <Select
        showSearch
        optionFilterProp="label"
        size="large"
        style={{ width: '100%', marginBottom: 12 }}
        aria-label={t('inventory.field.store')}
        placeholder={t('inventory.field.store')}
        value={storeId}
        onChange={(value: string) => setStoreId(value)}
        options={refs.storeOptions}
      />
      <Select
        showSearch
        optionFilterProp="label"
        size="large"
        style={{ width: '100%', marginBottom: 12 }}
        aria-label={t('inventory.field.item')}
        placeholder={t('inventory.field.item')}
        value={itemId}
        onChange={(value: string) => setItemId(value)}
        options={refs.itemOptions}
      />
      <Input
        size="large"
        inputMode="decimal"
        style={{ marginBottom: 12 }}
        aria-label={t('inventory.field.quantity')}
        placeholder={t('inventory.field.quantity')}
        value={quantity}
        onChange={(event) => setQuantity(event.target.value)}
      />
      <Select
        showSearch
        optionFilterProp="label"
        size="large"
        style={{ width: '100%', marginBottom: 12 }}
        aria-label={t('inventory.field.project')}
        placeholder={t('inventory.field.project')}
        value={projectId}
        onChange={(value: string) => setProjectId(value)}
        options={refs.projectOptions}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        size="large"
        style={{ width: '100%', marginBottom: 4 }}
        aria-label={t('inventory.field.costCode')}
        placeholder={t('inventory.field.costCode')}
        value={costCodeId}
        onChange={(value: string | undefined) => setCostCodeId(value)}
        options={refs.costCodeOptions}
        disabled={clientOwned}
      />
      {defaultCode !== undefined && costCodeId === undefined && !clientOwned && (
        <div style={{ marginBottom: 12 }}>
          {t('inventory.issue.defaultCostCode', { code: defaultCode.label })}
        </div>
      )}
      <Checkbox
        style={{ margin: '12px 0' }}
        checked={clientOwned}
        onChange={(event) => setClientOwned(event.target.checked)}
      >
        {t('inventory.issue.clientOwned')}
      </Checkbox>
      {clientOwned && (
        <Select
          showSearch
          optionFilterProp="label"
          size="large"
          style={{ width: '100%', marginBottom: 12 }}
          aria-label={t('inventory.field.owner')}
          placeholder={t('inventory.field.owner')}
          value={ownerId}
          onChange={(value: string) => setOwnerId(value)}
          options={refs.clientOptions}
        />
      )}
      {error !== null && (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} />
      )}
      {done !== null && (
        <Alert
          style={{ marginBottom: 12 }}
          type="success"
          showIcon
          message={
            done.value === null
              ? t('inventory.issue.doneClient', { quantity: done.quantity })
              : t('inventory.issue.done', {
                  quantity: done.quantity,
                  value: formatAmount(done.value),
                })
          }
        />
      )}
      <Button type="primary" size="large" block loading={issue.isPending} onClick={submit}>
        {t('inventory.issue.submit')}
      </Button>
    </div>
  );
}

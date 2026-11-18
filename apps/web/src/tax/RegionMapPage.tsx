import {
  formatDate,
  supplyKinds,
  taxPermissions,
  taxRegions,
  type SupplyKind,
  type TaxRegion,
} from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { taxApi, type Authority, type RegionEntry } from './api';
import { optional } from './form';
import { AuthoritySelect, EnumSelect, RuleDialog, TextField } from './RuleDialog';

/** The authorities and which of them taxes a supply in each region (spec P2-01 BR-1). */
export function RegionMapPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [region, setRegion] = useState<TaxRegion | undefined>(undefined);
  const [supplyKind, setSupplyKind] = useState<SupplyKind | undefined>(undefined);
  const [authorityCode, setAuthorityCode] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const overview = useQuery({ queryKey: ['tax', 'rules'], queryFn: taxApi.overview });

  return (
    <div>
      <Typography.Title level={3}>{t('tax.regionMap.title')}</Typography.Title>
      <Typography.Paragraph>{t('tax.regionMap.hint')}</Typography.Paragraph>
      {overview.isError && <Alert type="error" message={t('common.loadError')} />}
      {done && <Alert type="success" message={t('tax.requested')} closable />}

      <Typography.Title level={4}>{t('tax.regionMap.authorities')}</Typography.Title>
      <Table<Authority>
        rowKey="code"
        size="small"
        pagination={false}
        dataSource={overview.data?.authorities ?? []}
        columns={[
          { title: t('tax.fields.authority'), dataIndex: 'code' },
          { title: t('tax.fields.name'), dataIndex: 'name' },
        ]}
      />

      <Typography.Title level={4}>{t('tax.regionMap.mapping')}</Typography.Title>
      {can(taxPermissions.ruleManage) && (
        <Button type="primary" onClick={() => setOpen(true)} style={{ margin: '12px 0' }}>
          {t('tax.regionMap.request')}
        </Button>
      )}
      <Table<RegionEntry>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('tax.regionMap.none') }}
        dataSource={overview.data?.regionMap ?? []}
        columns={[
          {
            title: t('tax.fields.region'),
            render: (_, row) => t(`tax.region.${row.region}`),
          },
          {
            title: t('tax.fields.supplyKind'),
            render: (_, row) => t(`tax.supplyKind.${row.supplyKind}`),
          },
          { title: t('tax.fields.authority'), dataIndex: 'authorityCode' },
          {
            title: t('tax.fields.effectiveFrom'),
            render: (_, row) => formatDate(row.effectiveFrom),
          },
          {
            title: t('tax.fields.effectiveTo'),
            render: (_, row) =>
              row.effectiveTo === null ? t('tax.open') : formatDate(row.effectiveTo),
          },
          { title: t('tax.fields.status'), render: (_, row) => t(`tax.status.${row.status}`) },
        ]}
      />
      <RuleDialog
        open={open}
        title={t('tax.regionMap.requestTitle')}
        fields={{ authorityCode, from, to }}
        send={() =>
          taxApi.requestRegion({
            region: region ?? 'islamabad',
            supplyKind: supplyKind ?? 'services',
            authorityCode: authorityCode as string,
            effectiveFrom: from,
            effectiveTo: optional(to),
          })
        }
        onClose={() => setOpen(false)}
        onSent={() => {
          setOpen(false);
          setDone(true);
        }}
      >
        <EnumSelect
          label={t('tax.fields.region')}
          value={region ?? 'islamabad'}
          values={taxRegions}
          labelOf={(value) => t(`tax.region.${value}`)}
          onChange={setRegion}
        />
        <EnumSelect
          label={t('tax.fields.supplyKind')}
          value={supplyKind ?? 'services'}
          values={supplyKinds}
          labelOf={(value) => t(`tax.supplyKind.${value}`)}
          onChange={setSupplyKind}
        />
        <AuthoritySelect
          authorities={overview.data?.authorities ?? []}
          value={authorityCode}
          onChange={setAuthorityCode}
        />
        <TextField
          label={t('tax.fields.effectiveFrom')}
          type="date"
          value={from}
          onChange={setFrom}
        />
        <TextField label={t('tax.fields.effectiveTo')} type="date" value={to} onChange={setTo} />
      </RuleDialog>
    </div>
  );
}

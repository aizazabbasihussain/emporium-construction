import { formatDate, supplyKinds, taxPermissions, type SupplyKind } from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { taxApi, type SalesRule } from './api';
import { optional } from './form';
import { AuthoritySelect, EnumSelect, RuleDialog, TextField } from './RuleDialog';

/** Sales tax rules with their effective dates, and the form to request a new one (spec P2-01 section 5). */
export function RulesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [authorityCode, setAuthorityCode] = useState<string | undefined>(undefined);
  const [supplyKind, setSupplyKind] = useState<SupplyKind | undefined>(undefined);
  const [nature, setNature] = useState('');
  const [rate, setRate] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const overview = useQuery({ queryKey: ['tax', 'rules'], queryFn: taxApi.overview });
  const settings = overview.data?.settings;

  const columns = [
    { title: t('tax.fields.authority'), dataIndex: 'authorityCode' },
    {
      title: t('tax.fields.supplyKind'),
      render: (_: unknown, row: SalesRule) => t(`tax.supplyKind.${row.supplyKind}`),
    },
    {
      title: t('tax.fields.nature'),
      render: (_: unknown, row: SalesRule) => row.nature ?? t('tax.anyNature'),
    },
    {
      title: t('tax.fields.rate'),
      render: (_: unknown, row: SalesRule) => `${row.ratePercent} %`,
    },
    { title: t('tax.fields.taxCode'), dataIndex: 'taxCode' },
    {
      title: t('tax.fields.effectiveFrom'),
      render: (_: unknown, row: SalesRule) => formatDate(row.effectiveFrom),
    },
    {
      title: t('tax.fields.effectiveTo'),
      render: (_: unknown, row: SalesRule) =>
        row.effectiveTo === null ? t('tax.open') : formatDate(row.effectiveTo),
    },
    {
      title: t('tax.fields.status'),
      render: (_: unknown, row: SalesRule) => t(`tax.status.${row.status}`),
    },
  ];

  return (
    <div>
      <Typography.Title level={3}>{t('tax.rules.title')}</Typography.Title>
      <Typography.Paragraph>{t('tax.rules.hint')}</Typography.Paragraph>
      {overview.isError && <Alert type="error" message={t('common.loadError')} />}
      {done && <Alert type="success" message={t('tax.requested')} closable />}
      {settings !== undefined && (
        <Typography.Paragraph>
          {t(`tax.rounding.${settings.roundingMode}`)}.{' '}
          {t(settings.pricesIncludeTax ? 'tax.pricesInclude' : 'tax.pricesExclude')}.
        </Typography.Paragraph>
      )}
      {can(taxPermissions.ruleManage) && (
        <Button type="primary" onClick={() => setOpen(true)} style={{ margin: '12px 0' }}>
          {t('tax.rules.request')}
        </Button>
      )}
      <Table<SalesRule>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('tax.rules.none') }}
        dataSource={overview.data?.items ?? []}
        columns={columns}
      />
      <RuleDialog
        open={open}
        title={t('tax.rules.requestTitle')}
        fields={{
          authorityCode,
          from,
          to,
          rate,
          taxCode,
        }}
        send={() =>
          taxApi.requestRule({
            authorityCode: authorityCode as string,
            supplyKind: supplyKind ?? 'services',
            nature: optional(nature),
            ratePercent: rate.trim(),
            taxCode: taxCode.trim(),
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
        <AuthoritySelect
          authorities={overview.data?.authorities ?? []}
          value={authorityCode}
          onChange={setAuthorityCode}
        />
        <EnumSelect
          label={t('tax.fields.supplyKind')}
          value={supplyKind ?? 'services'}
          values={supplyKinds}
          labelOf={(value) => t(`tax.supplyKind.${value}`)}
          onChange={setSupplyKind}
        />
        <TextField label={t('tax.fields.nature')} value={nature} onChange={setNature} />
        <TextField label={t('tax.fields.rate')} value={rate} onChange={setRate} />
        <TextField label={t('tax.fields.taxCode')} value={taxCode} onChange={setTaxCode} />
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

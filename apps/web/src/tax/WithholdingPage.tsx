import {
  formatDate,
  taxPermissions,
  withholdingBases,
  withholdingDirections,
  type WithholdingBase,
  type WithholdingDirection,
} from '@emporium/shared';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';
import { taxApi, type WithholdingRule } from './api';
import { optional } from './form';
import { AuthoritySelect, EnumSelect, RuleDialog, TextField } from './RuleDialog';

/** Withholding rules: what clients withhold from us and what we withhold from vendors (BR-4). */
export function WithholdingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [direction, setDirection] = useState<WithholdingDirection | undefined>(undefined);
  const [authorityCode, setAuthorityCode] = useState<string | undefined>(undefined);
  const [partyType, setPartyType] = useState('');
  const [nature, setNature] = useState('');
  const [rate, setRate] = useState('');
  const [base, setBase] = useState<WithholdingBase | undefined>(undefined);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const rules = useQuery({ queryKey: ['tax', 'withholding'], queryFn: taxApi.withholding });
  const overview = useQuery({ queryKey: ['tax', 'rules'], queryFn: taxApi.overview });

  return (
    <div>
      <Typography.Title level={3}>{t('tax.withholding.title')}</Typography.Title>
      <Typography.Paragraph>{t('tax.withholding.hint')}</Typography.Paragraph>
      {rules.isError && <Alert type="error" message={t('common.loadError')} />}
      {done && <Alert type="success" message={t('tax.requested')} closable />}
      {can(taxPermissions.ruleManage) && (
        <Button type="primary" onClick={() => setOpen(true)} style={{ margin: '12px 0' }}>
          {t('tax.withholding.request')}
        </Button>
      )}
      <Table<WithholdingRule>
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: t('tax.withholding.none') }}
        dataSource={rules.data?.items ?? []}
        columns={[
          {
            title: t('tax.fields.direction'),
            render: (_, row) => t(`tax.direction.${row.direction}`),
          },
          { title: t('tax.fields.authority'), dataIndex: 'authorityCode' },
          {
            title: t('tax.fields.partyType'),
            render: (_, row) => row.partyType ?? t('tax.anyParty'),
          },
          { title: t('tax.fields.nature'), dataIndex: 'nature' },
          { title: t('tax.fields.rate'), render: (_, row) => `${row.ratePercent} %` },
          { title: t('tax.fields.base'), render: (_, row) => t(`tax.base.${row.base}`) },
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
        title={t('tax.withholding.requestTitle')}
        fields={{ authorityCode, from, to, rate, nature, natureRequired: true }}
        send={() =>
          taxApi.requestWithholding({
            direction: direction ?? 'client_withholds',
            authorityCode: authorityCode as string,
            partyType: optional(partyType),
            nature: nature.trim(),
            ratePercent: rate.trim(),
            base: base ?? 'on_invoice_total',
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
          label={t('tax.fields.direction')}
          value={direction ?? 'client_withholds'}
          values={withholdingDirections}
          labelOf={(value) => t(`tax.direction.${value}`)}
          onChange={setDirection}
        />
        <AuthoritySelect
          authorities={overview.data?.authorities ?? []}
          value={authorityCode}
          onChange={setAuthorityCode}
        />
        <TextField label={t('tax.fields.partyType')} value={partyType} onChange={setPartyType} />
        <TextField label={t('tax.fields.nature')} value={nature} onChange={setNature} />
        <TextField label={t('tax.fields.rate')} value={rate} onChange={setRate} />
        <EnumSelect
          label={t('tax.fields.base')}
          value={base ?? 'on_invoice_total'}
          values={withholdingBases}
          labelOf={(value) => t(`tax.base.${value}`)}
          onChange={setBase}
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

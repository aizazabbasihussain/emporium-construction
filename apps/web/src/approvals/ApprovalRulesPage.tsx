import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, InputNumber, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../admin/api';
import { approvalsApi, type RuleBand, type RuleSet } from './api';

const today = () => new Date().toISOString().slice(0, 10);

const blankBand = (minAmount = '0'): RuleBand => ({
  minAmount,
  maxAmount: null,
  steps: [{ stepNo: 1, roleCode: 'management', minApprovers: 1 }],
});

export function ApprovalRulesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleSet | null>(null);
  const [saved, setSaved] = useState(false);

  const docTypes = useQuery({ queryKey: ['approval-doc-types'], queryFn: approvalsApi.docTypes });
  const rules = useQuery({
    queryKey: ['approval-rules', docType],
    queryFn: () => approvalsApi.rules(docType as string),
    enabled: docType !== null,
  });

  // The draft starts from the rule set in force: the latest one that has begun.
  useEffect(() => {
    if (rules.data === undefined) return;
    const sets = rules.data.sets;
    const inForce = [...sets].reverse().find((s) => s.effectiveFrom <= today()) ?? sets[0];
    setDraft(inForce ? structuredClone(inForce) : { effectiveFrom: today(), bands: [blankBand()] });
    setSaved(false);
  }, [rules.data]);

  const save = useMutation({
    mutationFn: () => approvalsApi.saveRules(docType as string, draft as RuleSet),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['approval-rules', docType] });
    },
  });

  const failure = (error: unknown): string =>
    error instanceof ApiError
      ? t(`approvalRules.errors.${error.code}`, { defaultValue: error.message })
      : t('common.saveError');

  const change = (next: RuleSet) => {
    setDraft(next);
    setSaved(false);
  };
  const setBand = (index: number, band: RuleBand) =>
    change({
      ...(draft as RuleSet),
      bands: (draft as RuleSet).bands.map((b, i) => (i === index ? band : b)),
    });

  return (
    <div>
      <Typography.Title level={3}>{t('approvalRules.title')}</Typography.Title>
      <Typography.Paragraph type="secondary">{t('approvalRules.hint')}</Typography.Paragraph>
      {(docTypes.isError || rules.isError) && (
        <Alert type="error" message={t('common.loadError')} />
      )}
      <label>
        {t('approvalRules.docType')}
        <Select
          aria-label={t('approvalRules.docType')}
          style={{ width: 320, display: 'block' }}
          placeholder={t('approvalRules.chooseDocType')}
          value={docType}
          onChange={(value) => {
            setDocType(value);
            setDraft(null);
          }}
          options={(docTypes.data?.items ?? []).map((value) => ({ value, label: value }))}
        />
      </label>

      {draft && (
        <Space direction="vertical" size="middle" style={{ display: 'flex', marginTop: 16 }}>
          <label>
            {t('approvalRules.effectiveFrom')}
            <Input
              aria-label={t('approvalRules.effectiveFrom')}
              style={{ width: 200, display: 'block' }}
              value={draft.effectiveFrom}
              onChange={(event) => change({ ...draft, effectiveFrom: event.target.value })}
            />
          </label>
          {draft.bands.map((band, index) => (
            <fieldset key={index} style={{ border: '1px solid #d9d9d9', padding: 12 }}>
              <Space wrap>
                <label>
                  {t('approvalRules.minAmount')}
                  <Input
                    aria-label={`${t('approvalRules.minAmount')} ${index + 1}`}
                    value={band.minAmount}
                    onChange={(event) => setBand(index, { ...band, minAmount: event.target.value })}
                  />
                </label>
                <label>
                  {t('approvalRules.maxAmount')}
                  <Input
                    aria-label={`${t('approvalRules.maxAmount')} ${index + 1}`}
                    value={band.maxAmount ?? ''}
                    onChange={(event) =>
                      setBand(index, {
                        ...band,
                        maxAmount: event.target.value === '' ? null : event.target.value,
                      })
                    }
                  />
                </label>
                <Button
                  onClick={() =>
                    change({ ...draft, bands: draft.bands.filter((_, i) => i !== index) })
                  }
                >
                  {t('approvalRules.removeBand')} {index + 1}
                </Button>
              </Space>
              {band.steps.map((step, stepIndex) => (
                <Space key={step.stepNo} wrap style={{ display: 'flex', marginTop: 8 }}>
                  <Typography.Text>
                    {t('approvalRules.stepTitle', { step: step.stepNo })}
                  </Typography.Text>
                  <Input
                    aria-label={`${t('approvalRules.role')} ${index + 1}.${step.stepNo}`}
                    value={step.roleCode}
                    onChange={(event) =>
                      setBand(index, {
                        ...band,
                        steps: band.steps.map((s, i) =>
                          i === stepIndex ? { ...s, roleCode: event.target.value } : s,
                        ),
                      })
                    }
                  />
                  <InputNumber
                    aria-label={`${t('approvalRules.minApprovers')} ${index + 1}.${step.stepNo}`}
                    min={1}
                    value={step.minApprovers}
                    onChange={(value) =>
                      setBand(index, {
                        ...band,
                        steps: band.steps.map((s, i) =>
                          i === stepIndex ? { ...s, minApprovers: value ?? 1 } : s,
                        ),
                      })
                    }
                  />
                  <Button
                    onClick={() =>
                      setBand(index, {
                        ...band,
                        steps: band.steps
                          .filter((_, i) => i !== stepIndex)
                          .map((s, i) => ({ ...s, stepNo: i + 1 })),
                      })
                    }
                  >
                    {t('approvalRules.removeStep')} {index + 1}.{step.stepNo}
                  </Button>
                </Space>
              ))}
              <Button
                style={{ marginTop: 8 }}
                onClick={() =>
                  setBand(index, {
                    ...band,
                    steps: [
                      ...band.steps,
                      { stepNo: band.steps.length + 1, roleCode: '', minApprovers: 1 },
                    ],
                  })
                }
              >
                {t('approvalRules.addStep')} {index + 1}
              </Button>
            </fieldset>
          ))}
          <Space>
            <Button
              onClick={() =>
                change({
                  ...draft,
                  bands: [...draft.bands, blankBand(draft.bands.at(-1)?.maxAmount ?? '0')],
                })
              }
            >
              {t('approvalRules.addBand')}
            </Button>
            <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('approvalRules.save')}
            </Button>
          </Space>
          {save.isError && <Alert type="error" message={failure(save.error)} />}
          {saved && <Alert type="success" message={t('approvalRules.saved')} />}
        </Space>
      )}
    </div>
  );
}

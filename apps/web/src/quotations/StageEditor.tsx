import { stageBases, type StageBasis } from '@emporium/shared';
import { formatAmount } from '@emporium/shared';
import { Alert, Button, Input, Select, Space, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import type { Stage } from './api';

export interface StageEditorProps {
  stages: Stage[];
  onChange: (stages: Stage[]) => void;
  disabled?: boolean;
  /** Shown under the table: a message from the API about the schedule. */
  error?: string | null;
}

const blankStage = (basis: StageBasis): Stage => ({
  name: '',
  basis,
  percent: '',
  amount: '',
  conditionText: null,
});

/** The first problem the screen can see without any arithmetic; the API checks the sums (BR-3). */
export function stageProblem(stages: readonly Stage[]): 'nameRequired' | 'valueRequired' | null {
  if (stages.some((stage) => stage.name.trim() === '')) return 'nameRequired';
  const missing = (stage: Stage) =>
    (stage.basis === 'percent' ? stage.percent : stage.amount).trim() === '';
  return stages.some(missing) ? 'valueRequired' : null;
}

/**
 * The payment-stage schedule of a quotation. The editor only collects text; the amounts shown beside
 * the percents are the ones the API calculated when the quotation was last saved.
 */
export function StageEditor({
  stages,
  onChange,
  disabled = false,
  error = null,
}: StageEditorProps) {
  const { t } = useTranslation();
  const basis: StageBasis = stages[0]?.basis ?? 'percent';
  const patch = (index: number, change: Partial<Stage>) =>
    onChange(stages.map((stage, i) => (i === index ? { ...stage, ...change } : stage)));
  const problem = stageProblem(stages);

  return (
    <div aria-label={t('quotations.stages.title')}>
      <Space style={{ marginBottom: 8 }}>
        <Select
          aria-label={t('quotations.stages.basis')}
          style={{ width: 200 }}
          disabled={disabled}
          value={basis}
          onChange={(value: StageBasis) =>
            onChange(stages.map((stage) => ({ ...stage, basis: value })))
          }
          options={stageBases.map((value) => ({
            value,
            label: t(
              value === 'percent'
                ? 'quotations.stages.basisPercent'
                : 'quotations.stages.basisAmount',
            ),
          }))}
        />
        {!disabled && (
          <Button onClick={() => onChange([...stages, blankStage(basis)])}>
            {t('quotations.stages.add')}
          </Button>
        )}
      </Space>
      {problem !== null && !disabled && (
        <Alert
          type="warning"
          style={{ marginBottom: 8 }}
          message={t(`quotations.stages.${problem}`)}
        />
      )}
      {error !== null && <Alert type="error" style={{ marginBottom: 8 }} message={error} />}
      <Table<Stage>
        rowKey={(_, index) => String(index)}
        size="small"
        pagination={false}
        dataSource={stages}
        columns={[
          {
            title: t('quotations.stages.name'),
            render: (_, stage, index) => (
              <Input
                aria-label={`${t('quotations.stages.name')} ${index + 1}`}
                disabled={disabled}
                value={stage.name}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            ),
          },
          {
            title: t(
              basis === 'percent' ? 'quotations.stages.percent' : 'quotations.stages.amount',
            ),
            render: (_, stage, index) => (
              <Input
                aria-label={`${t(basis === 'percent' ? 'quotations.stages.percent' : 'quotations.stages.amount')} ${index + 1}`}
                inputMode="decimal"
                disabled={disabled}
                value={basis === 'percent' ? stage.percent : stage.amount}
                onChange={(event) =>
                  patch(
                    index,
                    basis === 'percent'
                      ? { percent: event.target.value }
                      : { amount: event.target.value },
                  )
                }
              />
            ),
          },
          {
            title: t('quotations.stages.calculated'),
            align: 'right',
            render: (_, stage) =>
              stage.stageNo === undefined || stage.amount === '' ? '' : formatAmount(stage.amount),
          },
          {
            title: t('quotations.stages.condition'),
            render: (_, stage, index) => (
              <Input
                aria-label={`${t('quotations.stages.condition')} ${index + 1}`}
                disabled={disabled}
                value={stage.conditionText ?? ''}
                onChange={(event) => patch(index, { conditionText: event.target.value })}
              />
            ),
          },
          {
            title: '',
            render: (_, __, index) =>
              disabled ? null : (
                <Button
                  size="small"
                  danger
                  aria-label={`${t('quotations.stages.remove')} ${index + 1}`}
                  onClick={() => onChange(stages.filter((_stage, i) => i !== index))}
                >
                  {t('quotations.stages.remove')}
                </Button>
              ),
          },
        ]}
      />
    </div>
  );
}

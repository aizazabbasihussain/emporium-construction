import { formatAmount } from '@emporium/shared';
import { Alert, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BudgetLine, BudgetLineInput } from './api';

export interface BudgetEditorProps {
  lines: BudgetLine[];
  costCodeOptions: { value: string; label: string }[];
  canEdit: boolean;
  saving?: boolean;
  /** A message from the API about the last save. */
  error?: string | null;
  onSave: (lines: BudgetLineInput[]) => void;
}

/** The first thing missing in the editable rows; the API checks everything else. */
export function budgetProblem(rows: readonly BudgetLineInput[]): 'incomplete' | null {
  const missing = (row: BudgetLineInput) => row.costCodeId === '' || row.budgetAmount.trim() === '';
  return rows.some(missing) ? 'incomplete' : null;
}

/**
 * The budget of a project. Lines added by variations are listed but cannot be changed here; the
 * editable rows go to the API as a whole, which keeps the amounts as text.
 */
export function BudgetEditor({
  lines,
  costCodeOptions,
  canEdit,
  saving = false,
  error = null,
  onSave,
}: BudgetEditorProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<BudgetLineInput[]>(() =>
    lines
      .filter((line) => line.source !== 'variation')
      .map(({ costCodeId, description, budgetAmount }) => ({
        costCodeId,
        description,
        budgetAmount,
      })),
  );
  const [problem, setProblem] = useState<'incomplete' | null>(null);
  const variations = lines.filter((line) => line.source === 'variation');
  const labelOf = (id: string) => costCodeOptions.find((o) => o.value === id)?.label ?? id;
  const patch = (index: number, change: Partial<BudgetLineInput>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));

  return (
    <div aria-label={t('projects.budget.title')}>
      {(problem ?? error) !== null && (
        <Alert
          type="error"
          style={{ marginBottom: 12 }}
          message={problem === null ? error : t(`projects.budget.${problem}`)}
        />
      )}
      <Table<BudgetLineInput>
        rowKey={(_, index) => String(index)}
        pagination={false}
        dataSource={rows}
        columns={[
          {
            title: t('projects.budget.costCode'),
            render: (_, row, index) => (
              <Select
                aria-label={`${t('projects.budget.costCode')} ${index + 1}`}
                style={{ width: 240 }}
                disabled={!canEdit}
                value={row.costCodeId === '' ? undefined : row.costCodeId}
                options={costCodeOptions}
                onChange={(value: string) => patch(index, { costCodeId: value })}
              />
            ),
          },
          {
            title: t('projects.budget.description'),
            render: (_, row, index) => (
              <Input
                aria-label={`${t('projects.budget.description')} ${index + 1}`}
                disabled={!canEdit}
                value={row.description}
                onChange={(event) => patch(index, { description: event.target.value })}
              />
            ),
          },
          {
            title: t('projects.budget.amount'),
            render: (_, row, index) => (
              <Input
                aria-label={`${t('projects.budget.amount')} ${index + 1}`}
                inputMode="decimal"
                disabled={!canEdit}
                value={row.budgetAmount}
                onChange={(event) => patch(index, { budgetAmount: event.target.value })}
              />
            ),
          },
          {
            title: '',
            render: (_, __, index) =>
              canEdit && (
                <Button
                  aria-label={`${t('projects.budget.remove')} ${index + 1}`}
                  onClick={() => setRows(rows.filter((_row, i) => i !== index))}
                >
                  {t('projects.budget.remove')}
                </Button>
              ),
          },
        ]}
      />
      {canEdit && (
        <Space style={{ marginTop: 12 }}>
          <Button
            onClick={() =>
              setRows([...rows, { costCodeId: '', description: '', budgetAmount: '' }])
            }
          >
            {t('projects.budget.add')}
          </Button>
          <Button
            type="primary"
            loading={saving}
            onClick={() => {
              const found = budgetProblem(rows);
              setProblem(found);
              if (found === null) onSave(rows);
            }}
          >
            {t('projects.budget.save')}
          </Button>
        </Space>
      )}
      {variations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Typography.Text type="secondary">{t('projects.budget.variationNote')}</Typography.Text>
          <ul>
            {variations.map((line) => (
              <li key={line.id}>
                {labelOf(line.costCodeId)} {line.description} {formatAmount(line.budgetAmount)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

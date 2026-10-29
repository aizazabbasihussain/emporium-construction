import { formatAmount } from '@emporium/shared';
import { Button, Input, Select, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { Category, ClaimLine } from './api';

export interface Option {
  value: string;
  label: string;
}

/** A line as the form holds it: the cost object is one choice, `overhead` or a project id. */
export interface LineDraft {
  expenseDate: string;
  category: string;
  description: string;
  costObject: string;
  costCodeId: string;
  amount: string;
  receiptFileId: string;
}

export const OVERHEAD = 'overhead';

export const emptyLine = (today: string): LineDraft => ({
  expenseDate: today,
  category: '',
  description: '',
  costObject: OVERHEAD,
  costCodeId: '',
  amount: '',
  receiptFileId: '',
});

export const draftOf = (line: ClaimLine): LineDraft => ({
  expenseDate: line.expenseDate,
  category: line.category,
  description: line.description,
  costObject: line.costObjectType === 'project' ? (line.costObjectId as string) : OVERHEAD,
  costCodeId: line.costCodeId,
  amount: line.amount,
  receiptFileId: line.receiptFileId ?? '',
});

export const lineOf = (draft: LineDraft): ClaimLine => ({
  expenseDate: draft.expenseDate,
  category: draft.category,
  description: draft.description.trim(),
  costObjectType: draft.costObject === OVERHEAD ? 'overhead' : 'project',
  costObjectId: draft.costObject === OVERHEAD ? null : draft.costObject,
  costCodeId: draft.costCodeId,
  amount: draft.amount.trim(),
  receiptFileId: draft.receiptFileId === '' ? null : draft.receiptFileId,
});

/** The first thing missing in the lines; the API checks everything else (BR-2). */
export function linesProblem(lines: readonly LineDraft[]): 'none' | 'incomplete' | null {
  if (lines.length === 0) return 'none';
  const missing = (line: LineDraft) =>
    line.expenseDate === '' ||
    line.category === '' ||
    line.description.trim() === '' ||
    line.costCodeId === '' ||
    !/^\d+(\.\d{1,2})?$/.test(line.amount.trim());
  return lines.some(missing) ? 'incomplete' : null;
}

export interface ClaimLinesGridProps {
  lines: LineDraft[];
  categories: Category[];
  costCodeOptions: Option[];
  projectOptions: Option[];
  /** Receipts already attached to the saved claim; empty for a new claim. */
  receiptOptions: Option[];
  readOnly?: boolean;
  onChange: (lines: LineDraft[]) => void;
}

/** The lines of an expense claim: one row per receipt or spend, easy to fill on a phone. */
export function ClaimLinesGrid({
  lines,
  categories,
  costCodeOptions,
  projectOptions,
  receiptOptions,
  readOnly = false,
  onChange,
}: ClaimLinesGridProps) {
  const { t } = useTranslation();
  const today = new Date().toISOString().slice(0, 10);
  const patch = (index: number, change: Partial<LineDraft>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const categoryOptions = categories.map((c) => ({ value: c.code, label: c.name }));
  const nameOf = (options: Option[], id: string) =>
    options.find((o) => o.value === id)?.label ?? id;
  const costObjectOptions = [
    { value: OVERHEAD, label: t('expenses.lines.overhead') },
    ...projectOptions,
  ];
  const noReceipt = { value: '', label: t('expenses.lines.noReceipt') };

  const pickCategory = (index: number, code: string) => {
    const category = categories.find((c) => c.code === code);
    const line = lines[index] as LineDraft;
    // The category's default cost code is only a suggestion for a line that has none yet.
    patch(index, {
      category: code,
      costCodeId:
        line.costCodeId === '' && category?.defaultCostCodeId
          ? category.defaultCostCodeId
          : line.costCodeId,
    });
  };

  return (
    <div>
      <Table<LineDraft>
        rowKey={(_, index) => String(index)}
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('expenses.lines.empty') }}
        dataSource={lines}
        columns={[
          {
            title: t('expenses.lines.date'),
            render: (_, line, index) =>
              readOnly ? (
                line.expenseDate
              ) : (
                <Input
                  type="date"
                  aria-label={`${t('expenses.lines.date')} ${index + 1}`}
                  value={line.expenseDate}
                  onChange={(event) => patch(index, { expenseDate: event.target.value })}
                />
              ),
          },
          {
            title: t('expenses.lines.category'),
            render: (_, line, index) =>
              readOnly ? (
                nameOf(categoryOptions, line.category)
              ) : (
                <div>
                  <Select
                    aria-label={`${t('expenses.lines.category')} ${index + 1}`}
                    style={{ width: 160 }}
                    value={line.category === '' ? undefined : line.category}
                    options={categoryOptions}
                    onChange={(value: string) => pickCategory(index, value)}
                  />
                  {categories.find((c) => c.code === line.category)?.receiptRequired === true && (
                    <Typography.Text type="secondary" style={{ display: 'block' }}>
                      {t('expenses.lines.receiptHint', {
                        limit: formatAmount(
                          categories.find((c) => c.code === line.category)?.maxWithoutReceipt ??
                            '0',
                        ),
                        category: nameOf(categoryOptions, line.category),
                      })}
                    </Typography.Text>
                  )}
                </div>
              ),
          },
          {
            title: t('expenses.lines.description'),
            render: (_, line, index) =>
              readOnly ? (
                line.description
              ) : (
                <Input
                  aria-label={`${t('expenses.lines.description')} ${index + 1}`}
                  value={line.description}
                  onChange={(event) => patch(index, { description: event.target.value })}
                />
              ),
          },
          {
            title: t('expenses.lines.costObject'),
            render: (_, line, index) =>
              readOnly ? (
                nameOf(costObjectOptions, line.costObject)
              ) : (
                <Select
                  aria-label={`${t('expenses.lines.costObject')} ${index + 1}`}
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                  value={line.costObject}
                  options={costObjectOptions}
                  onChange={(value: string) => patch(index, { costObject: value })}
                />
              ),
          },
          {
            title: t('expenses.lines.costCode'),
            render: (_, line, index) =>
              readOnly ? (
                nameOf(costCodeOptions, line.costCodeId)
              ) : (
                <Select
                  aria-label={`${t('expenses.lines.costCode')} ${index + 1}`}
                  style={{ width: 180 }}
                  showSearch
                  optionFilterProp="label"
                  value={line.costCodeId === '' ? undefined : line.costCodeId}
                  options={costCodeOptions}
                  onChange={(value: string) => patch(index, { costCodeId: value })}
                />
              ),
          },
          {
            title: t('expenses.lines.amount'),
            align: 'right',
            render: (_, line, index) =>
              readOnly ? (
                formatAmount(line.amount)
              ) : (
                <Input
                  aria-label={`${t('expenses.lines.amount')} ${index + 1}`}
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(event) => patch(index, { amount: event.target.value })}
                />
              ),
          },
          {
            title: t('expenses.lines.receipt'),
            render: (_, line, index) =>
              readOnly ? (
                nameOf([noReceipt, ...receiptOptions], line.receiptFileId)
              ) : (
                <Select
                  aria-label={`${t('expenses.lines.receipt')} ${index + 1}`}
                  style={{ width: 160 }}
                  value={line.receiptFileId}
                  options={[noReceipt, ...receiptOptions]}
                  onChange={(value: string) => patch(index, { receiptFileId: value })}
                />
              ),
          },
          ...(readOnly
            ? []
            : [
                {
                  title: '',
                  render: (_: unknown, __: LineDraft, index: number) => (
                    <Button
                      size="small"
                      aria-label={`${t('expenses.lines.remove')} ${index + 1}`}
                      onClick={() => onChange(lines.filter((_line, i) => i !== index))}
                    >
                      {t('expenses.lines.remove')}
                    </Button>
                  ),
                },
              ]),
        ]}
      />
      {!readOnly && (
        <Button style={{ marginTop: 8 }} onClick={() => onChange([...lines, emptyLine(today)])}>
          {t('expenses.lines.add')}
        </Button>
      )}
    </div>
  );
}

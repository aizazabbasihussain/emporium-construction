import { Button, Input, Select, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import type { LineDraft } from './api';

export interface Option {
  value: string;
  label: string;
}

export interface LinesEditorProps {
  lines: LineDraft[];
  itemOptions: Option[];
  costCodeOptions: Option[];
  /** Label of the money column: the estimate on a requisition, the rate on an order. */
  rateLabel: string;
  readOnly?: boolean;
  onChange: (lines: LineDraft[]) => void;
}

export const emptyLine = (): LineDraft => ({ itemId: '', quantity: '', rate: '', costCodeId: '' });

/** The first thing missing in the lines; the API checks everything else (BR-3, BR-10). */
export function linesProblem(
  lines: readonly LineDraft[],
  rateRequired: boolean,
): 'none' | 'incomplete' | null {
  if (lines.length === 0) return 'none';
  const missing = (line: LineDraft) =>
    line.itemId === '' ||
    line.costCodeId === '' ||
    line.quantity.trim() === '' ||
    (rateRequired && line.rate.trim() === '');
  return lines.some(missing) ? 'incomplete' : null;
}

/** The lines of a requisition or an order: item, quantity, rate and cost code. */
export function ProcurementLinesEditor({
  lines,
  itemOptions,
  costCodeOptions,
  rateLabel,
  readOnly = false,
  onChange,
}: LinesEditorProps) {
  const { t } = useTranslation();
  const patch = (index: number, change: Partial<LineDraft>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const label = (options: Option[], id: string) => options.find((o) => o.value === id)?.label ?? id;
  return (
    <div>
      <Table<LineDraft>
        rowKey={(_, index) => String(index)}
        pagination={false}
        size="small"
        locale={{ emptyText: t('procurement.lines.empty') }}
        dataSource={lines}
        columns={[
          {
            title: t('procurement.lines.item'),
            render: (_, line, index) =>
              readOnly ? (
                label(itemOptions, line.itemId)
              ) : (
                <Select
                  aria-label={`${t('procurement.lines.item')} ${index + 1}`}
                  showSearch
                  optionFilterProp="label"
                  style={{ minWidth: 200 }}
                  value={line.itemId === '' ? undefined : line.itemId}
                  options={itemOptions}
                  onChange={(value: string) => patch(index, { itemId: value })}
                />
              ),
          },
          {
            title: t('procurement.lines.quantity'),
            render: (_, line, index) =>
              readOnly ? (
                line.quantity
              ) : (
                <Input
                  aria-label={`${t('procurement.lines.quantity')} ${index + 1}`}
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => patch(index, { quantity: event.target.value })}
                />
              ),
          },
          {
            title: rateLabel,
            render: (_, line, index) =>
              readOnly ? (
                line.rate
              ) : (
                <Input
                  aria-label={`${rateLabel} ${index + 1}`}
                  inputMode="decimal"
                  value={line.rate}
                  onChange={(event) => patch(index, { rate: event.target.value })}
                />
              ),
          },
          {
            title: t('procurement.lines.costCode'),
            render: (_, line, index) =>
              readOnly ? (
                label(costCodeOptions, line.costCodeId)
              ) : (
                <Select
                  aria-label={`${t('procurement.lines.costCode')} ${index + 1}`}
                  style={{ minWidth: 180 }}
                  value={line.costCodeId === '' ? undefined : line.costCodeId}
                  options={costCodeOptions}
                  onChange={(value: string) => patch(index, { costCodeId: value })}
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
                      aria-label={`${t('procurement.lines.remove')} ${index + 1}`}
                      onClick={() => onChange(lines.filter((_line, i) => i !== index))}
                    >
                      ×
                    </Button>
                  ),
                },
              ]),
        ]}
      />
      {readOnly ? null : (
        <Button style={{ marginTop: 8 }} onClick={() => onChange([...lines, emptyLine()])}>
          {t('procurement.lines.add')}
        </Button>
      )}
    </div>
  );
}

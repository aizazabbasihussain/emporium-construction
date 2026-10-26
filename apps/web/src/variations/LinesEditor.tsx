import { Button, Input, Select, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VariationLine } from './api';

export interface LinesEditorProps {
  lines: VariationLine[];
  costCodeOptions: { value: string; label: string }[];
  readOnly?: boolean;
  onChange: (lines: VariationLine[]) => void;
}

export const emptyLine = (): VariationLine => ({
  description: '',
  costCodeId: '',
  costAmount: '0',
  priceAmount: '0',
});

/** The first thing missing in the lines; the API checks everything else (BR-2). */
export function linesProblem(lines: readonly VariationLine[]): 'none' | 'incomplete' | null {
  if (lines.length === 0) return 'none';
  const missing = (line: VariationLine) =>
    line.description.trim() === '' ||
    line.costCodeId === '' ||
    line.costAmount.trim() === '' ||
    line.priceAmount.trim() === '';
  return lines.some(missing) ? 'incomplete' : null;
}

/** The lines of a variation: what the extra work costs and what the client is charged (may be negative). */
export function LinesEditor({
  lines,
  costCodeOptions,
  readOnly = false,
  onChange,
}: LinesEditorProps) {
  const { t } = useTranslation();
  const patch = (index: number, change: Partial<VariationLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const label = (id: string) => costCodeOptions.find((o) => o.value === id)?.label ?? id;
  return (
    <div>
      <Table<VariationLine>
        rowKey={(_, index) => String(index)}
        pagination={false}
        size="small"
        locale={{ emptyText: t('variations.lines.empty') }}
        dataSource={lines}
        columns={[
          {
            title: t('variations.lines.description'),
            render: (_, line, index) =>
              readOnly ? (
                line.description
              ) : (
                <Input
                  aria-label={`${t('variations.lines.description')} ${index + 1}`}
                  value={line.description}
                  onChange={(event) => patch(index, { description: event.target.value })}
                />
              ),
          },
          {
            title: t('variations.lines.costCode'),
            render: (_, line, index) =>
              readOnly ? (
                label(line.costCodeId)
              ) : (
                <Select
                  aria-label={`${t('variations.lines.costCode')} ${index + 1}`}
                  style={{ width: 200 }}
                  showSearch
                  optionFilterProp="label"
                  value={line.costCodeId === '' ? undefined : line.costCodeId}
                  options={costCodeOptions}
                  onChange={(value: string) => patch(index, { costCodeId: value })}
                />
              ),
          },
          {
            title: t('variations.lines.cost'),
            align: 'right',
            render: (_, line, index) =>
              readOnly ? (
                line.costAmount
              ) : (
                <Input
                  aria-label={`${t('variations.lines.cost')} ${index + 1}`}
                  inputMode="decimal"
                  value={line.costAmount}
                  onChange={(event) => patch(index, { costAmount: event.target.value })}
                />
              ),
          },
          {
            title: t('variations.lines.price'),
            align: 'right',
            render: (_, line, index) =>
              readOnly ? (
                line.priceAmount
              ) : (
                <Input
                  aria-label={`${t('variations.lines.price')} ${index + 1}`}
                  inputMode="decimal"
                  value={line.priceAmount}
                  onChange={(event) => patch(index, { priceAmount: event.target.value })}
                />
              ),
          },
          ...(readOnly
            ? []
            : [
                {
                  title: '',
                  render: (_: unknown, __: VariationLine, index: number) => (
                    <Button
                      size="small"
                      aria-label={`${t('variations.lines.remove')} ${index + 1}`}
                      onClick={() => onChange(lines.filter((_line, i) => i !== index))}
                    >
                      {t('variations.lines.remove')}
                    </Button>
                  ),
                },
              ]),
        ]}
      />
      {!readOnly && (
        <Button style={{ marginTop: 8 }} onClick={() => onChange([...lines, emptyLine()])}>
          {t('variations.lines.add')}
        </Button>
      )}
    </div>
  );
}

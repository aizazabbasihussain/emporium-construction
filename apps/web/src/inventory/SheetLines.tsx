import { Button, Input, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { Option } from './references';
import { DECIMAL } from './shared';

export interface SheetLine {
  itemId: string | undefined;
  quantity: string;
}

export const emptySheetLine = (): SheetLine => ({ itemId: undefined, quantity: '' });

/** The lines a transfer or a count sheet is made of: an item and a quantity each. */
export function sheetProblem(lines: SheetLine[]): string | null {
  if (lines.length === 0) return 'inventory.validation.noLines';
  for (const line of lines) {
    if (line.itemId === undefined) return 'inventory.validation.item';
    if (!DECIMAL.test(line.quantity.trim())) return 'inventory.validation.quantity';
  }
  return null;
}

export function SheetLines(props: {
  lines: SheetLine[];
  itemOptions: Option[];
  quantityLabel: string;
  onChange: (lines: SheetLine[]) => void;
}) {
  const { t } = useTranslation();
  const { lines, onChange } = props;
  const set = (index: number, change: Partial<SheetLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  return (
    <div>
      {lines.map((line, index) => (
        <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ flex: 2 }}
            aria-label={`${t('inventory.field.item')} ${index + 1}`}
            placeholder={t('inventory.field.item')}
            value={line.itemId}
            onChange={(value: string) => set(index, { itemId: value })}
            options={props.itemOptions}
          />
          <Input
            style={{ flex: 1 }}
            inputMode="decimal"
            aria-label={`${props.quantityLabel} ${index + 1}`}
            placeholder={props.quantityLabel}
            value={line.quantity}
            onChange={(event) => set(index, { quantity: event.target.value })}
          />
          <Button onClick={() => onChange(lines.filter((_, i) => i !== index))}>
            {t('inventory.lines.remove')}
          </Button>
        </div>
      ))}
      <Button onClick={() => onChange([...lines, emptySheetLine()])}>
        {t('inventory.lines.add')}
      </Button>
    </div>
  );
}

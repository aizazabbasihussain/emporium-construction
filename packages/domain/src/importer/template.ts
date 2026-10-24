import type { ColumnDef, TemplateContent } from './types.js';

const FORMAT_HINT: Record<ColumnDef['type'], string> = {
  text: 'Text',
  integer: 'Whole number',
  decimal: 'Plain decimal, no thousands separators (for example 1250.50)',
  date: 'Date as yyyy-mm-dd or dd/mm/yyyy',
  boolean: 'yes or no',
  enum: 'One of the allowed values',
};

export const NOTES_HEADER = ['Column', 'Required', 'Format', 'Allowed values', 'Notes'];

/** BR-8: the header row, one synthetic example row and the notes listing required columns and formats. */
export function buildTemplate(columns: readonly ColumnDef[]): TemplateContent {
  return {
    header: columns.map((c) => c.name),
    example: columns.map((c) => c.example),
    notes: columns.map((c) => [
      c.name,
      c.required ? 'yes' : 'no',
      FORMAT_HINT[c.type] + (c.maxLength === undefined ? '' : `, up to ${c.maxLength} characters`),
      (c.allowed ?? []).join(', '),
      c.note ?? '',
    ]),
  };
}

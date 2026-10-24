import type { CellValue, ColumnDef, DateFormats } from './types.js';

export type CleanResult = { ok: true; value: CellValue } | { ok: false; message: string };

const fail = (message: string): CleanResult => ({ ok: false, message });
const pass = (value: CellValue): CleanResult => ({ ok: true, value });

/** BR-5: trim whitespace and turn an empty string into null. Urdu and other text is kept as is. */
export function cleanText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function calendarDate(year: number, month: number, day: number): string | null {
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  const valid =
    year >= 1 &&
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return valid ? `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` : null;
}

/** `yyyy-mm-dd` and/or `dd/mm/yyyy`, as allowed; returns the ISO date or null. */
export function parseDate(text: string, formats: DateFormats): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso && formats !== 'dmy') return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (dmy && formats !== 'iso') return calendarDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

/** Unknown setting values fall back to accepting both spellings (the default). */
export const normalizeDateFormats = (value: unknown): DateFormats =>
  value === 'iso' || value === 'dmy' ? value : 'both';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const INTEGER = /^-?\d+$/;
const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

function dateMessage(formats: DateFormats): string {
  if (formats === 'iso') return 'Must be a date as yyyy-mm-dd';
  if (formats === 'dmy') return 'Must be a date as dd/mm/yyyy';
  return 'Must be a date as yyyy-mm-dd or dd/mm/yyyy';
}

/** Cleans one raw cell against its column (BR-5). The message never echoes the cell content. */
export function cleanCell(column: ColumnDef, raw: string, formats: DateFormats): CleanResult {
  const text = cleanText(raw);
  if (text === null) return column.required ? fail('A value is required') : pass(null);
  if (column.maxLength !== undefined && text.length > column.maxLength) {
    return fail(`Must be at most ${column.maxLength} characters`);
  }
  switch (column.type) {
    case 'text':
      return pass(text);
    case 'integer':
      return INTEGER.test(text)
        ? pass(Number(text))
        : fail('Must be a whole number without separators');
    case 'decimal':
      return DECIMAL.test(text)
        ? pass(text)
        : fail('Must be a plain decimal number without thousands separators');
    case 'date': {
      const date = parseDate(text, formats);
      return date === null ? fail(dateMessage(formats)) : pass(date);
    }
    case 'boolean':
      if (TRUE_WORDS.has(text.toLowerCase())) return pass(true);
      return FALSE_WORDS.has(text.toLowerCase()) ? pass(false) : fail('Must be yes or no');
    case 'enum': {
      const allowed = column.allowed ?? [];
      const match = allowed.find((value) => value.toLowerCase() === text.toLowerCase());
      return match === undefined ? fail(`Must be one of: ${allowed.join(', ')}`) : pass(match);
    }
  }
}

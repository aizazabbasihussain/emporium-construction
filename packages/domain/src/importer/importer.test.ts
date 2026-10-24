import { describe, expect, it } from 'vitest';
import { ValidationError } from '../errors.js';
import {
  MAX_DATA_ROWS,
  MAX_FILE_BYTES,
  assertWithinLimits,
  buildTemplate,
  cleanCell,
  cleanText,
  formatCsv,
  formatOfFileName,
  normalizeDateFormats,
  parseCsv,
  parseDate,
  validateTable,
  type ColumnDef,
} from './index.js';

const col = (over: Partial<ColumnDef> & Pick<ColumnDef, 'type'>): ColumnDef => ({
  name: 'c',
  required: false,
  example: '',
  ...over,
});

describe('parseCsv (T-1)', () => {
  it('tolerates a byte-order mark and CRLF', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted commas, quotes, newlines and Urdu text', () => {
    expect(parseCsv('name,note\n"Khan, Ali","say ""hi""\nthere"\nعلی,ٹھیک')).toEqual([
      ['name', 'note'],
      ['Khan, Ali', 'say "hi"\nthere'],
      ['علی', 'ٹھیک'],
    ]);
  });

  it('keeps empty cells, lone CR line ends and a trailing empty cell', () => {
    expect(parseCsv('a,,c\rx,\ny,""')).toEqual([
      ['a', '', 'c'],
      ['x', ''],
      ['y', ''],
    ]);
  });

  it('treats a quote inside an unquoted cell literally', () => {
    expect(parseCsv('ab"c,d')).toEqual([['ab"c', 'd']]);
  });

  it('returns no rows for empty input and rejects an unterminated quote', () => {
    expect(parseCsv('')).toEqual([]);
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });

  it('round-trips through formatCsv', () => {
    const rows = [
      ['a', 'b,c', 'd"e', 'f\ng'],
      ['', 'علی', ' x ', '1'],
    ];
    expect(parseCsv(formatCsv(rows))).toEqual(rows);
  });
});

describe('limits (BR-1, T-1)', () => {
  it('chooses the format by extension', () => {
    expect(formatOfFileName('Clients.CSV')).toBe('csv');
    expect(formatOfFileName(' data.xlsx ')).toBe('xlsx');
    expect(() => formatOfFileName('data.xls')).toThrow(/Only .csv/);
    expect(() => formatOfFileName('data')).toThrow(/Only .csv/);
  });

  it('rejects files over 10 MB and over 50,000 rows', () => {
    expect(() => assertWithinLimits(MAX_FILE_BYTES, MAX_DATA_ROWS)).not.toThrow();
    expect(() => assertWithinLimits(MAX_FILE_BYTES, null)).not.toThrow();
    expect(() => assertWithinLimits(MAX_FILE_BYTES + 1, null)).toThrow(/10 MB/);
    expect(() => assertWithinLimits(10, MAX_DATA_ROWS + 1)).toThrow(/50,000/);
    try {
      assertWithinLimits(10, MAX_DATA_ROWS + 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
    }
  });
});

describe('cell cleaning (BR-5, T-2)', () => {
  it('trims whitespace, maps empty to null and keeps Urdu', () => {
    expect(cleanText('  علی  ')).toBe('علی');
    expect(cleanText('   ')).toBeNull();
    expect(cleanCell(col({ type: 'text' }), ' x ', 'both')).toEqual({ ok: true, value: 'x' });
    expect(cleanCell(col({ type: 'text' }), '', 'both')).toEqual({ ok: true, value: null });
    expect(cleanCell(col({ type: 'text', required: true }), ' ', 'both')).toEqual({
      ok: false,
      message: 'A value is required',
    });
  });

  it('enforces the maximum length', () => {
    const column = col({ type: 'text', maxLength: 3 });
    expect(cleanCell(column, 'abc', 'both').ok).toBe(true);
    expect(cleanCell(column, 'abcd', 'both')).toEqual({
      ok: false,
      message: 'Must be at most 3 characters',
    });
  });

  it('accepts plain decimals and rejects separators and junk', () => {
    const column = col({ type: 'decimal' });
    expect(cleanCell(column, '1250.50', 'both')).toEqual({ ok: true, value: '1250.50' });
    expect(cleanCell(column, '-3', 'both')).toEqual({ ok: true, value: '-3' });
    for (const bad of ['1,250.50', '1 250', '1e3', '.5', '5.', 'Rs 5', '--1']) {
      expect(cleanCell(column, bad, 'both').ok).toBe(false);
    }
  });

  it('accepts integers and rejects fractions', () => {
    const column = col({ type: 'integer' });
    expect(cleanCell(column, '42', 'both')).toEqual({ ok: true, value: 42 });
    expect(cleanCell(column, '4.2', 'both').ok).toBe(false);
    expect(cleanCell(column, '1,000', 'both').ok).toBe(false);
  });

  it('accepts ISO and dd/mm/yyyy dates by setting, and rejects impossible dates', () => {
    expect(parseDate('2026-02-28', 'both')).toBe('2026-02-28');
    expect(parseDate('28/02/2026', 'both')).toBe('2026-02-28');
    expect(parseDate('29/02/2024', 'dmy')).toBe('2024-02-29');
    expect(parseDate('28/02/2026', 'iso')).toBeNull();
    expect(parseDate('2026-02-28', 'dmy')).toBeNull();
    expect(parseDate('2026-02-30', 'both')).toBeNull();
    expect(parseDate('29/02/2025', 'both')).toBeNull();
    expect(parseDate('31/04/2026', 'both')).toBeNull();
    expect(parseDate('2026-13-01', 'both')).toBeNull();
    expect(parseDate('0000-01-01', 'both')).toBeNull();
    expect(parseDate('1/2/2026', 'both')).toBeNull();
    const column = col({ type: 'date' });
    expect(cleanCell(column, '05/03/2026', 'both')).toEqual({ ok: true, value: '2026-03-05' });
    expect(cleanCell(column, 'x', 'iso')).toEqual({
      ok: false,
      message: 'Must be a date as yyyy-mm-dd',
    });
    expect(cleanCell(column, 'x', 'dmy')).toEqual({
      ok: false,
      message: 'Must be a date as dd/mm/yyyy',
    });
    expect(cleanCell(column, 'x', 'both')).toEqual({
      ok: false,
      message: 'Must be a date as yyyy-mm-dd or dd/mm/yyyy',
    });
  });

  it('normalizes the date format setting', () => {
    expect(normalizeDateFormats('iso')).toBe('iso');
    expect(normalizeDateFormats('dmy')).toBe('dmy');
    expect(normalizeDateFormats('both')).toBe('both');
    expect(normalizeDateFormats('whatever')).toBe('both');
    expect(normalizeDateFormats(undefined)).toBe('both');
  });

  it('reads booleans', () => {
    const column = col({ type: 'boolean' });
    expect(cleanCell(column, 'Yes', 'both')).toEqual({ ok: true, value: true });
    expect(cleanCell(column, '0', 'both')).toEqual({ ok: true, value: false });
    expect(cleanCell(column, 'maybe', 'both').ok).toBe(false);
  });

  it('matches enum values ignoring case and lists the allowed ones on failure', () => {
    const column = col({ type: 'enum', allowed: ['private', 'government'] });
    expect(cleanCell(column, 'PRIVATE', 'both')).toEqual({ ok: true, value: 'private' });
    expect(cleanCell(column, 'other', 'both')).toEqual({
      ok: false,
      message: 'Must be one of: private, government',
    });
    expect(cleanCell(col({ type: 'enum' }), 'x', 'both')).toEqual({
      ok: false,
      message: 'Must be one of: ',
    });
  });
});

describe('validateTable (BR-6, T-3)', () => {
  const columns: ColumnDef[] = [
    col({ name: 'Name', type: 'text', required: true }),
    col({ name: 'Amount', type: 'decimal', required: true }),
    col({ name: 'Since', type: 'date' }),
  ];

  it('collects every error across rows, with spreadsheet row numbers', () => {
    const result = validateTable(
      columns,
      [
        ['name', ' Amount ', 'Since'],
        ['A', '10', '2026-01-01'],
        ['', '10', ''],
        ['B', '1,000', ''],
        ['', '', 'nope'],
        ['', '', ''],
        ['E', '5'],
      ],
      'both',
    );
    expect(result.errors.map((e) => [e.rowNo, e.column])).toEqual([
      [3, 'Name'],
      [4, 'Amount'],
      [5, 'Name'],
      [5, 'Amount'],
      [5, 'Since'],
    ]);
    expect(result.records.map((r) => r.rowNo)).toEqual([2, 3, 4, 5, 7]);
    expect(result.records[0]?.record).toEqual({ Name: 'A', Amount: '10', Since: '2026-01-01' });
    expect(result.records[4]?.record).toEqual({ Name: 'E', Amount: '5', Since: null });
  });

  it('accepts columns in any order and an optional column left out', () => {
    const result = validateTable(
      columns,
      [
        ['Amount', 'Name'],
        ['7', 'Z'],
      ],
      'both',
    );
    expect(result.errors).toEqual([]);
    expect(result.records[0]?.record).toEqual({ Name: 'Z', Amount: '7', Since: null });
  });

  it('reports header faults on row 1 and stops', () => {
    const result = validateTable(columns, [['Name', 'Name', 'Extra', '', 'Since'], ['A']], 'both');
    expect(result.records).toEqual([]);
    expect(result.errors).toEqual([
      { rowNo: 1, column: 'Name', message: 'Duplicate column' },
      { rowNo: 1, column: 'Extra', message: 'Unknown column' },
      { rowNo: 1, column: 'Amount', message: 'Required column is missing' },
    ]);
  });

  it('treats an empty file as missing its required columns', () => {
    const result = validateTable(columns, [], 'both');
    expect(result.errors.map((e) => e.column)).toEqual(['Name', 'Amount']);
  });
});

describe('buildTemplate (BR-8, T-6)', () => {
  const columns: ColumnDef[] = [
    col({ name: 'Code', type: 'text', required: true, example: 'C-1', maxLength: 20 }),
    col({ name: 'Kind', type: 'enum', example: 'private', allowed: ['private', 'government'] }),
    col({ name: 'Note', type: 'text', example: 'x', note: 'Free text' }),
  ];

  it('lists header, one example row and notes in column order', () => {
    const t = buildTemplate(columns);
    expect(t.header).toEqual(['Code', 'Kind', 'Note']);
    expect(t.example).toEqual(['C-1', 'private', 'x']);
    expect(t.notes).toEqual([
      ['Code', 'yes', 'Text, up to 20 characters', '', ''],
      ['Kind', 'no', 'One of the allowed values', 'private, government', ''],
      ['Note', 'no', 'Text', '', 'Free text'],
    ]);
  });

  it('produces an example row that validates', () => {
    const t = buildTemplate(columns);
    expect(validateTable(columns, [t.header, t.example], 'both').errors).toEqual([]);
  });
});

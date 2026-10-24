import { describe, expect, it } from 'vitest';
import {
  FILE_PURGE_AFTER_DAYS,
  MAX_FILE_BYTES,
  assertAcceptableContent,
  assertEntityType,
  assertSafeFileName,
  isEntityType,
  retentionCutoff,
  sniffContentType,
} from './rules.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => Uint8Array.from([...value].map((ch) => ch.charCodeAt(0)));
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const PDF = text('%PDF-1.7\n%...');
const XLSX = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...text('....[Content_Types].xml')]);
const XLSX_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('sniffContentType (T-1)', () => {
  it('recognises each allowed kind by its signature', () => {
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(XLSX)).toBe(XLSX_SHEET);
    expect(sniffContentType(Uint8Array.from([0x50, 0x4b, 3, 4, ...text('xl/workbook.xml')]))).toBe(
      XLSX_SHEET,
    );
    expect(sniffContentType(text('name,qty\r\ncement,10\n\tx'))).toBe('text/csv');
  });

  it('rejects a zip that is not a workbook and truncated signatures', () => {
    expect(sniffContentType(Uint8Array.from([0x50, 0x4b, 3, 4, ...text('word/document')]))).toBe(
      null,
    );
    expect(sniffContentType(bytes(0x50, 0x4b, 3))).toBe(null);
    expect(sniffContentType(bytes(0xff, 0xd8))).toBe(null);
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47))).toBe(null);
  });

  it('rejects a renamed executable and other binary content', () => {
    expect(sniffContentType(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00))).toBe(null);
    expect(sniffContentType(bytes(0x41, 0x7f, 0x42))).toBe(null);
  });

  it('accepts well-formed multi-byte UTF-8 in text files', () => {
    expect(sniffContentType(bytes(0x61, 0xc3, 0xa9))).toBe('text/csv'); // e acute
    expect(sniffContentType(bytes(0xe2, 0x82, 0xa8))).toBe('text/csv'); // three bytes
    expect(sniffContentType(bytes(0xf0, 0x9f, 0x98, 0x80))).toBe('text/csv'); // four bytes
  });

  it.each([
    ['a stray continuation byte', [0x80]],
    ['an overlong two byte form', [0xc0, 0x80]],
    ['a lead byte 0xc1', [0xc1, 0xbf]],
    ['an overlong three byte form', [0xe0, 0x80, 0x80]],
    ['a surrogate', [0xed, 0xa0, 0x80]],
    ['a value above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
    ['a lead byte 0xf5', [0xf5, 0x80, 0x80, 0x80]],
    ['a truncated sequence at the end', [0x61, 0xe2, 0x82]],
    ['a bad continuation byte', [0xc3, 0x28]],
  ])('rejects %s as text', (_name, values) => {
    expect(sniffContentType(Uint8Array.from(values))).toBe(null);
  });

  it('rejects empty and non UTF-8 text', () => {
    expect(sniffContentType(new Uint8Array())).toBe(null);
    expect(sniffContentType(bytes(0x61, 0xc3, 0x28))).toBe(null);
  });
});

describe('assertAcceptableContent', () => {
  it('returns the sniffed type', () => {
    expect(assertAcceptableContent(PNG)).toBe('image/png');
  });

  it('accepts a file of exactly the maximum size and rejects one byte more', () => {
    const exact = new Uint8Array(MAX_FILE_BYTES);
    exact.set(JPEG);
    expect(assertAcceptableContent(exact)).toBe('image/jpeg');
    const over = new Uint8Array(MAX_FILE_BYTES + 1);
    over.set(JPEG);
    expect(() => assertAcceptableContent(over)).toThrow(/10 MB/);
  });

  it('rejects empty files and unknown types with distinct codes', () => {
    expect(() => assertAcceptableContent(new Uint8Array())).toThrow(
      expect.objectContaining({ code: 'file_empty' }),
    );
    expect(() => assertAcceptableContent(bytes(0x4d, 0x5a, 0, 1))).toThrow(
      expect.objectContaining({ code: 'file_type_not_allowed' }),
    );
  });
});

describe('assertSafeFileName (T-2)', () => {
  it('keeps an ordinary name, trimmed', () => {
    expect(assertSafeFileName('  site photo 1.jpg ')).toBe('site photo 1.jpg');
  });

  it.each([
    '',
    '   ',
    '../etc/passwd',
    'a/b.jpg',
    'a\\b.jpg',
    'a..b.jpg',
    'a\u0000.jpg',
    'x\u007f.jpg',
  ])('rejects %j', (name) => {
    expect(() => assertSafeFileName(name)).toThrow(
      expect.objectContaining({ code: 'file_name_invalid' }),
    );
  });

  it('rejects names longer than 255 characters', () => {
    expect(assertSafeFileName('a'.repeat(255))).toHaveLength(255);
    expect(() => assertSafeFileName('a'.repeat(256))).toThrow(/not allowed/);
  });
});

describe('entity types and retention', () => {
  it('accepts identifiers only', () => {
    expect(isEntityType('daily_report')).toBe(true);
    expect(isEntityType('Daily')).toBe(false);
    expect(isEntityType('a/b')).toBe(false);
    expect(assertEntityType('project')).toBe('project');
    expect(() => assertEntityType('../x')).toThrow(
      expect.objectContaining({ code: 'entity_type_invalid' }),
    );
  });

  it('computes the purge cutoff', () => {
    const now = new Date('2026-10-25T00:00:00Z');
    expect(retentionCutoff(now, FILE_PURGE_AFTER_DAYS).toISOString()).toBe(
      '2026-09-25T00:00:00.000Z',
    );
  });
});

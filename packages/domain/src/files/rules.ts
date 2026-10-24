import { ValidationError } from '../errors.js';

/** BR-1: the file kinds the system accepts, named by their content type. */
export const allowedContentTypes = [
  'image/jpeg',
  'image/png',
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export type AllowedContentType = (typeof allowedContentTypes)[number];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** BR-4: signed URLs live for five minutes. */
export const SIGNED_URL_TTL_SECONDS = 300;
/** BR-5: a removed file's object is kept this long before the purge job deletes it. */
export const FILE_PURGE_AFTER_DAYS = 30;
/** BR-7: notifications older than this are purged. */
export const NOTIFICATION_RETENTION_DAYS = 90;

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

/** An OOXML workbook is a zip archive whose first entries name `[Content_Types].xml` or `xl/`. */
function isXlsx(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
  const head = String.fromCharCode(...bytes.subarray(0, 4096));
  return head.includes('[Content_Types].xml') || head.includes('xl/');
}

/** Strict UTF-8: well-formed sequences only, no overlong forms, surrogates or values above U+10FFFF. */
function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] as number;
    let extra: number;
    let min: number;
    if (lead < 0x80) {
      i += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      extra = 1;
      min = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      extra = 2;
      min = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      extra = 3;
      min = 0x10000;
    } else {
      return false;
    }
    if (i + extra >= bytes.length) return false;
    let code = lead & (0x3f >> extra);
    for (let k = 1; k <= extra; k += 1) {
      const next = bytes[i + k] as number;
      if ((next & 0xc0) !== 0x80) return false;
      code = (code << 6) | (next & 0x3f);
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
    i += extra + 1;
  }
  return true;
}

/** Plain UTF-8 text without control characters other than tab, line feed and carriage return. */
function isCsvText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      return false;
    }
  }
  return isValidUtf8(bytes);
}

/** BR-1: the content type is decided by the bytes, never by the file name or the declared type. */
export function sniffContentType(bytes: Uint8Array): AllowedContentType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (isXlsx(bytes)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (isCsvText(bytes)) return 'text/csv';
  return null;
}

/** BR-1: rejects empty, oversize and unrecognised content; returns the verified content type. */
export function assertAcceptableContent(bytes: Uint8Array): AllowedContentType {
  if (bytes.length === 0) throw new ValidationError('file_empty', 'The file is empty');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new ValidationError('file_too_large', 'The file is larger than 10 MB', {
      maxBytes: MAX_FILE_BYTES,
    });
  }
  const type = sniffContentType(bytes);
  if (type === null) {
    throw new ValidationError(
      'file_type_not_allowed',
      'Only JPEG, PNG, PDF, CSV and XLSX files are accepted',
    );
  }
  return type;
}

/** BR-3: the original name is metadata only, but path traversal characters are still refused. */
export function assertSafeFileName(name: string): string {
  const trimmed = name.trim();
  const unsafe = [...trimmed].some((ch) => '/\\'.includes(ch) || ch <= '\u001f' || ch === '\u007f');
  if (trimmed === '' || trimmed.length > 255 || unsafe || trimmed.includes('..')) {
    throw new ValidationError('file_name_invalid', 'The file name is not allowed');
  }
  return trimmed;
}

/** Entity types are short identifiers owned by the registering module, for example `daily_report`. */
export const isEntityType = (value: string): boolean => /^[a-z][a-z0-9_]{0,63}$/.test(value);

export function assertEntityType(value: string): string {
  if (!isEntityType(value)) {
    throw new ValidationError('entity_type_invalid', 'The entity type is not valid');
  }
  return value;
}

/** The instant `days` before `now`: rows older than this are due for purging (BR-5, BR-7). */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

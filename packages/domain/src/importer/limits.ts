import { ValidationError } from '../errors.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DATA_ROWS = 50_000;

export const importFormats = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof importFormats)[number];

/** BR-1: only CSV and XLSX, chosen by the file extension. */
export function formatOfFileName(fileName: string): ImportFormat {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const extension = match?.[1]?.toLowerCase();
  const found = importFormats.find((format) => format === extension);
  if (found === undefined) {
    throw new ValidationError('unsupported_format', 'Only .csv and .xlsx files can be imported');
  }
  return found;
}

export function assertWithinLimits(byteLength: number, dataRows: number | null): void {
  if (byteLength > MAX_FILE_BYTES) {
    throw new ValidationError('file_too_large', 'The file is larger than 10 MB');
  }
  if (dataRows !== null && dataRows > MAX_DATA_ROWS) {
    throw new ValidationError('too_many_rows', 'The file has more than 50,000 rows');
  }
}

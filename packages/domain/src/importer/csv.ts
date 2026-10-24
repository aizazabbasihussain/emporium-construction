import { ValidationError } from '../errors.js';

/** Parses CSV text (RFC 4180 quoting; a leading byte-order mark is tolerated) into rows of cells. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
    touched = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"' && !touched) {
      quoted = true;
      touched = true;
    } else if (char === ',') endCell();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (text.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else {
      cell += char;
      touched = true;
    }
  }
  if (quoted) throw new ValidationError('csv_malformed', 'The CSV file has an unterminated quote');
  if (touched || row.length > 0) endRow();
  return rows;
}

const needsQuotes = /[",\r\n]/;

const formatCell = (cell: string): string =>
  needsQuotes.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;

/** Writes rows as CSV with CRLF line ends. */
export function formatCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(formatCell).join(',')).join('\r\n') + '\r\n';
}

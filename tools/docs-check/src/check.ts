import path from 'node:path/posix';

export interface Issue {
  file: string;
  line: number;
  message: string;
}

export interface DocsInput {
  /** Markdown files under docs/discovery, keyed by posix path relative to that folder. */
  files: Readonly<Record<string, string>>;
  /** Every spec id in the spec set (for example P1-08). */
  specIds: ReadonlySet<string>;
  /** Whether a path (relative to docs/discovery, may start with ../) exists outside the files map. */
  exists: (relativePath: string) => boolean;
}

export const REQUIRED_FORMS = [
  'quotation',
  'site-report',
  'purchase-voucher',
  'goods-receipt',
  'expense-voucher',
  'labour-register',
  'attendance-sheet',
  'wage-sheet',
  'tax-invoice',
  'cheque-register',
  'stock-register',
] as const;

export const REQUIRED_WORKFLOWS = [
  'quotation-to-project',
  'procurement-to-stock',
  'site-daily-cycle',
  'attendance-to-wages',
  'billing-to-collection',
  'demolition-job',
  'paid-maintenance-job',
] as const;

export const INVENTORY_HEADER = [
  'form',
  'slug',
  'filled by',
  'when',
  'copies',
  'signatures',
  'spec',
  'status',
];
export const MAPPING_HEADER = [
  'paper field',
  'example value',
  'system field',
  'owning spec',
  'note',
];
export const WORKFLOW_HEADER = ['step', 'actor', 'document produced', 'approval', 'spec'];
export const GAPS_HEADER = ['gap', 'paper field', 'form', 'proposed owner spec', 'note'];
export const GLOSSARY_HEADER = ['english', 'urdu', 'roman urdu', 'note'];

export interface TableRow {
  line: number;
  cells: string[];
}

export interface Table {
  line: number;
  header: string[];
  rows: TableRow[];
}

/** Element at an index, or an empty string when out of range. */
export const at = (items: readonly string[], index: number): string => items[index] ?? '';

const splitRow = (text: string): string[] =>
  text
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isSeparator = (text: string): boolean =>
  /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*(:?-{3,}:?)?\s*\|?\s*$/.test(text);

/** Parse every pipe table in a markdown document. */
export function parseTables(text: string): Table[] {
  const lines = text.split(/\r?\n/);
  const tables: Table[] = [];
  let index = 0;
  while (index < lines.length) {
    const current = at(lines, index);
    const next = at(lines, index + 1);
    if (current.trimStart().startsWith('|') && isSeparator(next)) {
      const table: Table = {
        line: index + 1,
        header: splitRow(current).map((cell) => cell.toLowerCase()),
        rows: [],
      };
      index += 2;
      while (at(lines, index).trimStart().startsWith('|')) {
        table.rows.push({ line: index + 1, cells: splitRow(at(lines, index)) });
        index += 1;
      }
      tables.push(table);
    } else {
      index += 1;
    }
  }
  return tables;
}

const sameHeader = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((cell, i) => cell === b[i]);

export function specRefs(cell: string): string[] {
  return cell.match(/P\d+-\d+/g) ?? [];
}

// Real-data detectors (BR-5): a 13-digit CNIC and a Pakistani mobile number.
const CNIC = /(?<!\d)\d{5}-?\d{7}-?\d(?!\d)/;
const MOBILE = /(?<!\d)(?:\+92|0092|0)[-\s]?3\d{2}[-\s]?\d{7}(?!\d)/;

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

function checkSensitive(file: string, text: string, issues: Issue[]): void {
  text.split(/\r?\n/).forEach((line, i) => {
    if (CNIC.test(line)) {
      issues.push({
        file,
        line: i + 1,
        message: 'looks like a real CNIC number; use synthetic values',
      });
    }
    if (MOBILE.test(line)) {
      issues.push({
        file,
        line: i + 1,
        message: 'looks like a real mobile number; use synthetic values',
      });
    }
  });
}

function checkLinks(file: string, text: string, input: DocsInput, issues: Issue[]): void {
  text.split(/\r?\n/).forEach((line, i) => {
    for (const match of line.matchAll(LINK)) {
      const target = at(at(match, 1).split('#'), 0);
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.normalize(path.join(path.dirname(file), target));
      const found = resolved.startsWith('..')
        ? input.exists(resolved)
        : resolved in input.files || input.exists(resolved);
      if (!found) issues.push({ file, line: i + 1, message: `broken link: ${target}` });
    }
  });
}

function tableOf(
  file: string,
  input: DocsInput,
  header: string[],
  issues: Issue[],
): Table | undefined {
  const text = input.files[file];
  if (text === undefined) {
    issues.push({ file, line: 1, message: 'required file is missing' });
    return undefined;
  }
  const table = parseTables(text).find((t) => sameHeader(t.header, header));
  if (!table) {
    issues.push({ file, line: 1, message: `table with columns [${header.join(' | ')}] not found` });
  }
  return table;
}

function checkSpecCell(
  file: string,
  row: TableRow,
  cell: string,
  input: DocsInput,
  issues: Issue[],
  label: string,
): string[] {
  const refs = specRefs(cell);
  if (refs.length === 0) {
    issues.push({ file, line: row.line, message: `${label} must name a spec id` });
  }
  for (const ref of refs) {
    if (!input.specIds.has(ref)) {
      issues.push({ file, line: row.line, message: `unknown spec id ${ref}` });
    }
  }
  return refs;
}

type FormStatus = 'received' | 'awaiting';
const isFormStatus = (value: string): value is FormStatus =>
  value === 'received' || value === 'awaiting';

function gapIds(input: DocsInput, issues: Issue[]): Set<string> {
  const ids = new Set<string>();
  const table = tableOf('gaps.md', input, GAPS_HEADER, issues);
  for (const row of table?.rows ?? []) {
    const id = at(row.cells, 0);
    if (!/^GAP-\d+$/.test(id)) {
      issues.push({ file: 'gaps.md', line: row.line, message: `invalid gap id "${id}"` });
    } else if (ids.has(id)) {
      issues.push({ file: 'gaps.md', line: row.line, message: `duplicate gap id ${id}` });
    }
    ids.add(id);
  }
  return ids;
}

function checkMapping(
  slug: string,
  status: FormStatus,
  gaps: ReadonlySet<string>,
  input: DocsInput,
  issues: Issue[],
): void {
  const file = `forms/${slug}.md`;
  const table = tableOf(file, input, MAPPING_HEADER, issues);
  if (!table) return;
  if (status === 'awaiting' && table.rows.length > 0) {
    issues.push({
      file,
      line: table.line,
      message: 'form is awaiting a sample, so the mapping must have no rows',
    });
  }
  if (status === 'received' && table.rows.length === 0) {
    issues.push({
      file,
      line: table.line,
      message: 'form is received, so the mapping needs at least one row',
    });
  }
  for (const row of table.rows) {
    const owner = at(row.cells, 3);
    const refs = specRefs(owner);
    const gap = owner.match(/GAP-\d+/g) ?? [];
    if (refs.length === 0 && gap.length === 0) {
      issues.push({ file, line: row.line, message: 'owning spec must name a spec id or a GAP id' });
    }
    for (const ref of refs) {
      if (!input.specIds.has(ref))
        issues.push({ file, line: row.line, message: `unknown spec id ${ref}` });
    }
    for (const id of gap) {
      if (!gaps.has(id)) issues.push({ file, line: row.line, message: `unknown gap ${id}` });
    }
  }
}

function checkInventory(input: DocsInput, issues: Issue[]): void {
  const file = 'forms-inventory.md';
  const table = tableOf(file, input, INVENTORY_HEADER, issues);
  const gaps = gapIds(input, issues);
  if (!table) return;

  const seen = new Set<string>();
  for (const row of table.rows) {
    const slug = at(row.cells, 1);
    const status = at(row.cells, 7);
    if (seen.has(slug)) issues.push({ file, line: row.line, message: `duplicate form ${slug}` });
    seen.add(slug);
    checkSpecCell(file, row, at(row.cells, 6), input, issues, 'spec');
    if (!isFormStatus(status)) {
      issues.push({
        file,
        line: row.line,
        message: `status must be received or awaiting, found "${status}"`,
      });
      continue;
    }
    checkMapping(slug, status, gaps, input, issues);
  }
  for (const required of REQUIRED_FORMS) {
    if (!seen.has(required)) {
      issues.push({ file, line: table.line, message: `missing required form: ${required}` });
    }
  }
}

function checkWorkflows(input: DocsInput, issues: Issue[]): void {
  for (const name of REQUIRED_WORKFLOWS) {
    const file = `workflows/${name}.md`;
    const table = tableOf(file, input, WORKFLOW_HEADER, issues);
    if (!table) continue;
    if (table.rows.length === 0) {
      issues.push({ file, line: table.line, message: 'workflow has no steps' });
    }
    for (const row of table.rows) {
      checkSpecCell(file, row, at(row.cells, 4), input, issues, 'spec');
    }
  }
}

function checkGlossary(input: DocsInput, issues: Issue[]): void {
  const table = tableOf('glossary.md', input, GLOSSARY_HEADER, issues);
  if (table && table.rows.length === 0) {
    issues.push({ file: 'glossary.md', line: table.line, message: 'glossary has no terms' });
  }
}

/** Validate the discovery pack. Returns every problem found; an empty list means it is valid. */
export function checkDiscovery(input: DocsInput): Issue[] {
  const issues: Issue[] = [];
  checkInventory(input, issues);
  checkWorkflows(input, issues);
  checkGlossary(input, issues);
  for (const [file, text] of Object.entries(input.files)) {
    checkSensitive(file, text, issues);
    checkLinks(file, text, input, issues);
  }
  return issues;
}

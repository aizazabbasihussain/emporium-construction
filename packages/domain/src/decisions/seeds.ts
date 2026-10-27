import type { ValidationError } from '../errors.js';
import { parseCsv } from '../importer/csv.js';
import {
  amountCheck,
  checkBands,
  checkFields,
  checkHierarchy,
  checkRanges,
  checkReference,
  checkUnique,
  dateCheck,
  get,
  integerCheck,
  oneOf,
  optional,
  rateCheck,
  required,
  type Check,
  type DecisionIssue,
  type Row,
} from './checks.js';

const bool = oneOf(['true', 'false']);

interface SeedDef {
  columns: readonly string[];
  schema: Record<string, Check>;
}

/** Column layout and per-column checks for every seed file under packages/db/seeds. */
export const seedDefs = {
  'chart_of_accounts.csv': {
    columns: ['code', 'name', 'type', 'parent_code', 'active'],
    schema: {
      code: required,
      name: required,
      type: oneOf(['asset', 'liability', 'equity', 'income', 'expense']),
      active: bool,
    },
  },
  'tax_authorities.csv': {
    columns: ['code', 'name', 'registration_number'],
    schema: { code: required, name: required },
  },
  'tax_rules.csv': {
    columns: [
      'authority',
      'applies_to',
      'region',
      'rate_percent',
      'effective_from',
      'effective_to',
      'note',
    ],
    schema: {
      authority: required,
      applies_to: oneOf(['goods', 'services']),
      region: required,
      rate_percent: rateCheck,
      effective_from: dateCheck,
      effective_to: optional(dateCheck),
    },
  },
  'withholding_rules.csv': {
    columns: [
      'direction',
      'party_type',
      'nature',
      'rate_percent',
      'base',
      'effective_from',
      'effective_to',
    ],
    schema: {
      direction: oneOf(['client_withholds', 'we_withhold']),
      party_type: required,
      nature: required,
      rate_percent: rateCheck,
      base: required,
      effective_from: dateCheck,
      effective_to: optional(dateCheck),
    },
  },
  'roles.csv': {
    columns: ['code', 'name'],
    schema: { code: required, name: required },
  },
  'role_permissions.csv': {
    columns: ['role_code', 'permission_code'],
    schema: { role_code: required, permission_code: required },
  },
  'approval_rules.csv': {
    columns: ['document_type', 'min_amount', 'max_amount', 'steps'],
    schema: {
      document_type: required,
      min_amount: amountCheck,
      max_amount: optional(amountCheck),
      steps: required,
    },
  },
  'valuation_policy.csv': {
    columns: ['scope', 'category_code', 'method', 'effective_from'],
    schema: {
      scope: oneOf(['company', 'category']),
      method: oneOf(['weighted_average', 'fifo']),
      effective_from: dateCheck,
    },
  },
  'number_series.csv': {
    columns: ['code', 'prefix', 'padding', 'reset_yearly', 'gapless', 'start_value'],
    schema: {
      code: required,
      prefix: required,
      padding: integerCheck(1),
      reset_yearly: bool,
      gapless: bool,
      start_value: integerCheck(1),
    },
  },
  'rounding.csv': {
    columns: ['context', 'mode', 'decimals'],
    schema: { context: required, mode: required, decimals: integerCheck(0) },
  },
  'cost_codes.csv': {
    columns: ['code', 'name', 'parent_code', 'kind'],
    schema: {
      code: required,
      name: required,
      kind: oneOf(['material', 'labour', 'subcontract', 'equipment', 'overhead']),
    },
  },
} satisfies Record<string, SeedDef>;

export type SeedFileName = keyof typeof seedDefs;
export const seedFileNames = Object.keys(seedDefs) as SeedFileName[];

/** Seed file name to file text. */
export type SeedFiles = Readonly<Record<string, string>>;

export interface SeedReport {
  issues: DecisionIssue[];
  /** Files that contain only the header: their decision is still pending. */
  headerOnly: string[];
}

function readRows(file: SeedFileName, text: string): { rows: Row[]; issues: DecisionIssue[] } {
  const { columns } = seedDefs[file];
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    const message = (error as ValidationError).message;
    return { rows: [], issues: [{ file, row: 0, message }] };
  }
  const header = (table[0] ?? []).map((cell) => cell.trim());
  if (header.join(',') !== columns.join(',')) {
    return {
      rows: [],
      issues: [{ file, row: 1, message: `header must be exactly: ${columns.join(',')}` }],
    };
  }
  const rows: Row[] = [];
  const issues: DecisionIssue[] = [];
  table.slice(1).forEach((cells, index) => {
    const row = index + 2;
    if (cells.every((cell) => cell.trim() === '')) return;
    if (cells.length !== columns.length) {
      issues.push({
        file,
        row,
        message: `expected ${columns.length} columns but found ${cells.length}`,
      });
      return;
    }
    rows.push({
      row,
      cells: Object.fromEntries(columns.map((name, i) => [name, (cells[i] as string).trim()])),
    });
  });
  return { rows, issues };
}

const withoutRows = (rows: readonly Row[], issues: readonly DecisionIssue[]): Row[] => {
  const bad = new Set(issues.map((issue) => issue.row));
  return rows.filter(({ row }) => !bad.has(row));
};

const values = (rows: readonly Row[], column: string): Set<string> =>
  new Set(rows.map(({ cells }) => get(cells, column)));

/** BR-2 and BR-4: validates every seed file. All eleven files must be present. */
export function validateSeeds(files: SeedFiles): SeedReport {
  const issues: DecisionIssue[] = [];
  const headerOnly: string[] = [];
  const rows = {} as Record<SeedFileName, Row[]>;
  const clean = {} as Record<SeedFileName, Row[]>;

  for (const file of seedFileNames) {
    const text = files[file];
    rows[file] = [];
    clean[file] = [];
    if (text === undefined) {
      issues.push({ file, row: 0, message: 'file is missing' });
      continue;
    }
    const read = readRows(file, text);
    const fieldIssues = checkFields(file, read.rows, seedDefs[file].schema);
    issues.push(...read.issues, ...fieldIssues);
    rows[file] = read.rows;
    clean[file] = withoutRows(read.rows, fieldIssues);
    if (read.issues.length === 0 && read.rows.length === 0) headerOnly.push(file);
  }

  issues.push(
    ...checkHierarchy('chart_of_accounts.csv', rows['chart_of_accounts.csv']),
    ...checkHierarchy('cost_codes.csv', rows['cost_codes.csv']),
    ...checkUnique('tax_authorities.csv', rows['tax_authorities.csv'], ['code']),
    ...checkUnique('roles.csv', rows['roles.csv'], ['code']),
    ...checkUnique('role_permissions.csv', rows['role_permissions.csv'], [
      'role_code',
      'permission_code',
    ]),
    ...checkUnique('number_series.csv', rows['number_series.csv'], ['code']),
    ...checkUnique('number_series.csv', rows['number_series.csv'], ['prefix']),
    ...checkUnique('rounding.csv', rows['rounding.csv'], ['context']),
    ...checkUnique('valuation_policy.csv', rows['valuation_policy.csv'], [
      'scope',
      'category_code',
      'effective_from',
    ]),
    ...checkReference(
      'tax_rules.csv',
      rows['tax_rules.csv'],
      'authority',
      values(rows['tax_authorities.csv'], 'code'),
    ),
    ...checkReference(
      'role_permissions.csv',
      rows['role_permissions.csv'],
      'role_code',
      values(rows['roles.csv'], 'code'),
    ),
    ...checkRanges(
      'tax_rules.csv',
      clean['tax_rules.csv'].map(({ row, cells }) => ({
        row,
        key: `${cells.authority}/${cells.applies_to}/${cells.region}`,
        from: get(cells, 'effective_from'),
        to: get(cells, 'effective_to'),
      })),
    ),
    ...checkRanges(
      'withholding_rules.csv',
      clean['withholding_rules.csv'].map(({ row, cells }) => ({
        row,
        key: `${cells.direction}/${cells.party_type}/${cells.nature}`,
        from: get(cells, 'effective_from'),
        to: get(cells, 'effective_to'),
      })),
    ),
    ...checkApprovalRules(
      rows['approval_rules.csv'],
      clean['approval_rules.csv'],
      values(rows['roles.csv'], 'code'),
    ),
    ...checkValuationPolicy(clean['valuation_policy.csv']),
  );

  return { issues, headerOnly };
}

function checkApprovalRules(
  all: readonly Row[],
  clean: readonly Row[],
  roles: ReadonlySet<string>,
): DecisionIssue[] {
  const file = 'approval_rules.csv';
  const issues: DecisionIssue[] = [];
  for (const { row, cells } of all) {
    for (const role of get(cells, 'steps')
      .split('|')
      .map((step) => step.trim())) {
      if (role !== '' && !roles.has(role)) {
        issues.push({ file, row, message: `steps role "${role}" is not defined in roles.csv` });
      }
    }
  }
  issues.push(
    ...checkBands(
      file,
      clean.map(({ row, cells }) => ({
        row,
        group: get(cells, 'document_type'),
        min: get(cells, 'min_amount'),
        max: get(cells, 'max_amount'),
      })),
    ),
  );
  return issues;
}

/** BR-4: exactly one company-scope row on the first date; category rows name a category. */
function checkValuationPolicy(clean: readonly Row[]): DecisionIssue[] {
  const file = 'valuation_policy.csv';
  const issues: DecisionIssue[] = [];
  for (const { row, cells } of clean) {
    const category = get(cells, 'category_code');
    if (cells.scope === 'company' && category !== '') {
      issues.push({ file, row, message: 'category_code must be blank for company scope' });
    }
    if (cells.scope === 'category' && category === '') {
      issues.push({ file, row, message: 'category_code is required for category scope' });
    }
  }
  if (clean.length > 0) {
    const first = clean.map(({ cells }) => get(cells, 'effective_from')).sort()[0];
    const onFirst = clean.filter(
      ({ cells }) => cells.scope === 'company' && cells.effective_from === first,
    );
    if (onFirst.length !== 1) {
      issues.push({
        file,
        row: 0,
        message: `exactly one company row must start on the first date ${first}, found ${onFirst.length}`,
      });
    }
  }
  return issues;
}

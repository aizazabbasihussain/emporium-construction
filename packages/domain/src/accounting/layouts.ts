import { ValidationError } from '../errors.js';

export type ColumnType = 'text' | 'money' | 'qty' | 'date' | 'int';

export interface LayoutColumn {
  key: string;
  type: ColumnType;
}

export interface ExportLayout {
  code: ExportCode;
  /** BR-10: a layout change is a new version; the old one stays reproducible. */
  version: number;
  title: string;
  columns: readonly LayoutColumn[];
  /** The money columns the owning modules report a figure for (BR-5); the others are only summed. */
  controlColumns: readonly string[];
}

export const exportCodeList = [
  'sales_register',
  'purchase_register',
  'receipts_register',
  'payments_register',
  'cash_bank_book',
  'pdc_register',
  'customer_ledger',
  'vendor_ledger',
  'aging',
  'withholding_report',
  'payroll_summary',
  'stock_valuation',
  'project_cost_profit',
  'subcontractor_statements',
] as const;
export type ExportCode = (typeof exportCodeList)[number];

const t = (key: string): LayoutColumn => ({ key, type: 'text' });
const d = (key: string): LayoutColumn => ({ key, type: 'date' });
const m = (key: string): LayoutColumn => ({ key, type: 'money' });
const q = (key: string): LayoutColumn => ({ key, type: 'qty' });
/** BR-2: the last column of every row; blank when the line is untagged or not a taggable document. */
const tag = t('account_code');
const period = [t('fiscal_year'), t('month')];

const layout = (
  code: ExportCode,
  title: string,
  columns: LayoutColumn[],
  controlColumns: string[],
): ExportLayout => ({ code, version: 1, title, columns: [...columns, tag], controlColumns });

/** The current layouts. `docs/exports/<code>.md` documents each one and a test compares the two. */
export const exportLayouts: readonly ExportLayout[] = [
  layout(
    'sales_register',
    'Sales register',
    [
      ...period,
      d('date'),
      t('doc_type'),
      t('number'),
      t('authority'),
      t('party'),
      t('project'),
      m('base'),
      m('tax'),
      m('gross'),
    ],
    ['base', 'tax'],
  ),
  layout(
    'purchase_register',
    'Purchase register',
    [
      ...period,
      d('date'),
      t('number'),
      t('vendor_invoice_no'),
      t('authority'),
      t('party'),
      m('base'),
      m('tax'),
      m('gross'),
      m('withholding'),
      m('net_payable'),
    ],
    ['net_payable'],
  ),
  layout(
    'receipts_register',
    'Receipts register',
    [...period, d('date'), t('number'), t('party'), t('method'), m('amount'), m('withheld')],
    ['amount', 'withheld'],
  ),
  layout(
    'payments_register',
    'Payments register',
    [
      ...period,
      d('date'),
      t('number'),
      t('party'),
      t('method'),
      t('cheque_no'),
      m('amount'),
      m('withholding'),
    ],
    ['amount'],
  ),
  layout(
    'cash_bank_book',
    'Cash and bank book',
    [
      ...period,
      t('account'),
      d('date'),
      t('number'),
      t('description'),
      m('money_in'),
      m('money_out'),
      m('net'),
      m('balance'),
    ],
    ['net'],
  ),
  layout(
    'pdc_register',
    'Post-dated cheque register',
    [
      t('cheque_no'),
      t('bank'),
      t('party'),
      d('cheque_date'),
      t('status'),
      d('cleared_on'),
      m('amount'),
    ],
    ['amount'],
  ),
  layout(
    'customer_ledger',
    'Customer ledger',
    [
      t('party'),
      d('date'),
      t('kind'),
      t('reference'),
      m('debit'),
      m('credit'),
      m('net'),
      m('balance'),
    ],
    ['net'],
  ),
  layout(
    'vendor_ledger',
    'Vendor ledger',
    [
      t('party'),
      d('date'),
      t('kind'),
      t('reference'),
      m('debit'),
      m('credit'),
      m('net'),
      m('balance'),
    ],
    ['net'],
  ),
  layout(
    'aging',
    'Aging',
    [t('side'), t('party'), m('bucket_1'), m('bucket_2'), m('bucket_3'), m('bucket_4'), m('total')],
    ['total'],
  ),
  layout(
    'withholding_report',
    'Withholding report',
    [
      ...period,
      t('direction'),
      t('authority'),
      t('party'),
      t('document'),
      t('certificate_no'),
      m('amount'),
    ],
    ['amount'],
  ),
  layout(
    'payroll_summary',
    'Payroll summary',
    [...period, t('status'), m('net_pay'), m('paid'), m('unpaid')],
    ['net_pay', 'paid'],
  ),
  layout(
    'stock_valuation',
    'Stock valuation',
    [t('store'), t('category'), t('method'), q('quantity'), m('value')],
    ['value'],
  ),
  layout(
    'project_cost_profit',
    'Project cost and profit summary',
    [
      t('project'),
      t('status'),
      m('contract_value'),
      m('cost_total'),
      m('expected_margin'),
      m('cash_position'),
    ],
    ['cost_total'],
  ),
  layout(
    'subcontractor_statements',
    'Subcontractor statements',
    [
      t('party'),
      t('work_order'),
      t('status'),
      m('contract'),
      m('certified'),
      m('deductions'),
      m('billed'),
      m('paid'),
    ],
    ['certified', 'billed', 'paid'],
  ),
];

/** BR-10: every version ever issued; a run names the version it used. */
export const layoutVersions: readonly ExportLayout[] = exportLayouts;

/** The layout of an export in the given version, or the latest one when no version is asked for. */
export function findLayout(
  versions: readonly ExportLayout[],
  code: string,
  version?: number,
): ExportLayout {
  let found: ExportLayout | undefined;
  for (const layout of versions) {
    if (layout.code !== code || (version !== undefined && layout.version !== version)) continue;
    if (found === undefined || layout.version > found.version) found = layout;
  }
  if (found === undefined) {
    throw new ValidationError(
      'unknown_export',
      `No export ${code}${version === undefined ? '' : ` version ${version}`}`,
    );
  }
  return found;
}

export const layoutOf = (code: string, version?: number): ExportLayout =>
  findLayout(layoutVersions, code, version);

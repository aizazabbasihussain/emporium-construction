import type { AccountingDocType, ExportCode } from '@emporium/shared';
import { request } from '../admin/api';

export interface ExportInfo {
  code: ExportCode;
  title: string;
  schemaVersion: number;
  columns: { key: string; type: string }[];
}

export interface ExportFilters {
  from: string;
  to: string;
  side?: 'receivable' | 'payable' | undefined;
  authorityCode?: string | undefined;
}

export interface Run {
  id: string;
  exportCode: ExportCode;
  schemaVersion: number;
  filters: Record<string, string>;
  rowCount: number;
  checksumSha256: string;
  fileId: string | null;
  runBy: string | null;
  runAt: string;
}

export interface RunResult {
  run: Run;
  untagged: number;
  totals: Record<string, string>;
  files: { xlsx: string; csv: string };
}

export interface Untagged {
  sourceDocType: AccountingDocType;
  sourceDocId: string;
  lineRef: string;
  date: string;
  number: string;
  party: string;
  amount: string;
  description: string;
  suggestedAccountCode: string | null;
}

export interface UntaggedPage {
  items: Untagged[];
  total: number;
  limit: number;
  offset: number;
  byType: Record<string, number>;
}

export interface BackfillPlan {
  dryRun: boolean;
  considered: number;
  alreadyTagged: number;
  tagged: number;
  unmatched: number;
  sample: { sourceDocType: string; sourceDocId: string; lineRef: string; accountCode: string }[];
}

export interface Account {
  code: string;
  name: string;
  type: string;
  parentCode: string | null;
  active: boolean;
  version: number;
}

export interface Rule {
  id: string;
  sourceDocType: AccountingDocType;
  condition: Record<string, string>;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
  version: number;
}

export interface RuleBody {
  id?: string;
  version?: number;
  sourceDocType: AccountingDocType;
  condition: Record<string, string>;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
};

export const accountingApi = {
  exports: () => request<ExportInfo[]>('GET', '/exports'),
  run: (code: ExportCode, filters: ExportFilters) =>
    request<RunResult>('POST', `/exports/${code}/run`, filters),
  runs: (exportCode?: ExportCode) =>
    request<{ items: Run[]; total: number }>(
      'GET',
      `/exports/runs${query({ exportCode, limit: 20 })}`,
    ),
  /** A short-lived link to a stored file of a run. */
  fileUrl: (fileId: string) =>
    request<{ url: string; expiresAt: string }>('GET', `/files/${fileId}/url`),
  untagged: (params: {
    from?: string | undefined;
    to?: string | undefined;
    docType?: AccountingDocType | undefined;
  }) => request<UntaggedPage>('GET', `/accounting/untagged${query({ ...params, limit: 200 })}`),
  tag: (
    targets: { docType: AccountingDocType; docId: string; lineRef: string }[],
    accountCode: string,
  ) => request<unknown[]>('PUT', '/accounting/tags', { targets, accountCode }),
  backfill: (
    mode: 'dry-run' | 'commit',
    range: { from?: string | undefined; to?: string | undefined },
  ) =>
    request<BackfillPlan>('POST', `/accounting/backfill/${mode}`, {
      ...(range.from === undefined || range.from === '' ? {} : { from: range.from }),
      ...(range.to === undefined || range.to === '' ? {} : { to: range.to }),
    }),
  accounts: (includeInactive: boolean) =>
    request<Account[]>(
      'GET',
      `/accounting/accounts${query({ includeInactive: includeInactive ? 'true' : undefined })}`,
    ),
  setAccountActive: (account: Account, active: boolean) =>
    request<Account>('PUT', `/accounting/accounts/${encodeURIComponent(account.code)}`, {
      active,
      version: account.version,
    }),
  rules: () => request<Rule[]>('GET', '/accounting/mapping-rules'),
  saveRule: (body: RuleBody) => request<Rule>('PUT', '/accounting/mapping-rules', body),
};

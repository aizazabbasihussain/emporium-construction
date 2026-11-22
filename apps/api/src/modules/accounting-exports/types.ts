import type { ScopeGrant } from '@emporium/domain/identity';
import type { DocType, ExportRow, MappingRule } from '@emporium/domain/accounting';
import type { AccountType, ExportCode, TagMethod } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { AccountType, Db, DocType, ExportCode, ExportRow, MappingRule, TagMethod };

/** Who is asking; the permissions decide what they may do. */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
  /** Shown in the header block of an export. */
  name?: string | undefined;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AccountDto {
  code: string;
  name: string;
  type: AccountType;
  parentCode: string | null;
  active: boolean;
  version: number;
}

export interface RuleDto {
  id: string;
  sourceDocType: DocType;
  condition: Record<string, string>;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active: boolean;
  version: number;
}

export interface RuleInput {
  sourceDocType: DocType;
  condition?: Record<string, string> | undefined;
  debitAccountCode: string;
  creditAccountCode: string;
  effectiveFrom: string;
  active?: boolean | undefined;
}

export interface TagDto {
  sourceDocType: DocType;
  sourceDocId: string;
  lineRef: string;
  accountCode: string;
  taggedBy: string | null;
  method: TagMethod;
  taggedAt: string;
}

/** The line of a document as the untagged queue shows it. */
export interface UntaggedDto {
  sourceDocType: DocType;
  sourceDocId: string;
  lineRef: string;
  date: string;
  number: string;
  party: string;
  amount: string;
  description: string;
  /** The account the rules would propose, when one fits. */
  suggestedAccountCode: string | null;
}

export interface UntaggedPageDto {
  items: UntaggedDto[];
  total: number;
  limit: number;
  offset: number;
  /** BR-2: every untagged line in the period, by document type. */
  byType: Record<string, number>;
}

export interface BackfillPlanDto {
  dryRun: boolean;
  considered: number;
  alreadyTagged: number;
  /** What the rules tag (dry run) or tagged (commit). */
  tagged: number;
  unmatched: number;
  sample: { sourceDocType: DocType; sourceDocId: string; lineRef: string; accountCode: string }[];
}

export interface ExportInfoDto {
  code: ExportCode;
  title: string;
  schemaVersion: number;
  columns: { key: string; type: string }[];
}

export interface ExportFilters {
  from: string;
  to: string;
  partyId?: string | undefined;
  projectId?: string | undefined;
  accountId?: string | undefined;
  storeId?: string | undefined;
  categoryId?: string | undefined;
  side?: 'receivable' | 'payable' | undefined;
  authorityCode?: string | undefined;
}

export interface RunDto {
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

export interface RunResultDto {
  run: RunDto;
  /** BR-2: lines in the export that carry no account code. */
  untagged: number;
  totals: Record<string, string>;
  files: { xlsx: string; csv: string };
}

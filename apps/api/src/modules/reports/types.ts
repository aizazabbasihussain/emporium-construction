import type { ScopeGrant } from '@emporium/domain/identity';
import type { ReportCode } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db, ReportCode };

/** Who is asking; the project scope of a caller limits every project-bound report (BR-8). */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
  /** Shown in the header block of an export. */
  name?: string | undefined;
}

export type ColumnType = 'text' | 'money' | 'qty' | 'percent' | 'int' | 'date';

/** The label of a column comes from the i18n key `reports.columns.<key>`. */
export interface Column {
  key: string;
  type: ColumnType;
}

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

/** One table of a report: columns, rows, and the totals row over the whole filtered set. */
export interface Section {
  key: string;
  columns: Column[];
  rows: Row[];
  totals: Row | null;
}

/** What a report builds before it is sorted, paged or exported. */
export interface ReportData {
  code: ReportCode;
  /** The filters that applied, as shown in the header block of an export. */
  filters: Record<string, string>;
  /** The main list: sorted, paged and exported. */
  main: Section;
  /** Further tables of the report, returned and exported whole. */
  extras: Section[];
  /** The sort the report has when none is asked for. */
  defaultSort?: (a: Row, b: Row) => number;
}

export interface ReportFilters {
  projectId?: string | undefined;
  storeId?: string | undefined;
  itemId?: string | undefined;
  vendorId?: string | undefined;
  ownership?: 'company' | 'client' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  overdueOnly?: boolean | undefined;
  belowReorderOnly?: boolean | undefined;
}

export interface ReportQuery {
  filters: ReportFilters;
  sort?: string | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** BR-11: one page of the main list; the totals cover the whole filtered set. */
export interface ReportPageDto {
  code: ReportCode;
  filters: Record<string, string>;
  columns: Column[];
  items: Row[];
  total: number;
  limit: number;
  offset: number;
  totals: Row | null;
  extras: Section[];
}

export interface SavedFilterDto {
  id: string;
  reportCode: ReportCode;
  name: string;
  filter: Record<string, unknown>;
  version: number;
}

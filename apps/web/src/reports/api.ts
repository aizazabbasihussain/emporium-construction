import type { ReportCode } from '@emporium/shared';
import { rawRequest, request } from '../admin/api';

export type ColumnType = 'text' | 'money' | 'qty' | 'percent' | 'int' | 'date';
export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Column {
  key: string;
  type: ColumnType;
}

export interface Section {
  key: string;
  columns: Column[];
  rows: Row[];
  totals: Row | null;
}

export interface ReportPageData {
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

export interface ReportFilter {
  projectId?: string | undefined;
  ownership?: 'company' | 'client' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  overdueOnly?: boolean | undefined;
  belowReorderOnly?: boolean | undefined;
}

export interface ReportParams extends ReportFilter {
  sort?: string | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface SavedFilter {
  id: string;
  reportCode: ReportCode;
  name: string;
  filter: ReportFilter;
  version: number;
}

const query = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== false) search.set(key, String(value));
  }
  return search.toString();
};

export const reportsApi = {
  run: (code: ReportCode, params: ReportParams) =>
    request<ReportPageData>('GET', `/reports/${code}?${query({ ...params })}`),
  savedFilters: (code: ReportCode) =>
    request<{ items: SavedFilter[] }>('GET', `/reports/saved-filters?reportCode=${code}`),
  saveFilter: (code: ReportCode, name: string, filter: ReportFilter) =>
    request<SavedFilter>('POST', '/reports/saved-filters', { reportCode: code, name, filter }),
  removeFilter: (filter: SavedFilter) =>
    request<{ id: string }>(
      'DELETE',
      `/reports/saved-filters/${filter.id}?version=${filter.version}`,
    ),
  /** Fetches the export with the access token and hands it to the browser as a download. */
  download: async (
    code: ReportCode,
    params: ReportFilter & { sort?: string | undefined; direction?: 'asc' | 'desc' | undefined },
    format: 'csv' | 'xlsx',
  ): Promise<void> => {
    const blob = await (
      await rawRequest('GET', `/reports/${code}?${query({ ...params, format })}`)
    ).blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${code}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  },
};

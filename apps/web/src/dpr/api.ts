import type { DprStatus, DprWeather } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Manpower {
  trade: string;
  count: number;
}

export interface TaskUpdate {
  taskId: string;
  percentComplete: number;
  note: string | null;
}

export interface MaterialNote {
  description: string;
  quantity: string | null;
  unitCode: string | null;
}

export interface ReportHeader {
  id: string;
  projectId: string;
  reportDate: string;
  authorId: string;
  weather: DprWeather;
  status: DprStatus;
  workDone: string;
  issues: string;
  safetyNotes: string;
  manpowerManual: Manpower[];
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  version: number;
}

export interface Report extends ReportHeader {
  taskUpdates: TaskUpdate[];
  materialNotes: MaterialNote[];
  photoCount: number;
}

/** What the form sends; the API checks it again. */
export interface ReportBody {
  weather: DprWeather;
  workDone: string;
  issues: string;
  safetyNotes: string;
  manpowerManual: Manpower[];
  taskUpdates: { taskId: string; percentComplete: number; note?: string }[];
  materialNotes: { description: string; quantity?: string; unitCode?: string }[];
}

export interface MissingReport {
  projectId: string;
  code: string;
  name: string;
  projectManagerId: string | null;
  supervisorIds: string[];
  date: string;
}

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
};

export const dprApi = {
  reports: (params: { projectId?: string; status?: DprStatus; mine?: boolean } = {}) =>
    request<Page<ReportHeader>>('GET', `/dpr/reports?${query({ ...params, limit: 200 })}`),
  report: (id: string) => request<Report>('GET', `/dpr/reports/${id}`),
  create: (projectId: string, reportDate: string, body: ReportBody) =>
    request<Report>('POST', '/dpr/reports', { projectId, reportDate, ...body }),
  update: (id: string, version: number, body: ReportBody) =>
    request<Report>('PATCH', `/dpr/reports/${id}`, { ...body, version }),
  submit: (id: string, version: number) =>
    request<Report>('POST', `/dpr/reports/${id}/submit`, { version }),
  review: (id: string, version: number, note: string) =>
    request<Report>('POST', `/dpr/reports/${id}/review`, {
      version,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    }),
  reopen: (id: string, version: number, note: string) =>
    request<Report>('POST', `/dpr/reports/${id}/reopen`, {
      version,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    }),
  missing: (date: string) => request<MissingReport[]>('GET', `/dpr/missing?${query({ date })}`),
};

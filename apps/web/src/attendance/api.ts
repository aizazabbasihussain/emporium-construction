import type { EntryStatus, SheetStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Allocation {
  id: string;
  projectId: string;
  fraction: string;
  costCodeId: string;
  amount: string | null;
}

export interface Entry {
  id: string;
  lineNo: number;
  workerId: string;
  workerCode: string;
  workerName: string;
  status: EntryStatus;
  overtimeHours: string;
  overtimeProjectId: string | null;
  remarks: string | null;
  dayValue: string | null;
  overtimeValue: string | null;
  allocations: Allocation[];
}

export interface SheetHeader {
  id: string;
  teamId: string;
  sheetDate: string;
  status: SheetStatus;
  /** Null for a supervisor, who never receives pay information. */
  total: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  unlockReason: string | null;
  version: number;
}

export interface Sheet extends SheetHeader {
  entries: Entry[];
  approval: {
    status: string;
    requestId: string | null;
    currentRole: string | null;
    lastComment: string | null;
  };
}

export interface GridMember {
  workerId: string;
  code: string;
  fullName: string;
  tradeCode: string;
}

export interface Grid {
  teamId: string;
  date: string;
  members: GridMember[];
  sheet: Sheet | null;
}

export interface MissingSheet {
  teamId: string;
  teamCode: string;
  teamName: string;
  date: string;
}

export interface TeamOption {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

/** What the grid sends; the API checks it again. */
export interface SheetBody {
  version?: number;
  entries: {
    workerId: string;
    status: EntryStatus;
    overtimeHours?: string;
    overtimeProjectId?: string;
    remarks?: string;
    allocations?: { projectId: string; fraction: string }[];
  }[];
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const attendanceApi = {
  teams: () => request<TeamOption[]>('GET', '/workforce/teams'),
  grid: (team: string, date: string) =>
    request<Grid>('GET', `/attendance/grid?${query({ team, date })}`),
  sheets: (params: { from?: string; to?: string; status?: SheetStatus }) =>
    request<Page<SheetHeader>>('GET', `/attendance/sheets?${query({ ...params, limit: 200 })}`),
  save: (team: string, date: string, body: SheetBody) =>
    request<Sheet>('PUT', `/attendance/sheets/${team}/${date}`, body),
  submit: (id: string, version: number) =>
    request<Sheet>('POST', `/attendance/sheets/${id}/submit`, { version }),
  unlock: (id: string, version: number, reason: string) =>
    request<Sheet>('POST', `/attendance/sheets/${id}/unlock`, { reason, version }),
  missing: (from: string, to: string) =>
    request<MissingSheet[]>('GET', `/attendance/missing?${query({ from, to })}`),
};

import type {
  BudgetSource,
  CostStatus,
  ProjectSector,
  ProjectStatus,
  TaskStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Project {
  id: string;
  code: string;
  name: string;
  partyId: string;
  sector: ProjectSector;
  locationId: string | null;
  siteAddress: string | null;
  status: ProjectStatus;
  startDate: string | null;
  plannedEndDate: string | null;
  actualEndDate: string | null;
  originalContractValue: string;
  quotationId: string | null;
  estimateId: string | null;
  projectManagerId: string | null;
  progressPercent: string;
  version: number;
}

export interface ProjectDetail extends Project {
  supervisors: { userId: string; fromDate: string; toDate: string | null }[];
}

export interface BudgetLine {
  id: string;
  costCodeId: string;
  description: string;
  budgetAmount: string;
  source: BudgetSource;
}

export interface Budget {
  projectVersion: number;
  lines: BudgetLine[];
}

/** What the budget editor sends for a line; the API normalises the amount. */
export interface BudgetLineInput {
  costCodeId: string;
  description: string;
  budgetAmount: string;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  assignedToUser: string | null;
  startDate: string | null;
  dueDate: string | null;
  status: TaskStatus;
  percentComplete: number;
  version: number;
}

export type BudgetFlag = 'ok' | 'warning' | 'overspent';

export interface SummaryLine {
  costCodeId: string;
  committed: string;
  approved: string;
  posted: string;
  budget: string | null;
  variance: string | null;
  flag: BudgetFlag | null;
}

export interface CostSummary {
  lines: SummaryLine[];
  totals: { committed: string; approved: string; posted: string };
  budget: string | null;
  variance: string | null;
  flag: BudgetFlag | null;
}

export interface CostEntry {
  id: string;
  costCodeId: string;
  amount: string;
  status: CostStatus;
  sourceModule: string;
  sourceDocType: string;
  entryDate: string;
  description: string;
}

export type Params = Record<string, string | number | undefined>;

const query = (params: Params): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const projectsApi = {
  list: (params: Params = {}) => request<Page<Project>>('GET', `/projects?${query(params)}`),
  get: (id: string) => request<ProjectDetail>('GET', `/projects/${id}`),
  create: (body: unknown) => request<ProjectDetail>('POST', '/projects', body),
  setStatus: (id: string, status: ProjectStatus, version: number) =>
    request<ProjectDetail>('POST', `/projects/${id}/status`, { status, version }),
  summary: (id: string) => request<CostSummary>('GET', `/projects/${id}/summary`),
  budget: (id: string) => request<Budget>('GET', `/projects/${id}/budget`),
  saveBudget: (id: string, version: number, lines: BudgetLineInput[]) =>
    request<Budget>('PUT', `/projects/${id}/budget`, { version, lines }),
  tasks: (id: string) => request<Task[]>('GET', `/projects/${id}/tasks`),
  createTask: (id: string, body: { name: string }) =>
    request<Task>('POST', `/projects/${id}/tasks`, body),
  updateTask: (
    id: string,
    taskId: string,
    body: { version: number; status?: TaskStatus; percentComplete?: number },
  ) => request<Task>('PATCH', `/projects/${id}/tasks/${taskId}`, body),
  entries: (id: string, params: Params = {}) =>
    request<Page<CostEntry>>('GET', `/projects/${id}/cost-entries?${query(params)}`),
};

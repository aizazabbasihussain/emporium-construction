import type { EmploymentType, PayBasis, WorkerStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Trade {
  code: string;
  name: string;
  version: number;
}

/** A worker as the API sends it: no pay information, whoever asks. */
export interface Worker {
  id: string;
  code: string;
  fullName: string;
  fatherName: string | null;
  cnic: string | null;
  phone: string | null;
  tradeCode: string;
  employmentType: EmploymentType;
  contractorPartyId: string | null;
  joinedOn: string;
  leftOn: string | null;
  status: WorkerStatus;
  bankOrWalletInfo: string | null;
  version: number;
}

export interface Rate {
  id: string;
  workerId: string;
  payBasis: PayBasis;
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface Team {
  id: string;
  code: string;
  name: string;
  supervisorUserId: string;
  active: boolean;
  version: number;
}

export interface TeamMember {
  teamId: string;
  workerId: string;
  code: string;
  fullName: string;
  tradeCode: string;
  fromDate: string;
  toDate: string | null;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
}

/** What the worker form sends; the API checks it again. */
export interface WorkerBody {
  fullName: string;
  fatherName?: string;
  cnic?: string;
  phone?: string;
  tradeCode: string;
  employmentType: EmploymentType;
  joinedOn: string;
}

export interface RateBody {
  payBasis: PayBasis;
  amount: string;
  effectiveFrom: string;
}

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const workforceApi = {
  trades: () => request<Trade[]>('GET', '/workforce/trades'),
  workers: (params: {
    text?: string;
    tradeCode?: string;
    status?: WorkerStatus;
    teamId?: string;
  }) => request<Page<Worker>>('GET', `/workforce/workers?${query({ ...params, limit: 200 })}`),
  worker: (id: string) => request<Worker>('GET', `/workforce/workers/${id}`),
  createWorker: (body: WorkerBody) => request<Worker>('POST', '/workforce/workers', body),
  updateWorker: (id: string, version: number, body: Partial<WorkerBody>) =>
    request<Worker>('PATCH', `/workforce/workers/${id}`, { ...body, version }),
  deactivate: (id: string, version: number, leftOn: string) =>
    request<Worker>('POST', `/workforce/workers/${id}/deactivate`, { leftOn, version }),
  rates: (id: string) => request<Rate[]>('GET', `/workforce/workers/${id}/rates`),
  addRate: (id: string, body: RateBody) =>
    request<Rate>('POST', `/workforce/workers/${id}/rates`, body),
  teams: () => request<Team[]>('GET', '/workforce/teams'),
  team: (id: string) => request<TeamDetail>('GET', `/workforce/teams/${id}`),
  mine: () => request<TeamDetail[]>('GET', '/workforce/teams/mine'),
  setMembers: (id: string, version: number, workerIds: string[], date: string) =>
    request<TeamDetail>('PUT', `/workforce/teams/${id}/members`, { workerIds, date, version }),
};

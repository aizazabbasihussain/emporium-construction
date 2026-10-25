import type { FollowUpStatus, LeadSector, LeadWorkType, StageKind } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Stage {
  code: string;
  name: string;
  sortOrder: number;
  kind: StageKind;
  active: boolean;
}

export interface Reference {
  code: string;
  name: string;
}

export interface CrmReference {
  stages: Stage[];
  sources: Reference[];
  lossReasons: Reference[];
}

export interface Lead {
  id: string;
  number: string;
  partyId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  workType: LeadWorkType;
  sector: LeadSector;
  locationId: string | null;
  siteAddress: string | null;
  description: string | null;
  expectedValue: string | null;
  sourceCode: string;
  stageCode: string;
  stageKind: StageKind;
  ownerUserId: string;
  lossReasonCode: string | null;
  wonAt: string | null;
  lostAt: string | null;
  hasOverdueFollowUp: boolean;
  version: number;
}

export interface Visit {
  id: string;
  leadId: string;
  visitDate: string;
  visitedBy: string;
  notes: string | null;
  version: number;
}

export interface FollowUp {
  id: string;
  leadId: string;
  leadNumber: string;
  dueDate: string;
  note: string | null;
  assignedTo: string;
  status: FollowUpStatus;
  doneAt: string | null;
  overdue: boolean;
  version: number;
}

export interface HistoryEntry {
  fromStage: string | null;
  toStage: string;
  at: string;
  by: string | null;
}

export interface LeadDetail {
  lead: Lead;
  visits: Visit[];
  followUps: FollowUp[];
  history: HistoryEntry[];
}

export interface Pipeline {
  stages: {
    stageCode: string;
    name: string;
    kind: StageKind;
    count: number;
    expectedValue: string;
  }[];
  totalCount: number;
  totalExpectedValue: string;
  overdueFollowUps: number;
}

export type Params = Record<string, string | number | boolean | undefined>;

const query = (params: Params): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

export const crmApi = {
  reference: () => request<CrmReference>('GET', '/crm/reference'),
  leads: (params: Params = {}) => request<Page<Lead>>('GET', `/crm/leads?${query(params)}`),
  detail: (id: string) => request<LeadDetail>('GET', `/crm/leads/${id}`),
  createLead: (body: unknown) => request<Lead>('POST', '/crm/leads', body),
  updateLead: (id: string, body: unknown) => request<Lead>('PUT', `/crm/leads/${id}`, body),
  moveStage: (
    id: string,
    body: { stageCode: string; lossReasonCode?: string | undefined; version: number },
  ) => request<Lead>('POST', `/crm/leads/${id}/stage`, body),
  addVisit: (id: string, body: { visitDate: string; notes?: string | undefined }) =>
    request<Visit>('POST', `/crm/leads/${id}/visits`, body),
  addFollowUp: (id: string, body: { dueDate: string; note?: string | undefined }) =>
    request<FollowUp>('POST', `/crm/leads/${id}/follow-ups`, body),
  followUps: (params: Params = {}) =>
    request<Page<FollowUp>>('GET', `/crm/follow-ups?${query(params)}`),
  completeFollowUp: (id: string, version: number) =>
    request<FollowUp>('POST', `/crm/follow-ups/${id}/done`, { version }),
  pipeline: () => request<Pipeline>('GET', '/crm/pipeline'),
};

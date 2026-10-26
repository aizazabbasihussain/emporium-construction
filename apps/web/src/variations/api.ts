import type { VariationStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface VariationHeader {
  id: string;
  projectId: string;
  number: string;
  title: string;
  reason: string;
  discoveredOn: string;
  status: VariationStatus;
  priceImpact: string;
  costImpact: string;
  clientApprovalRef: string | null;
  clientApprovedOn: string | null;
  copiedFromId: string | null;
  atRiskTotal: string;
  version: number;
}

export interface VariationLine {
  description: string;
  costCodeId: string;
  costAmount: string;
  priceAmount: string;
}

export interface HistoryItem {
  fromStatus: VariationStatus | null;
  toStatus: VariationStatus;
  at: string;
  changedBy: string | null;
  note: string | null;
}

export interface Variation extends VariationHeader {
  lines: (VariationLine & { lineNo: number })[];
  history: HistoryItem[];
  atRisk: { total: string; byCostCode: { costCodeId: string; amount: string }[] };
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

export interface ContractValue {
  projectId: string;
  originalContractValue: string;
  approvedPriceImpact: string;
  currentContractValue: string;
  approvedVariations: number;
}

/** What the editor sends; amounts stay text and the API checks them. */
export interface VariationBody {
  title: string;
  reason: string;
  discoveredOn: string;
  lines: VariationLine[];
}

export const variationsApi = {
  list: (projectId: string) =>
    request<Page<VariationHeader>>('GET', `/projects/${projectId}/variations?limit=200`),
  contractValue: (projectId: string) =>
    request<ContractValue>('GET', `/projects/${projectId}/contract-value`),
  create: (projectId: string, body: VariationBody) =>
    request<Variation>('POST', `/projects/${projectId}/variations`, body),
  get: (id: string) => request<Variation>('GET', `/variations/${id}`),
  update: (id: string, version: number, body: VariationBody) =>
    request<Variation>('PUT', `/variations/${id}`, { ...body, version }),
  remove: (id: string, version: number) =>
    request<null>('DELETE', `/variations/${id}?version=${version}`),
  submitInternal: (id: string, version: number) =>
    request<Variation>('POST', `/variations/${id}/submit-internal`, { version }),
  sendToClient: (id: string, version: number) =>
    request<Variation>('POST', `/variations/${id}/send-to-client`, { version }),
  clientApprove: (id: string, body: { version: number; reference: string; approvedOn: string }) =>
    request<Variation>('POST', `/variations/${id}/client-approve`, body),
  clientReject: (id: string, version: number, reason: string) =>
    request<Variation>('POST', `/variations/${id}/client-reject`, { version, reason }),
  cancel: (id: string, version: number) =>
    request<Variation>('POST', `/variations/${id}/cancel`, { version }),
  copy: (id: string) => request<Variation>('POST', `/variations/${id}/copy`),
};

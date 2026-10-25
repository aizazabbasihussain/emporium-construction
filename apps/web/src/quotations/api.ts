import type { EstimateSector, QuotationStatus, StageBasis } from '@emporium/shared';
import { rawRequest, request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** A stage as the editor holds it; `amount` is only ever filled in by the API. */
export interface Stage {
  stageNo?: number;
  name: string;
  basis: StageBasis;
  percent: string;
  amount: string;
  conditionText: string | null;
}

export interface QuotationHeader {
  id: string;
  number: string;
  revision: number;
  displayNumber: string;
  parentId: string | null;
  leadId: string | null;
  estimateId: string;
  partyId: string;
  title: string;
  sector: EstimateSector;
  locationId: string | null;
  validityDays: number;
  price: string;
  status: QuotationStatus;
  issuedAt: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  expiresOn: string | null;
  version: number;
}

export interface MarginPanelData {
  totalCost: string;
  marginAmount: string;
  marginPercent: string;
  floorPercent: string;
  belowFloor: boolean;
}

export interface HistoryEntry {
  fromStatus: QuotationStatus | null;
  toStatus: QuotationStatus;
  at: string;
  changedBy: string | null;
  note: string | null;
}

export interface Quotation extends QuotationHeader {
  scopeText: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  stages: Stage[];
  history: HistoryEntry[];
  margin: MarginPanelData | null;
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

export interface PrintModel {
  company: { name: string; address: string | null; phone: string | null; email: string | null };
  registrations: { authority: string; registrationType: string; number: string }[];
  client: { name: string; address: string | null; city: string | null };
  quotation: {
    number: string;
    revision: number;
    title: string;
    issuedOn: string | null;
    expiresOn: string | null;
    validityDays: number;
  };
  scope: string;
  inclusions: string;
  exclusions: string;
  stages: {
    stageNo: number;
    name: string;
    percent: string;
    amount: string;
    condition: string | null;
  }[];
  terms: string;
  price: string;
}

export type Params = Record<string, string | number | boolean | undefined>;

const query = (params: Params): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
};

/** What goes to the API for a stage: the amount is derived there, never sent. */
export const stageBody = (stage: Stage) => ({
  name: stage.name.trim(),
  basis: stage.basis,
  ...(stage.basis === 'percent'
    ? { percent: stage.percent.trim() }
    : { amount: stage.amount.trim() }),
  conditionText:
    stage.conditionText === null || stage.conditionText.trim() === '' ? null : stage.conditionText,
});

export const quotationsApi = {
  list: (params: Params = {}) =>
    request<Page<QuotationHeader>>('GET', `/quotations?${query(params)}`),
  get: (id: string) => request<Quotation>('GET', `/quotations/${id}`),
  create: (body: unknown) => request<Quotation>('POST', '/quotations', body),
  update: (id: string, body: unknown) => request<Quotation>('PUT', `/quotations/${id}`, body),
  submit: (id: string, version: number) =>
    request<Quotation>('POST', `/quotations/${id}/submit`, { version }),
  issue: (id: string, version: number) =>
    request<Quotation>('POST', `/quotations/${id}/issue`, { version }),
  accept: (id: string, body: { version: number; acceptedByName: string; note?: string }) =>
    request<Quotation>('POST', `/quotations/${id}/accept`, body),
  reject: (id: string, body: { version: number; reason: string }) =>
    request<Quotation>('POST', `/quotations/${id}/reject`, body),
  revise: (id: string) => request<Quotation>('POST', `/quotations/${id}/revise`, {}),
  printModel: (id: string) => request<PrintModel>('GET', `/quotations/${id}/print-model`),
  /** The PDF needs the bearer token, so it is fetched as a blob and not opened as a plain link. */
  pdf: async (id: string): Promise<Blob> =>
    (await rawRequest('GET', `/quotations/${id}/pdf`)).blob(),
};

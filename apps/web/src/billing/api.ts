import type {
  BillingAdvanceStatus,
  CreditNoteStatus,
  InvoiceSourceType,
  InvoiceStatus,
  ScheduleSource,
  ScheduleStatus,
  SupplyKind,
} from '@emporium/shared';
import { rawRequest, request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScheduleStage {
  id: string;
  stageNo: number;
  name: string;
  basisPercent: string | null;
  amount: string;
  source: ScheduleSource;
  sourceId: string | null;
  status: ScheduleStatus;
}

export interface Schedule {
  projectId: string;
  originalContractValue: string;
  contractValue: string;
  scheduleTotal: string;
  matchesContract: boolean;
  pendingEditId: string | null;
  stages: ScheduleStage[];
}

export interface StageEdit {
  id?: string;
  stageNo: number;
  name: string;
  amount: string;
}

export interface InvoiceHeader {
  id: string;
  number: string | null;
  seriesCode: string | null;
  authorityCode: string | null;
  sourceType: InvoiceSourceType;
  projectId: string;
  partyId: string;
  invoiceDate: string;
  dueDate: string;
  status: InvoiceStatus;
  baseAmount: string;
  advanceRecovery: string;
  taxableBase: string;
  taxTotal: string;
  grossTotal: string;
  withholdingExpected: string;
  registrationNumber: string | null;
  taxOnAdvanceAtReceipt: boolean;
  paymentDays: number | null;
  notes: string | null;
  issuedAt: string | null;
  version: number;
}

export interface Invoice extends InvoiceHeader {
  lines: {
    lineNo: number;
    scheduleId: string | null;
    description: string;
    amount: string;
    supplyKind: string;
    nature: string | null;
  }[];
  approval: { status: string; requestId: string | null; currentRole: string | null };
  creditedBase: string;
}

/** The figures of a saved draft as the tax engine would state them (the builder's preview). */
export interface InvoicePreview {
  baseAmount: string;
  advanceRecovery: string;
  taxableBase: string;
  taxTotal: string;
  grossTotal: string;
  withholdingExpected: string;
  taxOnAdvanceAtReceipt: boolean;
  authorityCode: string;
  registrationNumber: string;
  dueDate: string;
}

export interface Advance {
  id: string;
  projectId: string;
  invoiceId: string | null;
  amount: string;
  receivedOn: string | null;
  applied: string;
  status: BillingAdvanceStatus;
  version: number;
}

export interface CreditNote {
  id: string;
  number: string | null;
  invoiceId: string;
  reason: string;
  baseAmount: string;
  advanceRestored: string;
  taxTotal: string;
  grossTotal: string;
  issuedOn: string | null;
  status: CreditNoteStatus;
  approval: { status: string; requestId: string | null; currentRole: string | null };
  version: number;
}

export interface BillingSummary {
  projectId: string;
  originalContractValue: string;
  contractValue: string;
  netBilled: string;
  remainingToBill: string;
  unappliedAdvance: string;
  plannedStages: string;
  invoices: number;
  advances: Advance[];
}

export interface InvoiceBody {
  scheduleIds: string[];
  invoiceDate: string;
  paymentDays?: number;
  notes?: string;
  supplyKind?: SupplyKind;
  nature?: string;
}

export const billingApi = {
  schedule: (projectId: string) => request<Schedule>('GET', `/billing/schedule/${projectId}`),
  editSchedule: (projectId: string, stages: StageEdit[]) =>
    request<Schedule>('PUT', `/billing/schedule/${projectId}`, { stages }),
  summary: (projectId: string) =>
    request<BillingSummary>('GET', `/billing/projects/${projectId}/summary`),
  invoices: (query: { projectId?: string; status?: string }) => {
    const params = new URLSearchParams({ limit: '200' });
    if (query.projectId !== undefined) params.set('projectId', query.projectId);
    if (query.status !== undefined && query.status !== '') params.set('status', query.status);
    return request<Page<InvoiceHeader>>('GET', `/billing/invoices?${params.toString()}`);
  },
  invoice: (id: string) => request<Invoice>('GET', `/billing/invoices/${id}`),
  createInvoice: (projectId: string, body: InvoiceBody) =>
    request<Invoice>('POST', '/billing/invoices', { projectId, ...body }),
  preview: (id: string) => request<InvoicePreview>('GET', `/billing/invoices/${id}/preview`),
  submit: (id: string, version: number) =>
    request<Invoice>('POST', `/billing/invoices/${id}/submit`, { version }),
  issue: (id: string, version: number) =>
    request<Invoice>('POST', `/billing/invoices/${id}/issue`, { version }),
  cancel: (id: string, version: number) =>
    request<Invoice>('DELETE', `/billing/invoices/${id}?version=${version}`),
  pdf: async (id: string): Promise<Blob> =>
    (await rawRequest('GET', `/billing/invoices/${id}/pdf`)).blob(),
  requestAdvance: (body: { projectId: string; amount: string; invoiceDate: string }) =>
    request<{ advance: Advance; invoice: Invoice }>('POST', '/billing/advances', body),
  creditNotes: (invoiceId: string) =>
    request<CreditNote[]>('GET', `/billing/invoices/${invoiceId}/credit-notes`),
  createCreditNote: (invoiceId: string, body: { reason: string; baseAmount?: string }) =>
    request<CreditNote>('POST', `/billing/invoices/${invoiceId}/credit-notes`, body),
  cancelByCreditNote: (invoiceId: string, reason: string) =>
    request<CreditNote>('POST', `/billing/invoices/${invoiceId}/cancel-by-credit-note`, { reason }),
  submitCreditNote: (id: string, version: number) =>
    request<CreditNote>('POST', `/billing/credit-notes/${id}/submit`, { version }),
  issueCreditNote: (id: string, version: number) =>
    request<CreditNote>('POST', `/billing/credit-notes/${id}/issue`, { version }),
};

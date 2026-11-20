import type {
  AllocationKind,
  FollowupStatus,
  PdcStatus,
  ReceiptMethod,
  ReceiptStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface OpenInvoice {
  invoiceId: string;
  number: string | null;
  projectId: string;
  partyId: string;
  invoiceDate: string;
  dueDate: string;
  gross: string;
  outstanding: string;
  pending: string;
  allocatable: string;
  withholdingExpected: string;
  withholdingAllocated: string;
}

export interface Allocation {
  id: string;
  receiptId: string;
  invoiceId: string;
  advanceId: string | null;
  amount: string;
  kind: AllocationKind;
}

export interface Receipt {
  id: string;
  number: string;
  partyId: string;
  receiptDate: string;
  method: ReceiptMethod;
  amount: string;
  status: ReceiptStatus;
  withheldAmount: string;
  unallocated: string;
  allocations: Allocation[];
  withholdingFlags: {
    invoiceId: string;
    expected: string;
    actual: string;
    difference: string;
    flagged: boolean;
  }[];
  version: number;
}

export interface Pdc {
  id: string;
  receiptId: string;
  partyId: string;
  chequeNumber: string;
  bankName: string;
  drawer: string | null;
  chequeDate: string;
  amount: string;
  status: PdcStatus;
  version: number;
}

export interface PdcRegister {
  items: Pdc[];
  upcoming: Pdc[];
  totalInHand: string;
  byStatus: Record<string, { count: number; total: string }>;
}

export interface CustomerBalance {
  partyId: string;
  date: string;
  invoiced: string;
  credited: string;
  receipts: string;
  withholding: string;
  adjustments: string;
  balance: string;
  unallocatedReceipts: string;
  unappliedAdvances: string;
  credit: string;
}

export interface CustomerLedger {
  balance: CustomerBalance;
  openInvoices: OpenInvoice[];
  receipts: Page<Receipt>;
}

export interface StatementLine {
  date: string;
  kind: 'invoice' | 'credit_note' | 'receipt' | 'withholding' | 'adjustment';
  reference: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface Statement {
  partyId: string;
  from: string;
  to: string;
  opening: string;
  lines: StatementLine[];
  closing: string;
}

export interface Aging {
  asOf: string;
  groupBy: 'customer' | 'project';
  labels: string[];
  rows: { key: string; label: string; buckets: string[]; total: string }[];
  totals: string[];
  total: string;
}

export interface Followup {
  id: string;
  partyId: string;
  invoiceId: string | null;
  pdcId: string | null;
  dueDate: string;
  note: string;
  status: FollowupStatus;
  version: number;
}

export interface ReceiptBody {
  partyId: string;
  receiptDate: string;
  method: ReceiptMethod;
  amount: string;
  accountId?: string;
  reference?: string;
  withheldAmount?: string;
  withholdingCertificateRef?: string;
  cheque?: { chequeNumber: string; bankName: string; chequeDate: string };
  allocations?: { kind: AllocationKind; invoiceId: string; amount: string }[];
}

export const receivablesApi = {
  openInvoices: (partyId: string) =>
    request<OpenInvoice[]>('GET', `/receivables/customers/${partyId}/open-invoices`),
  suggest: (partyId: string, amount: string) =>
    request<{ invoiceId: string; amount: string }[]>(
      'GET',
      `/receivables/customers/${partyId}/suggest-allocation?amount=${encodeURIComponent(amount)}`,
    ),
  createReceipt: (body: ReceiptBody) => request<Receipt>('POST', '/receivables/receipts', body),
  ledger: (partyId: string) =>
    request<CustomerLedger>('GET', `/receivables/customers/${partyId}/ledger`),
  statement: (partyId: string, from: string, to: string) =>
    request<Statement>('GET', `/receivables/customers/${partyId}/statement?from=${from}&to=${to}`),
  aging: (asOf: string, groupBy: 'customer' | 'project') =>
    request<Aging>('GET', `/receivables/aging?asOf=${asOf}&groupBy=${groupBy}`),
  pdcs: (status?: PdcStatus) =>
    request<PdcRegister>(
      'GET',
      `/receivables/pdcs${status === undefined ? '' : `?status=${status}`}`,
    ),
  deposit: (pdc: Pdc, accountId: string, overrideReason?: string) =>
    request<Pdc>('POST', `/receivables/pdcs/${pdc.id}/deposit`, {
      accountId,
      version: pdc.version,
      ...(overrideReason === undefined || overrideReason === '' ? {} : { overrideReason }),
    }),
  clear: (pdc: Pdc) =>
    request<Pdc>('POST', `/receivables/pdcs/${pdc.id}/clear`, { version: pdc.version }),
  bounce: (pdc: Pdc, reason: string) =>
    request<Pdc>('POST', `/receivables/pdcs/${pdc.id}/bounce`, { reason, version: pdc.version }),
  giveBack: (pdc: Pdc) =>
    request<Pdc>('POST', `/receivables/pdcs/${pdc.id}/return`, { version: pdc.version }),
  replace: (pdc: Pdc, cheque: { chequeNumber: string; bankName: string; chequeDate: string }) =>
    request<Pdc>('POST', `/receivables/pdcs/${pdc.id}/replace`, { cheque, version: pdc.version }),
  followups: () => request<Followup[]>('GET', '/receivables/followups?status=open'),
  createFollowup: (body: { partyId: string; dueDate: string; note: string }) =>
    request<Followup>('POST', '/receivables/followups', body),
  finishFollowup: (followup: Followup) =>
    request<Followup>('PUT', `/receivables/followups/${followup.id}`, {
      status: 'done',
      version: followup.version,
    }),
};

import type {
  BillSourceType,
  BillStatus,
  PaymentMethod,
  PaymentStatus,
  VarianceTreatment,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface BillLine {
  id: string;
  lineNo: number;
  grnLineId: string | null;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  costObjectType: 'project' | 'work_order' | 'overhead';
  costObjectId: string | null;
  costCodeId: string;
}

export interface Match {
  billLineId: string;
  poRate: string;
  grnQty: string;
  billedQty: string;
  billedRate: string;
  qtyVariance: string;
  rateVariance: string;
  withinTolerance: boolean;
}

export interface Variance {
  id: string;
  billLineId: string;
  amount: string;
  treatment: VarianceTreatment;
}

export interface Bill {
  id: string;
  number: string;
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  sourceType: BillSourceType;
  status: BillStatus;
  supplyKind: 'goods' | 'services';
  nature: string;
  locationId: string | null;
  baseAmount: string;
  taxTotal: string;
  grossTotal: string;
  withholdingTotal: string;
  netPayable: string;
  notes: string | null;
  matchOverrideReason: string | null;
  lines: BillLine[];
  matches: Match[];
  variances: Variance[];
  allocated: string;
  outstanding: string;
  warnings: string[];
  approval: { status: string; requestId: string | null; currentRole: string | null };
  version: number;
}

export interface BillBody {
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  sourceType: Exclude<BillSourceType, 'opening'>;
  supplyKind?: 'goods' | 'services';
  nature?: string;
  locationId?: string;
  notes?: string;
  lines: {
    grnId?: string;
    grnLineId?: string;
    description?: string;
    quantity: string;
    rate: string;
    costObjectType?: 'project' | 'work_order' | 'overhead';
    costObjectId?: string;
    costCodeId?: string;
  }[];
}

export interface Allocation {
  id: string;
  billId: string;
  amount: string;
  withholding: string;
}

export interface Payment {
  id: string;
  number: string;
  vendorPartyId: string;
  paymentDate: string;
  method: PaymentMethod;
  amount: string;
  withholdingDeducted: string;
  accountId: string;
  chequeNumber: string | null;
  chequeDate: string | null;
  status: PaymentStatus;
  withholdingCertificateNo: string | null;
  allocations: Allocation[];
  version: number;
}

export interface PaymentBody {
  vendorPartyId: string;
  paymentDate: string;
  method: PaymentMethod;
  accountId: string;
  chequeNumber?: string;
  chequeDate?: string;
  reference?: string;
  allocations: { billId: string; amount: string }[];
}

export interface PaymentRun {
  id: string;
  runDate: string;
  total: string;
  payments: Payment[];
}

export interface OpenBill {
  billId: string;
  number: string;
  vendorInvoiceNo: string;
  vendorPartyId: string;
  billDate: string;
  dueDate: string;
  gross: string;
  withholdingTotal: string;
  allocated: string;
  withheld: string;
  outstanding: string;
}

export interface VendorBalance {
  partyId: string;
  date: string;
  netPayable: string;
  withholdingPayable: string;
  payments: string;
  balance: string;
}

export interface VendorLedger {
  partyId: string;
  date: string;
  balance: VendorBalance;
  lines: {
    date: string;
    kind: 'bill' | 'payment';
    reference: string;
    documentId: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
  openBills: OpenBill[];
}

export interface Aging {
  asOf: string;
  labels: string[];
  rows: { key: string; buckets: string[]; total: string }[];
  totals: string[];
  total: string;
}

export interface WithholdingReport {
  rows: {
    authorityCode: string;
    month: string;
    vendorPartyId: string;
    paymentId: string;
    paymentNumber: string;
    billId: string;
    billNumber: string;
    amount: string;
    certificateNo: string | null;
  }[];
  totals: { authorityCode: string; month: string; amount: string }[];
}

/** What the pick list reads from procurement: an order of the vendor and its receipts. */
export interface PickOrder {
  id: string;
  number: string;
  vendorId: string;
  projectId: string | null;
  status: string;
  lines: { id: string; lineNo: number; description: string; rate: string; costCodeId: string }[];
}

export interface PickReceipt {
  id: string;
  number: string;
  poId: string;
  receivedOn: string;
  status: string;
  lines: { id: string; poLineId: string; acceptedQty: string }[];
}

const base = '/payables';
const query = (params: Record<string, string | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
};

export const payablesApi = {
  bills: (status?: BillStatus, vendorPartyId?: string) =>
    request<Page<Bill>>('GET', `${base}/bills${query({ status, vendorPartyId, limit: '200' })}`),
  bill: (id: string) => request<Bill>('GET', `${base}/bills/${id}`),
  createBill: (body: BillBody) => request<Bill>('POST', `${base}/bills`, body),
  updateBill: (bill: Bill, body: BillBody) =>
    request<Bill>('PUT', `${base}/bills/${bill.id}`, { ...body, version: bill.version }),
  match: (bill: Bill, overrideReason?: string) =>
    request<Bill>('POST', `${base}/bills/${bill.id}/match`, {
      version: bill.version,
      ...(overrideReason === undefined || overrideReason.trim() === ''
        ? {}
        : { overrideReason: overrideReason.trim() }),
    }),
  billAction: (bill: Bill, action: 'submit' | 'post') =>
    request<Bill>('POST', `${base}/bills/${bill.id}/${action}`, { version: bill.version }),
  cancelBill: (bill: Bill, reason: string) =>
    request<Bill>('POST', `${base}/bills/${bill.id}/cancel`, { reason, version: bill.version }),
  openBills: (vendorId: string) =>
    request<OpenBill[]>('GET', `${base}/vendors/${vendorId}/open-bills`),
  payments: (status?: PaymentStatus) =>
    request<Page<Payment>>('GET', `${base}/payments${query({ status, limit: '200' })}`),
  createPayment: (body: PaymentBody) => request<Payment>('POST', `${base}/payments`, body),
  paymentAction: (payment: Payment, action: 'submit' | 'pay') =>
    request<Payment>('POST', `${base}/payments/${payment.id}/${action}`, {
      version: payment.version,
    }),
  cancelPayment: (payment: Payment, reason: string) =>
    request<Payment>('POST', `${base}/payments/${payment.id}/cancel`, {
      reason,
      version: payment.version,
    }),
  certificate: (payment: Payment, certificateNo: string) =>
    request<Payment>('PUT', `${base}/payments/${payment.id}/certificate`, {
      certificateNo,
      version: payment.version,
    }),
  createRun: (body: {
    billIds: string[];
    paymentDate: string;
    method: PaymentMethod;
    accountId: string;
    chequeNumbers?: string[];
    chequeDate?: string;
    note?: string;
  }) => request<PaymentRun>('POST', `${base}/payment-runs`, body),
  ledger: (vendorId: string) => request<VendorLedger>('GET', `${base}/vendors/${vendorId}/ledger`),
  aging: (asOf: string) => request<Aging>('GET', `${base}/aging?asOf=${asOf}`),
  withholding: (month: string, authorityCode?: string) =>
    request<WithholdingReport>(
      'GET',
      `${base}/withholding-report${query({ month, authorityCode })}`,
    ),
  vendorOrders: (vendorId: string) =>
    request<Page<{ id: string; number: string }>>(
      'GET',
      `/procurement/purchase-orders?vendorId=${vendorId}&limit=200`,
    ),
  order: (id: string) => request<PickOrder>('GET', `/procurement/purchase-orders/${id}`),
  orderReceipts: (poId: string) =>
    request<Page<{ id: string }>>('GET', `/procurement/grns?poId=${poId}&status=posted&limit=200`),
  receipt: (id: string) => request<PickReceipt>('GET', `/procurement/grns/${id}`),
};

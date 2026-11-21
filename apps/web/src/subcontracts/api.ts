import type {
  CertificateBasis,
  CertificateStatus,
  SubVariationStatus,
  WorkOrderStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Amounts are null for someone without the amount permission (BR-9). */
export type Amount = string | null;

export interface Approval {
  status: string;
  requestId: string | null;
  currentRole: string | null;
}

export interface Variation {
  id: string;
  seq: number;
  amount: Amount;
  reason: string;
  status: SubVariationStatus;
  decidedOn: string | null;
  decisionNote: string | null;
  version: number;
}

export interface WorkOrderHeader {
  id: string;
  number: string;
  projectId: string;
  partyId: string;
  title: string;
  status: WorkOrderStatus;
  contractAmount: Amount;
  currentContractAmount: Amount;
  certifiedAmount: Amount;
  committedAmount: Amount;
  startDate: string | null;
  endDate: string | null;
  version: number;
}

export interface WorkOrder extends WorkOrderHeader {
  scopeText: string;
  costCodeId: string;
  retentionPercent: string;
  closedOn: string | null;
  closeReason: string | null;
  variations: Variation[];
  approval: Approval;
}

export interface WorkOrderBody {
  projectId: string;
  partyId: string;
  title: string;
  scopeText?: string;
  contractAmount: string;
  costCodeId: string;
  startDate?: string;
  endDate?: string;
}

export interface BackCharge {
  id: string;
  workOrderId: string;
  certificateId: string | null;
  description: string;
  amount: Amount;
  recoversCost: boolean;
  costCodeId: string | null;
  version: number;
}

export interface BackChargeBody {
  description: string;
  amount: string;
  recoversCost?: boolean;
  costCodeId?: string;
  certificateId?: string | null;
}

export interface Certificate {
  id: string;
  number: string;
  workOrderId: string;
  certificateDate: string;
  basis: CertificateBasis;
  cumulativePercent: string;
  cumulativeAmount: Amount;
  thisCertificateAmount: Amount;
  deductions: Amount;
  netCertified: Amount;
  status: CertificateStatus;
  certifiedBy: string | null;
  certifiedOn: string | null;
  notes: string | null;
  billId: string | null;
  backCharges: BackCharge[];
  approval: Approval;
  version: number;
}

export interface CertificateBody {
  certificateDate: string;
  basis: CertificateBasis;
  cumulativePercent?: string;
  cumulativeAmount?: string;
  notes?: string;
}

export interface Ledger {
  workOrderId: string;
  number: string;
  contract: string;
  certified: string;
  deductions: string;
  billed: string;
  paid: string;
  committed: string;
  certificates: {
    certificateId: string;
    number: string;
    status: CertificateStatus;
    gross: string;
    deductions: string;
    net: string;
    paid: string;
  }[];
}

export interface Statement {
  partyId: string;
  orders: {
    workOrderId: string;
    number: string;
    title: string;
    status: WorkOrderStatus;
    contract: string;
    certified: string;
    deductions: string;
    billed: string;
    paid: string;
  }[];
  totals: { contract: string; certified: string; deductions: string; billed: string; paid: string };
}

const base = '/subcontracts';

export const subcontractsApi = {
  orders: (status?: WorkOrderStatus) =>
    request<Page<WorkOrderHeader>>(
      'GET',
      `${base}/work-orders?limit=200${status === undefined ? '' : `&status=${status}`}`,
    ),
  order: (id: string) => request<WorkOrder>('GET', `${base}/work-orders/${id}`),
  createOrder: (body: WorkOrderBody) => request<WorkOrder>('POST', `${base}/work-orders`, body),
  orderAction: (order: WorkOrderHeader, action: 'submit' | 'cancel') =>
    request<WorkOrder>('POST', `${base}/work-orders/${order.id}/${action}`, {
      version: order.version,
    }),
  closeOrder: (order: WorkOrderHeader, reason: string) =>
    request<WorkOrder>('POST', `${base}/work-orders/${order.id}/close`, {
      version: order.version,
      ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
    }),
  addVariation: (orderId: string, body: { amount: string; reason: string }) =>
    request<Variation>('POST', `${base}/work-orders/${orderId}/variations`, body),
  decideVariation: (variation: Variation, decision: 'approve' | 'reject') =>
    request<Variation>('POST', `${base}/variations/${variation.id}/${decision}`, {
      version: variation.version,
    }),
  certificates: (orderId: string) =>
    request<Certificate[]>('GET', `${base}/work-orders/${orderId}/certificates`),
  certificate: (id: string) => request<Certificate>('GET', `${base}/certificates/${id}`),
  createCertificate: (orderId: string, body: CertificateBody) =>
    request<Certificate>('POST', `${base}/work-orders/${orderId}/certificates`, body),
  updateCertificate: (certificate: Certificate, body: CertificateBody) =>
    request<Certificate>('PUT', `${base}/certificates/${certificate.id}`, {
      ...body,
      version: certificate.version,
    }),
  certificateAction: (certificate: Certificate, action: 'submit' | 'cancel') =>
    request<Certificate>('POST', `${base}/certificates/${certificate.id}/${action}`, {
      version: certificate.version,
    }),
  billCertificate: (
    certificate: Certificate,
    body: { vendorInvoiceNo: string; billDate: string; dueDate: string },
  ) =>
    request<{ certificate: Certificate; bill: { id: string; number: string } }>(
      'POST',
      `${base}/certificates/${certificate.id}/bill`,
      body,
    ),
  backCharges: (orderId: string) =>
    request<BackCharge[]>('GET', `${base}/work-orders/${orderId}/back-charges`),
  addBackCharge: (orderId: string, body: BackChargeBody) =>
    request<BackCharge>('POST', `${base}/work-orders/${orderId}/back-charges`, body),
  ledger: (orderId: string) => request<Ledger>('GET', `${base}/work-orders/${orderId}/ledger`),
  statement: (partyId: string) =>
    request<Statement>('GET', `${base}/subcontractors/${partyId}/statement`),
};

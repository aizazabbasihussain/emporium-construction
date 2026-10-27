import type {
  DestinationType,
  GrnStatus,
  PurchaseOrderStatus,
  RequisitionStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Approval {
  status: string;
  requestId: string | null;
  currentRole: string | null;
}

export interface RequisitionLine {
  id: string;
  lineNo: number;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  costCodeId: string;
  estimatedRate: string | null;
  orderedQty: string;
}

export interface RequisitionHeader {
  id: string;
  number: string;
  projectId: string | null;
  storeId: string | null;
  requestedBy: string;
  requiredBy: string | null;
  status: RequisitionStatus;
  note: string;
  version: number;
}

export interface Requisition extends RequisitionHeader {
  lines: RequisitionLine[];
  approval: Approval;
}

/** What a requisition or order line editor works with; amounts stay text. */
export interface LineDraft {
  lineId?: string | undefined;
  itemId: string;
  quantity: string;
  rate: string;
  costCodeId: string;
}

export interface RequisitionBody {
  projectId?: string | undefined;
  storeId?: string | undefined;
  requiredBy?: string | undefined;
  note?: string | undefined;
  lines: { itemId: string; quantity: string; costCodeId: string; estimatedRate?: string }[];
}

export interface QuoteLine {
  requisitionLineId: string;
  rate: string;
}

export interface Quote {
  id: string;
  rfqId: string;
  vendorId: string;
  validUntil: string | null;
  deliveryDays: number | null;
  terms: string;
  total: string;
  lines: QuoteLine[];
  version: number;
}

export interface Comparison {
  lines: {
    requisitionLineId: string;
    lineNo: number;
    quantity: string;
    ranking: { quoteId: string; vendorId: string; rate: string; rank: number }[];
  }[];
  totals: { quoteId: string; vendorId: string; total: string; complete: boolean; rank: number }[];
}

export interface Rfq {
  id: string;
  requisitionId: string;
  number: string;
  status: 'open' | 'closed';
  vendorIds: string[];
  version: number;
  quotes: Quote[];
  selections: {
    requisitionLineId: string;
    quoteId: string;
    vendorId: string;
    reason: string | null;
  }[];
  comparison: Comparison;
}

export interface PoLine {
  id: string;
  lineNo: number;
  itemId: string;
  quantity: string;
  unitCode: string;
  rate: string;
  lineTotal: string;
  costCodeId: string;
  receivedQty: string;
}

export interface PoHeader {
  id: string;
  number: string;
  revision: number;
  vendorId: string;
  requisitionId: string | null;
  destinationType: DestinationType;
  projectId: string | null;
  storeId: string | null;
  orderDate: string;
  expectedDate: string | null;
  status: PurchaseOrderStatus;
  total: string;
  terms: string;
  version: number;
}

export interface PurchaseOrder extends PoHeader {
  lines: PoLine[];
  approval: Approval;
}

export interface OpenLine {
  poId: string;
  poNumber: string;
  vendorId: string;
  lineId: string;
  lineNo: number;
  itemId: string;
  orderedQty: string;
  receivedQty: string;
  openQty: string;
  rate: string;
  expectedDate: string | null;
}

export interface PoBody {
  vendorId: string;
  projectId?: string | undefined;
  storeId?: string | undefined;
  orderDate: string;
  expectedDate?: string | undefined;
  terms?: string | undefined;
  lines: {
    lineId?: string | undefined;
    itemId: string;
    quantity: string;
    rate: string;
    costCodeId: string;
  }[];
}

export interface PrintModel {
  number: string;
  revision: number;
  vendor: { name: string; address: string | null; phone: string | null };
  terms: string;
  total: string;
}

export interface GrnHeader {
  id: string;
  number: string;
  poId: string;
  receivedOn: string;
  receivedBy: string;
  deliveryNoteRef: string | null;
  status: GrnStatus;
  version: number;
}

export interface GrnBody {
  poId: string;
  receivedOn: string;
  deliveryNoteRef?: string | undefined;
  lines: { poLineId: string; acceptedQty: string; rejectedQty?: string }[];
  photos: { fileName: string; contentBase64: string }[];
}

const base = '/procurement';

export const procurementApi = {
  requisitions: () => request<Page<RequisitionHeader>>('GET', `${base}/requisitions?limit=200`),
  requisition: (id: string) => request<Requisition>('GET', `${base}/requisitions/${id}`),
  createRequisition: (body: RequisitionBody) =>
    request<Requisition>('POST', `${base}/requisitions`, body),
  requisitionAction: (id: string, action: 'submit' | 'cancel', version: number) =>
    request<Requisition>('POST', `${base}/requisitions/${id}/${action}`, { version }),
  createRfq: (requisitionId: string, vendorIds: string[]) =>
    request<Rfq>('POST', `${base}/rfqs`, { requisitionId, vendorIds }),
  rfqs: (requisitionId: string) =>
    request<Page<{ id: string; number: string; status: string }>>(
      'GET',
      `${base}/rfqs?requisitionId=${requisitionId}`,
    ),
  rfq: (id: string) => request<Rfq>('GET', `${base}/rfqs/${id}`),
  closeRfq: (id: string, version: number) =>
    request<Rfq>('POST', `${base}/rfqs/${id}/close`, { version }),
  addQuote: (rfqId: string, vendorId: string, lines: QuoteLine[]) =>
    request<Quote>('POST', `${base}/quotes`, { rfqId, vendorId, lines }),
  selectVendor: (rfqId: string, requisitionLineId: string, quoteId: string, reason?: string) =>
    request<Rfq>('POST', `${base}/rfqs/${rfqId}/select-vendor`, {
      requisitionLineId,
      quoteId,
      ...(reason === undefined ? {} : { reason }),
    }),
  orders: (status?: PurchaseOrderStatus) =>
    request<Page<PoHeader>>(
      'GET',
      `${base}/purchase-orders?limit=200${status === undefined ? '' : `&status=${status}`}`,
    ),
  order: (id: string) => request<PurchaseOrder>('GET', `${base}/purchase-orders/${id}`),
  printModel: (id: string) => request<PrintModel>('GET', `${base}/po/${id}/print-model`),
  openLines: () => request<OpenLine[]>('GET', `${base}/open-po-lines`),
  createOrder: (body: PoBody) => request<PurchaseOrder>('POST', `${base}/purchase-orders`, body),
  orderFromRfq: (rfqId: string, vendorId: string, orderDate: string) =>
    request<PurchaseOrder>('POST', `${base}/purchase-orders/from-rfq`, {
      rfqId,
      vendorId,
      orderDate,
    }),
  updateOrder: (id: string, version: number, body: PoBody) =>
    request<PurchaseOrder>('PUT', `${base}/purchase-orders/${id}`, { ...body, version }),
  amendOrder: (id: string, version: number, body: PoBody) =>
    request<PurchaseOrder>('POST', `${base}/purchase-orders/${id}/amend`, { ...body, version }),
  orderAction: (id: string, action: 'submit' | 'close' | 'cancel', version: number) =>
    request<PurchaseOrder>('POST', `${base}/purchase-orders/${id}/${action}`, { version }),
  grns: () => request<Page<GrnHeader>>('GET', `${base}/grns?limit=200`),
  receive: (body: GrnBody) => request<GrnHeader>('POST', `${base}/grns`, body),
  cancelGrn: (id: string, version: number, reason: string) =>
    request<GrnHeader>('POST', `${base}/grns/${id}/cancel`, { version, reason }),
};

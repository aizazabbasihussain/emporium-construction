import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  GrnStatus,
  PurchaseOrderStatus,
  RequisitionStatus,
} from '@emporium/domain/procurement';
import type { DestinationType } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db, GrnStatus, PurchaseOrderStatus, RequisitionStatus };

/** Who is acting; a supervisor reaches only the projects assigned to them (BR-12). */
export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApprovalSummary {
  status: string;
  requestId: string | null;
  currentRole: string | null;
}

export interface RequisitionLineDto {
  id: string;
  lineNo: number;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  costCodeId: string;
  estimatedRate: string | null;
  /** Quantity already on active purchase orders. */
  orderedQty: string;
}

export interface RequisitionHeaderDto {
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

export interface RequisitionDto extends RequisitionHeaderDto {
  lines: RequisitionLineDto[];
  approval: ApprovalSummary;
}

export interface RfqHeaderDto {
  id: string;
  requisitionId: string;
  number: string;
  status: 'open' | 'closed';
  vendorIds: string[];
  version: number;
}

export interface QuoteDto {
  id: string;
  rfqId: string;
  vendorId: string;
  validUntil: string | null;
  deliveryDays: number | null;
  terms: string;
  total: string;
  lines: { requisitionLineId: string; rate: string }[];
  version: number;
}

export interface SelectionDto {
  requisitionLineId: string;
  quoteId: string;
  vendorId: string;
  reason: string | null;
}

/** BR-2: the comparison sheet. */
export interface ComparisonDto {
  lines: {
    requisitionLineId: string;
    lineNo: number;
    quantity: string;
    ranking: { quoteId: string; vendorId: string; rate: string; rank: number }[];
  }[];
  totals: { quoteId: string; vendorId: string; total: string; complete: boolean; rank: number }[];
}

export interface RfqDto extends RfqHeaderDto {
  quotes: QuoteDto[];
  selections: SelectionDto[];
  comparison: ComparisonDto;
}

export interface PoLineDto {
  id: string;
  lineNo: number;
  requisitionLineId: string | null;
  itemId: string;
  description: string;
  quantity: string;
  unitCode: string;
  rate: string;
  lineTotal: string;
  costCodeId: string;
  receivedQty: string;
}

export interface PoHeaderDto {
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

export interface PoDto extends PoHeaderDto {
  lines: PoLineDto[];
  approval: ApprovalSummary;
}

/** `listOpenPoLines` (spec section 2): what is still to be delivered. */
export interface OpenPoLineDto {
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
  destinationType: DestinationType;
  projectId: string | null;
  storeId: string | null;
}

export interface PrintModelDto {
  number: string;
  revision: number;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDate: string | null;
  vendor: { id: string; name: string; address: string | null; phone: string | null };
  destination: { type: DestinationType; projectId: string | null; storeId: string | null };
  terms: string;
  lines: Pick<
    PoLineDto,
    'lineNo' | 'itemId' | 'description' | 'quantity' | 'unitCode' | 'rate' | 'lineTotal'
  >[];
  total: string;
}

export interface GrnLineDto {
  id: string;
  poLineId: string;
  acceptedQty: string;
  rejectedQty: string;
  note: string;
  costAmount: string;
}

export interface GrnHeaderDto {
  id: string;
  number: string;
  poId: string;
  receivedOn: string;
  receivedBy: string;
  deliveryNoteRef: string | null;
  status: GrnStatus;
  cancelReason: string | null;
  version: number;
}

export interface GrnDto extends GrnHeaderDto {
  lines: GrnLineDto[];
}

/** The payload of `goods.received` (spec section 2). */
export interface GoodsReceivedPayload {
  grnId: string;
  grnNumber: string;
  poId: string;
  lines: {
    grnLineId: string;
    itemId: string;
    quantity: string;
    unitCost: string;
    costCodeId: string;
  }[];
  destinationType: DestinationType;
  storeId: string | null;
  projectId: string | null;
  ownership: 'company';
}

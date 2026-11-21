import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  BillSourceType,
  BillStatus,
  PaymentMethod,
  PaymentStatus,
  VarianceTreatment,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

/** The system acts on schedules: no user. */
export interface SystemActor {
  userId: null;
  requestId: null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CostObjectRef {
  type: 'project' | 'work_order' | 'overhead';
  id: string | null;
}

export interface BillLineDto {
  id: string;
  lineNo: number;
  sourceDocType: string | null;
  sourceDocId: string | null;
  poLineId: string | null;
  grnLineId: string | null;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  costObjectType: CostObjectRef['type'];
  costObjectId: string | null;
  costCodeId: string;
  costEntryId: string | null;
}

export interface MatchDto {
  billLineId: string;
  poRate: string;
  grnQty: string;
  billedQty: string;
  billedRate: string;
  qtyVariance: string;
  rateVariance: string;
  withinTolerance: boolean;
}

export interface VarianceDto {
  id: string;
  billLineId: string;
  costObjectType: CostObjectRef['type'];
  costObjectId: string | null;
  amount: string;
  treatment: VarianceTreatment;
  ledgerEntryId: string;
  reversedOn: string | null;
}

export interface BillHeaderDto {
  id: string;
  number: string;
  vendorPartyId: string;
  vendorInvoiceNo: string;
  billDate: string;
  dueDate: string;
  sourceType: BillSourceType;
  sourceDocId: string | null;
  status: BillStatus;
  supplyKind: 'goods' | 'services';
  nature: string;
  locationId: string | null;
  baseAmount: string;
  taxTotal: string;
  grossTotal: string;
  withholdingTotal: string;
  netPayable: string;
  authorityCode: string | null;
  notes: string | null;
  matchOverrideReason: string | null;
  postedOn: string | null;
  cancelledOn: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  version: number;
}

export interface BillDto extends BillHeaderDto {
  lines: BillLineDto[];
  matches: MatchDto[];
  variances: VarianceDto[];
  /** Gross counted as paid so far (payments that count). */
  allocated: string;
  outstanding: string;
  /** BR-2: non-blocking notes, for example `above_open_commitments`. */
  warnings: string[];
  taxSnapshot: unknown;
  approval: { status: string; requestId: string | null; currentRole: string | null };
}

export interface AllocationDto {
  id: string;
  paymentId: string;
  billId: string;
  amount: string;
  withholding: string;
}

export interface PaymentDto {
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
  approvalRequestId: string | null;
  approvalDocId: string | null;
  runId: string | null;
  reference: string | null;
  withholdingCertificateNo: string | null;
  paidOn: string | null;
  cashbookTxnId: string | null;
  reversalTxnId: string | null;
  cancelledOn: string | null;
  cancelReason: string | null;
  allocations: AllocationDto[];
  version: number;
}

export interface PaymentRunDto {
  id: string;
  runDate: string;
  total: string;
  payments: PaymentDto[];
}

export interface OpenBillDto {
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
  /** Gross still owed on the bill. */
  outstanding: string;
}

export interface VendorBalanceDto {
  partyId: string;
  date: string;
  netPayable: string;
  /** BR-9: shown apart, never netted silently. */
  withholdingPayable: string;
  payments: string;
  balance: string;
}

export interface VendorLedgerLineDto {
  date: string;
  kind: 'bill' | 'payment';
  reference: string;
  documentId: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface VendorLedgerDto {
  partyId: string;
  date: string;
  balance: VendorBalanceDto;
  lines: VendorLedgerLineDto[];
  openBills: OpenBillDto[];
}

export interface AgingReportDto {
  asOf: string;
  labels: string[];
  rows: { key: string; buckets: string[]; total: string }[];
  totals: string[];
  total: string;
}

export interface WithholdingRowDto {
  authorityCode: string;
  month: string;
  vendorPartyId: string;
  paymentId: string;
  paymentNumber: string;
  billId: string;
  billNumber: string;
  amount: string;
  certificateNo: string | null;
}

export interface WithholdingReportDto {
  rows: WithholdingRowDto[];
  /** Per authority and month, the total the accountant files. */
  totals: { authorityCode: string; month: string; amount: string }[];
}

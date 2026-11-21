import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  CertificateStatus,
  VariationStatus,
  WorkOrderStatus,
} from '@emporium/domain/subcontracts';
import type { CertificateBasis } from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { CertificateBasis, CertificateStatus, Db, VariationStatus, WorkOrderStatus };

/** Who is acting; a supervisor reaches only the projects assigned to them. */
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

/** Money fields are null for someone without `subcontracts.amount.read` (BR-9). */
export type Amount = string | null;

export interface ApprovalDto {
  status: string;
  requestId: string | null;
  currentRole: string | null;
}

export interface WorkOrderVariationDto {
  id: string;
  seq: number;
  amount: Amount;
  reason: string;
  status: VariationStatus;
  decidedOn: string | null;
  decisionNote: string | null;
  version: number;
}

export interface WorkOrderHeaderDto {
  id: string;
  number: string;
  projectId: string;
  partyId: string;
  title: string;
  status: WorkOrderStatus;
  contractAmount: Amount;
  /** The contract including approved variations (BR-2). */
  currentContractAmount: Amount;
  /** The cumulative gross of the certified certificates. */
  certifiedAmount: Amount;
  /** What is still committed on the project's cost ledger. */
  committedAmount: Amount;
  startDate: string | null;
  endDate: string | null;
  version: number;
}

export interface WorkOrderDto extends WorkOrderHeaderDto {
  scopeText: string;
  costCodeId: string;
  retentionPercent: string;
  closedOn: string | null;
  closeReason: string | null;
  variations: WorkOrderVariationDto[];
  approval: ApprovalDto;
}

export interface BackChargeDto {
  id: string;
  workOrderId: string;
  certificateId: string | null;
  description: string;
  amount: Amount;
  recoversCost: boolean;
  costCodeId: string | null;
  version: number;
}

export interface CertificateDto {
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
  backCharges: BackChargeDto[];
  approval: ApprovalDto;
  version: number;
}

export interface LedgerCertificateDto {
  certificateId: string;
  number: string;
  status: CertificateStatus;
  gross: string;
  deductions: string;
  net: string;
  paid: string;
}

/** `GET /subcontracts/work-orders/:id/ledger`: contract, certified, billed and paid. */
export interface WorkOrderLedgerDto {
  workOrderId: string;
  number: string;
  contract: string;
  certified: string;
  deductions: string;
  billed: string;
  paid: string;
  committed: string;
  certificates: LedgerCertificateDto[];
}

/** `GET /subcontracts/subcontractors/:id/statement`. */
export interface SubcontractorStatementDto {
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

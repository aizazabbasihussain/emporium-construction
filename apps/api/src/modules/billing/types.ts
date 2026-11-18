import type { InvoicePrintModel, InvoiceStatus, ScheduleStage } from '@emporium/domain/billing';
import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  BillingAdvanceStatus,
  CreditNoteStatus,
  InvoiceSourceType,
  ScheduleSource,
  ScheduleStatus,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db, InvoicePrintModel, InvoiceStatus, ScheduleStage };

/** Who is acting; billing roles are not project-scoped, but a scoped user reaches only their projects. */
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

export interface ScheduleStageDto {
  id: string;
  stageNo: number;
  name: string;
  basisPercent: string | null;
  amount: string;
  source: ScheduleSource;
  sourceId: string | null;
  status: ScheduleStatus;
}

export interface ScheduleDto {
  projectId: string;
  originalContractValue: string;
  contractValue: string;
  scheduleTotal: string;
  /** BR-1: whether the stages add up to the current contract value. */
  matchesContract: boolean;
  /** A manual edit that still waits for approval blocks issuing. */
  pendingEditId: string | null;
  stages: ScheduleStageDto[];
}

export interface InvoiceLineDto {
  lineNo: number;
  scheduleId: string | null;
  description: string;
  amount: string;
  supplyKind: string;
  nature: string | null;
}

export interface InvoiceHeaderDto {
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

export interface InvoiceDto extends InvoiceHeaderDto {
  lines: InvoiceLineDto[];
  taxSnapshot: unknown;
  approval: { status: string; requestId: string | null; currentRole: string | null };
  creditedBase: string;
}

export interface AdvanceDto {
  id: string;
  projectId: string;
  partyId: string;
  invoiceId: string | null;
  amount: string;
  receivedOn: string | null;
  applied: string;
  status: BillingAdvanceStatus;
  version: number;
}

export interface CreditNoteDto {
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

/** `GET /billing/projects/:id/summary`. */
export interface BillingSummaryDto {
  projectId: string;
  originalContractValue: string;
  contractValue: string;
  /** Issued invoices less advance recovery, less credit notes (BR-7). */
  netBilled: string;
  remainingToBill: string;
  unappliedAdvance: string;
  plannedStages: string;
  invoices: number;
  advances: AdvanceDto[];
}

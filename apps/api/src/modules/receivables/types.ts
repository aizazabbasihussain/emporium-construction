import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  AllocationKind,
  FollowupStatus,
  PdcStatus,
  ReceiptMethod,
  ReceiptStatus,
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

export interface AllocationDto {
  id: string;
  receiptId: string;
  invoiceId: string;
  advanceId: string | null;
  amount: string;
  kind: AllocationKind;
}

/** BR-4: what the client withheld on an invoice against what the invoice expected. */
export interface WithholdingFlagDto {
  invoiceId: string;
  expected: string;
  actual: string;
  difference: string;
  flagged: boolean;
}

export interface ReceiptDto {
  id: string;
  number: string;
  partyId: string;
  receiptDate: string;
  method: ReceiptMethod;
  amount: string;
  accountId: string | null;
  reference: string | null;
  status: ReceiptStatus;
  withheldAmount: string;
  withholdingCertificateRef: string | null;
  cashbookTxnId: string | null;
  reversalTxnId: string | null;
  clearedOn: string | null;
  cancelledOn: string | null;
  cancelReason: string | null;
  allocations: AllocationDto[];
  /** Money of the receipt that no invoice took (customer credit, BR-1). */
  unallocated: string;
  withholdingFlags: WithholdingFlagDto[];
  version: number;
}

export interface PdcDto {
  id: string;
  receiptId: string;
  partyId: string;
  chequeNumber: string;
  bankName: string;
  drawer: string | null;
  chequeDate: string;
  amount: string;
  status: PdcStatus;
  depositAccountId: string | null;
  depositedOn: string | null;
  earlyDepositReason: string | null;
  clearedOn: string | null;
  bouncedOn: string | null;
  bounceReason: string | null;
  replacedByPdcId: string | null;
  version: number;
}

export interface PdcRegisterDto {
  items: PdcDto[];
  /** BR-7: cheques in hand dated in the next seven days. */
  upcoming: PdcDto[];
  /** BR-7: total value of cheques received or deposited and not yet cleared. */
  totalInHand: string;
  byStatus: Record<string, { count: number; total: string }>;
}

export interface OpenInvoiceDto {
  invoiceId: string;
  number: string | null;
  projectId: string;
  partyId: string;
  invoiceDate: string;
  dueDate: string;
  gross: string;
  credited: string;
  allocated: string;
  adjusted: string;
  outstanding: string;
  /** Cheques in hand that name this invoice and have not cleared yet. */
  pending: string;
  /** What a new receipt may still allocate: outstanding less cheques in hand. */
  allocatable: string;
  withholdingExpected: string;
  withholdingAllocated: string;
}

export interface CustomerBalanceDto {
  partyId: string;
  date: string;
  invoiced: string;
  credited: string;
  receipts: string;
  withholding: string;
  adjustments: string;
  balance: string;
  /** BR-1: shown next to the balance, never netted silently. */
  unallocatedReceipts: string;
  unappliedAdvances: string;
  credit: string;
}

export interface LedgerLineDto {
  date: string;
  kind: 'invoice' | 'credit_note' | 'receipt' | 'withholding' | 'adjustment';
  reference: string;
  invoiceId: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface StatementDto {
  partyId: string;
  from: string;
  to: string;
  opening: string;
  lines: LedgerLineDto[];
  closing: string;
}

export interface AgingReportDto {
  asOf: string;
  groupBy: 'customer' | 'project';
  labels: string[];
  rows: { key: string; label: string; buckets: string[]; total: string }[];
  totals: string[];
  total: string;
}

export interface AdjustmentDto {
  id: string;
  partyId: string;
  invoiceId: string;
  adjustmentDate: string;
  amount: string;
  reason: string;
  approvalDocId: string;
  approvedBy: string | null;
}

export interface FollowupDto {
  id: string;
  partyId: string;
  invoiceId: string | null;
  pdcId: string | null;
  dueDate: string;
  note: string;
  status: FollowupStatus;
  assignedTo: string | null;
  version: number;
}

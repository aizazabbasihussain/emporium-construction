import type { RunStatus } from '@emporium/domain/payroll';
import type { Payslip } from '@emporium/domain/payroll';
import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  CostDifferenceTreatment,
  PayrollLineStatus,
  PayrollPaymentMethod,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type {
  CostDifferenceTreatment,
  Db,
  PayrollLineStatus,
  PayrollPaymentMethod,
  Payslip,
  RunStatus,
};

/** Who is acting. */
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

export interface RunDto {
  id: string;
  periodId: string;
  year: number;
  month: number;
  status: RunStatus;
  revision: number;
  finalizedAt: string | null;
  finalizedBy: string | null;
  totalNet: string;
  totalPaid: string;
  totalUnpaid: string;
  costDifferenceTreatment: CostDifferenceTreatment;
  version: number;
}

/** BR-2: the wage sheet gross against the attendance cost; live for a draft, frozen once finalized. */
export interface CostSummaryDto {
  grossPay: string;
  allocatedCost: string;
  difference: string;
  adjustments: { projectId: string | null; amount: string; ledgerEntryId: string }[];
}

export interface RunDetailDto extends RunDto {
  lineCount: number;
  paidLineCount: number;
  cost: CostSummaryDto;
}

export interface LineDto {
  id: string;
  runId: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  netPay: string;
  paymentMethod: PayrollPaymentMethod | null;
  paymentStatus: PayrollLineStatus;
  paidOn: string | null;
  paymentId: string | null;
  cashbookTxnId: string | null;
  payslipNumber: string | null;
}

export interface PaymentDto {
  id: string;
  runId: string;
  paymentDate: string;
  method: PayrollPaymentMethod;
  accountId: string;
  amount: string;
  status: 'paid' | 'reversed';
  approvalDocId: string | null;
  reversedOn: string | null;
  reversalReason: string | null;
  lineIds: string[];
  cashbookTxnIds: string[];
  version: number;
}

export interface PaymentRequestDto {
  /** Null when the amount is within the approval band and no request is needed. */
  approvalDocId: string | null;
  amount: string;
  lineIds: string[];
}

export interface UnpaidRowDto {
  runId: string;
  year: number;
  month: number;
  lineId: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  netPay: string;
  /** Days since the run was finalized. */
  ageDays: number;
}

export interface UnpaidWagesDto {
  rows: UnpaidRowDto[];
  byRun: {
    runId: string;
    year: number;
    month: number;
    unpaidCount: number;
    unpaidAmount: string;
    oldestAgeDays: number;
  }[];
  total: string;
}

export interface PayslipDto extends Payslip {
  lineId: string;
  runId: string;
}

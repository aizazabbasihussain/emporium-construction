import type {
  CostDifferenceTreatment,
  PayrollLineStatus,
  PayrollPaymentMethod,
  PayrollRunStatus,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Run {
  id: string;
  periodId: string;
  year: number;
  month: number;
  status: PayrollRunStatus;
  revision: number;
  finalizedAt: string | null;
  totalNet: string;
  totalPaid: string;
  totalUnpaid: string;
  costDifferenceTreatment: CostDifferenceTreatment;
  version: number;
}

export interface RunDetail extends Run {
  lineCount: number;
  paidLineCount: number;
  cost: {
    grossPay: string;
    allocatedCost: string;
    difference: string;
    adjustments: { projectId: string | null; amount: string; ledgerEntryId: string }[];
  };
}

export interface Line {
  id: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  netPay: string;
  paymentMethod: PayrollPaymentMethod | null;
  paymentStatus: PayrollLineStatus;
  paidOn: string | null;
  paymentId: string | null;
  payslipNumber: string | null;
}

export interface Payment {
  id: string;
  paymentDate: string;
  method: PayrollPaymentMethod;
  accountId: string;
  amount: string;
  status: 'paid' | 'reversed';
  reversalReason: string | null;
  lineIds: string[];
  version: number;
}

export interface PaymentRequest {
  approvalDocId: string | null;
  amount: string;
  lineIds: string[];
}

export interface Unpaid {
  rows: {
    runId: string;
    year: number;
    month: number;
    lineId: string;
    workerCode: string;
    workerName: string;
    netPay: string;
    ageDays: number;
  }[];
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

export interface Payslip {
  id: string;
  number: string;
  workerCode: string;
  workerName: string;
  period: string;
  rate: string | null;
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  netPay: string;
  attendance: Record<string, string>;
}

export interface PayBody {
  lineIds?: string[];
  paymentDate: string;
  method: PayrollPaymentMethod;
  accountId: string;
  approvalDocId?: string;
  version: number;
}

export const payrollApi = {
  runs: () => request<Page<Run>>('GET', '/payroll/runs?limit=200'),
  run: (id: string) => request<RunDetail>('GET', `/payroll/runs/${id}`),
  lines: (id: string) => request<Line[]>('GET', `/payroll/runs/${id}/lines`),
  create: (periodId: string) => request<Run>('POST', '/payroll/runs', { periodId }),
  finalize: (run: Run, costDifferenceTreatment: CostDifferenceTreatment) =>
    request<Run>('POST', `/payroll/runs/${run.id}/finalize`, {
      version: run.version,
      costDifferenceTreatment,
    }),
  reopen: (run: Run, reason: string) =>
    request<Run>('POST', `/payroll/runs/${run.id}/reopen`, { reason, version: run.version }),
  requestPayment: (id: string, lineIds?: string[]) =>
    request<PaymentRequest>('POST', `/payroll/runs/${id}/payment-requests`, { lineIds }),
  pay: (id: string, body: PayBody) => request<Payment>('POST', `/payroll/runs/${id}/pay`, body),
  payments: (id: string) => request<Payment[]>('GET', `/payroll/runs/${id}/payments`),
  reverse: (payment: Payment, reason: string) =>
    request<Payment>('POST', `/payroll/payments/${payment.id}/reverse`, {
      reason,
      version: payment.version,
    }),
  payslip: (id: string) => request<Payslip>('GET', `/payroll/payslips/${id}`),
  unpaid: () => request<Unpaid>('GET', '/payroll/unpaid'),
  approvedPeriods: () =>
    request<Page<{ id: string; year: number; month: number; status: string }>>(
      'GET',
      '/wages/periods?limit=100',
    ),
};

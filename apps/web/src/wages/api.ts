import type { AdjustmentKind, PeriodStatus, WageAdvanceStatus } from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Period {
  id: string;
  year: number;
  month: number;
  from: string;
  to: string;
  status: PeriodStatus;
  calculatedAt: string | null;
  totalNet: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  reopenReason: string | null;
  version: number;
}

export interface Totals {
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  grossPay: string;
  netPay: string;
  roundingAdjustment: string;
}

export interface Warnings {
  unapprovedSheets: { id: string; teamId: string; date: string; status: string }[];
  missingSheets: { teamId: string; date: string }[];
  shortfalls: { workerId: string; workerName: string; amount: string }[];
}

export interface PeriodDetail extends Period {
  totals: Totals;
  lineCount: number;
  warnings: Warnings;
  approval: {
    status: string;
    requestId: string | null;
    currentRole: string | null;
    lastComment: string | null;
  };
}

export interface Line extends Totals {
  id: string;
  periodId: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  payBasis: 'daily_rate' | 'monthly_salary';
  rate: string;
  presentDays: string;
  halfDays: string;
  paidLeaveDays: string;
  offDays: string;
  absentDays: string;
  overtimeHours: string;
  shortfall: string;
  note: string | null;
}

export interface Adjustment {
  id: string;
  lineId: string;
  kind: AdjustmentKind;
  amount: string;
  reason: string;
  addedBy: string | null;
  addedAt: string;
}

export interface Lines {
  period: Period;
  lines: Line[];
  adjustments: Adjustment[];
  totals: Totals;
}

export interface Advance {
  id: string;
  workerId: string;
  workerCode: string | null;
  workerName: string | null;
  amount: string;
  issuedOn: string;
  monthlyRecovery: string;
  balance: string;
  status: WageAdvanceStatus;
  note: string | null;
  version: number;
}

export interface ReconciliationRow {
  workerId: string;
  workerCode: string | null;
  workerName: string | null;
  allocated: string;
  gross: string;
  difference: string;
}

export interface Reconciliation {
  period: Period;
  rows: ReconciliationRow[];
  differences: ReconciliationRow[];
  totals: { allocated: string; gross: string; difference: string };
}

export interface WorkerOption {
  id: string;
  code: string;
  fullName: string;
}

export interface AdvanceBody {
  workerId: string;
  amount: string;
  issuedOn: string;
  monthlyRecovery: string;
  note?: string;
}

export const wagesApi = {
  periods: (year?: number) =>
    request<Page<Period>>(
      'GET',
      `/wages/periods?limit=100${year === undefined ? '' : `&year=${year}`}`,
    ),
  create: (year: number, month: number) =>
    request<Period>('POST', '/wages/periods', { year, month }),
  detail: (id: string) => request<PeriodDetail>('GET', `/wages/periods/${id}`),
  lines: (id: string) => request<Lines>('GET', `/wages/periods/${id}/lines`),
  calculate: (id: string) => request<Lines>('POST', `/wages/periods/${id}/calculate`),
  submit: (id: string, version: number, acknowledgeWarnings: boolean) =>
    request<PeriodDetail>('POST', `/wages/periods/${id}/submit`, { version, acknowledgeWarnings }),
  reopen: (id: string, version: number, reason: string) =>
    request<PeriodDetail>('POST', `/wages/periods/${id}/reopen`, { version, reason }),
  adjust: (lineId: string, body: { kind: AdjustmentKind; amount: string; reason: string }) =>
    request<Lines>('POST', `/wages/lines/${lineId}/adjustments`, body),
  reconciliation: (id: string) =>
    request<Reconciliation>('GET', `/wages/periods/${id}/reconciliation`),
  advances: (status?: WageAdvanceStatus) =>
    request<Page<Advance>>(
      'GET',
      `/wages/advances?limit=200${status === undefined ? '' : `&status=${status}`}`,
    ),
  issueAdvance: (body: AdvanceBody) => request<Advance>('POST', '/wages/advances', body),
  workers: () => request<Page<WorkerOption>>('GET', '/workforce/workers?limit=200'),
};

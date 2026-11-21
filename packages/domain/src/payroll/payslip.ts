export interface PayslipSource {
  number: string;
  workerId: string;
  workerCode: string;
  workerName: string;
  /** `yyyy-mm`. */
  period: string;
  payBasis: string;
  rate: string;
  presentDays: string;
  halfDays: string;
  paidLeaveDays: string;
  offDays: string;
  absentDays: string;
  overtimeHours: string;
  basicPay: string;
  overtimePay: string;
  allowances: string;
  deductions: string;
  advanceRecovery: string;
  netPay: string;
}

export interface Payslip extends Omit<PayslipSource, 'rate'> {
  /** BR-3: the rate is shown only on the worker's own payslip. */
  rate: string | null;
  attendance: {
    presentDays: string;
    halfDays: string;
    paidLeaveDays: string;
    offDays: string;
    absentDays: string;
    overtimeHours: string;
  };
}

/** BR-3: one worker's payslip, with the rate left out unless the viewer is that worker. */
export function buildPayslip(source: PayslipSource, viewerWorkerId: string | null): Payslip {
  return {
    ...source,
    rate: viewerWorkerId === source.workerId ? source.rate : null,
    attendance: {
      presentDays: source.presentDays,
      halfDays: source.halfDays,
      paidLeaveDays: source.paidLeaveDays,
      offDays: source.offDays,
      absentDays: source.absentDays,
      overtimeHours: source.overtimeHours,
    },
  };
}

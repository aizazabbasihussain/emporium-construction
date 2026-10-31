import { request } from '../admin/api';

export interface OwnAttendance {
  month: string;
  days: { date: string; status: string; overtimeHours: string }[];
}

export interface OwnAdvances {
  balance: string;
  recoveries: { month: string; amount: string }[];
}

export interface OwnWageLine {
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
  grossPay: string;
  netPay: string;
}

export interface OwnWages {
  month: string;
  line: OwnWageLine | null;
}

export interface WorkerAccount {
  userId: string;
  workerId: string;
  linkedBy: string;
  linkedAt: string;
}

/** The worker is never named in a request: the server takes it from the signed-in login. */
export const workerPortalApi = {
  attendance: (month: string) =>
    request<OwnAttendance>('GET', `/me/worker/attendance?month=${month}`),
  advances: () => request<OwnAdvances>('GET', '/me/worker/advances'),
  wages: (month: string) => request<OwnWages>('GET', `/me/worker/wages?month=${month}`),
  account: (workerId: string) =>
    request<{ account: WorkerAccount | null }>('GET', `/admin/workers/${workerId}/account`),
  link: (workerId: string, userId: string, confirmOtherRoles: boolean) =>
    request<WorkerAccount>('PUT', `/admin/workers/${workerId}/account`, {
      userId,
      confirmOtherRoles,
    }),
  unlink: (workerId: string) => request<unknown>('DELETE', `/admin/workers/${workerId}/account`),
};

// The only public entry point of the payroll module.
import { createContext, type PayrollDeps } from './service/context.js';
import { createCostService } from './service/cost.service.js';
import { createPaymentsService, type PaymentsService } from './service/payments.service.js';
import { createPayslipsService, type PayslipsService } from './service/payslips.service.js';
import { createRunsService, type RunsService } from './service/runs.service.js';

export interface Payroll {
  runs: RunsService;
  payments: PaymentsService;
  payslips: PayslipsService;
  /** Module interfaces for other modules (spec P2-07 section 2). */
  getPayrollRun: RunsService['getPayrollRun'];
  getUnpaidWages: PaymentsService['unpaid'];
  /** The check wages makes before it reopens a period (P1-18 BR-11). */
  hasPaidLines: RunsService['hasPaidLines'];
}

/**
 * Wires payroll on top of the kernel, wages (the approved sheet), attendance, projects (the cost
 * ledger), the cash book and approvals. It recalculates no wages and changes no attendance.
 */
export function createPayroll(deps: PayrollDeps): Payroll {
  const ctx = createContext(deps);
  const runs = createRunsService(ctx, createCostService(ctx));
  const payments = createPaymentsService(ctx);
  const payslips = createPayslipsService(ctx);
  return {
    runs,
    payments,
    payslips,
    getPayrollRun: (db, periodId) => runs.getPayrollRun(db, periodId),
    getUnpaidWages: (db) => payments.unpaid(db),
    hasPaidLines: (db, periodId) => runs.hasPaidLines(db, periodId),
  };
}

export { registerPayrollRoutes, type PayrollRouteDeps } from './routes/payroll.routes.js';
export type { PayrollDeps } from './service/context.js';
export type {
  LineDto,
  PaymentDto,
  PaymentRequestDto,
  PayslipDto,
  RunDetailDto,
  RunDto,
  UnpaidWagesDto,
} from './types.js';

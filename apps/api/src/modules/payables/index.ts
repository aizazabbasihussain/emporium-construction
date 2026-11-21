// The only public entry point of the payables module.
import type { Clock } from '@emporium/domain/kernel';
import type { TaxReportRow } from '@emporium/domain/tax';
import { paymentDocType, vendorBillDocType } from '@emporium/shared';
import { createBillService, type BillService } from './service/bills.service.js';
import { taxReportRows } from './repo/payables.repo.js';
import { createContext, type PayablesDeps } from './service/context.js';
import { createLedgerService, type LedgerService } from './service/ledger.service.js';
import { createPaymentService, type PaymentService } from './service/payments.service.js';

export interface Payables {
  bills: BillService;
  payments: PaymentService;
  ledger: LedgerService;
  /** Module-to-module API (spec P2-05 section 2); read-only, call with any database handle. */
  getVendorBalance: LedgerService['getVendorBalance'];
  getOpenBills: LedgerService['getOpenBills'];
  getPaidAmount: LedgerService['getPaidAmount'];
  /** P2-06 registers where its certified work becomes a bill. */
  registerBillSource: BillService['registerBillSource'];
  /** Procurement asks before it cancels a receipt (BR-8 there). */
  isGrnBilled: BillService['isGrnBilled'];
  /** The daily job that puts post-dated cheques into the cash book on their date (BR-7). */
  postDueCheques: PaymentService['postDueCheques'];
}

/**
 * Wires payables on top of the kernel, procurement (orders and receipts), inventory (what was
 * issued), projects (the cost ledger), the tax engine, the cash book (every money movement),
 * approvals and master data. It writes no stock, no order and no cash entry of its own.
 */
export function createPayables(deps: PayablesDeps & { clock: Clock }): Payables {
  const ctx = createContext(deps);
  const bills = createBillService(ctx);
  const payments = createPaymentService(ctx);
  const ledger = createLedgerService(ctx);
  // P2-01 BR-8: the tax report reads input tax and withholding deducted through this view.
  deps.tax.registerReportSource({
    rows: async (db, query) => (await taxReportRows(db, query)) as TaxReportRow[],
  });
  for (const outcome of ['approved', 'rejected', 'returned', 'cancelled'] as const) {
    deps.platform.events.subscribe(
      `approval.${outcome}`,
      async (event, tx) => {
        const payload = event.payload as { docType: string; docId: string };
        if (payload.docType === vendorBillDocType) {
          await bills.onApprovalOutcome(outcome, payload, tx);
        } else if (payload.docType === paymentDocType) {
          await payments.onApprovalOutcome(outcome, payload, tx);
        }
      },
      `payables.approval.${outcome}`,
    );
  }
  return {
    bills,
    payments,
    ledger,
    getVendorBalance: (db, partyId, date) => ledger.getVendorBalance(db, partyId, date),
    getOpenBills: (db, partyId, asOf) => ledger.getOpenBills(db, partyId, asOf),
    getPaidAmount: (db, source, date) => ledger.getPaidAmount(db, source, date),
    registerBillSource: (type, provider) => bills.registerBillSource(type, provider),
    isGrnBilled: (db, grnId) => bills.isGrnBilled(db, grnId),
    postDueCheques: (tx) => payments.postDueCheques(tx),
  };
}

export { registerPayablesRoutes, type PayablesRouteDeps } from './routes/payables.routes.js';
export type { PayablesDeps } from './service/context.js';
export type { BillSourceProvider, ProviderBill } from './service/bills.service.js';
export type {
  AgingReportDto,
  BillDto,
  OpenBillDto,
  PaymentDto,
  PaymentRunDto,
  VendorBalanceDto,
  VendorLedgerDto,
  WithholdingReportDto,
} from './types.js';

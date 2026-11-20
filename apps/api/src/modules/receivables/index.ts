// The only public entry point of the receivables module.
import type { Clock } from '@emporium/domain/kernel';
import { receivablesNotificationTemplates } from '@emporium/shared';
import {
  createCollectionsService,
  type CollectionsService,
} from './service/collections.service.js';
import { createContext, type ReceivablesDeps } from './service/context.js';
import { createLedgerService, type LedgerService } from './service/ledger.service.js';
import { createPdcService, type PdcService } from './service/pdcs.service.js';
import { createReceiptService, type ReceiptService } from './service/receipts.service.js';

export interface Receivables {
  receipts: ReceiptService;
  pdcs: PdcService;
  ledger: LedgerService;
  collections: CollectionsService;
  /** Module-to-module API (spec P2-04 section 2); read-only, call with any database handle. */
  getCustomerBalance: LedgerService['getCustomerBalance'];
  getOpenInvoices: LedgerService['getOpenInvoices'];
  getCollectedAmount: LedgerService['getCollectedAmount'];
  /** The daily 09:00 cheque reminder (BR-7); the scheduler calls it inside a transaction. */
  remindUpcomingPdcs: PdcService['remindUpcoming'];
}

/**
 * Wires receivables on top of the kernel, billing (invoices, advances), the cash book (every money
 * movement), approvals, notifications and master data. It writes no invoice and no cash entry of
 * its own: money moves only through the cash book.
 */
export function createReceivables(deps: ReceivablesDeps & { clock: Clock }): Receivables {
  for (const [code, key] of Object.entries(receivablesNotificationTemplates)) {
    deps.notifications.registerTemplate(code, key);
  }
  const ctx = createContext(deps);
  const receipts = createReceiptService(ctx);
  const pdcs = createPdcService(ctx, receipts);
  const ledger = createLedgerService(ctx);
  const collections = createCollectionsService(ctx);
  return {
    receipts,
    pdcs,
    ledger,
    collections,
    getCustomerBalance: (db, partyId, date) => ledger.getCustomerBalance(db, partyId, date),
    getOpenInvoices: (db, partyId, asOf) => ledger.getOpenInvoices(db, partyId, asOf),
    getCollectedAmount: (db, projectId, date) => ledger.getCollectedAmount(db, projectId, date),
    remindUpcomingPdcs: (tx, now) => pdcs.remindUpcoming(tx, now),
  };
}

export {
  registerReceivablesRoutes,
  type ReceivablesRouteDeps,
} from './routes/receivables.routes.js';
export type { ReceivablesDeps } from './service/context.js';
export type {
  AdjustmentDto,
  AgingReportDto,
  CustomerBalanceDto,
  FollowupDto,
  LedgerLineDto,
  OpenInvoiceDto,
  PdcDto,
  PdcRegisterDto,
  ReceiptDto,
  StatementDto,
} from './types.js';

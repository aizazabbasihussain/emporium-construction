// The only public entry point of the billing module.
import type { TaxReportRow } from '@emporium/domain/tax';
import type { Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../approvals/index.js';
import type { MasterData } from '../masterdata/index.js';
import type { Platform } from '../platform/index.js';
import type { Projects } from '../projects/index.js';
import type { Quotations } from '../quotations/index.js';
import type { Tax } from '../tax/index.js';
import type { Variations } from '../variations/index.js';
import { taxReportRows } from './repo/billing.repo.js';
import { createAdvanceService, type AdvanceService } from './service/advances.service.js';
import {
  subscribeToDecisions,
  subscribeToScheduleSources,
} from './service/approval-events.service.js';
import { createCreditNoteService, type CreditNoteService } from './service/credit-notes.service.js';
import { createInvoiceService, type InvoiceService } from './service/invoices.service.js';
import { createScheduleService, type ScheduleService } from './service/schedule.service.js';

export interface Billing {
  schedule: ScheduleService;
  invoices: InvoiceService;
  advances: AdvanceService;
  creditNotes: CreditNoteService;
  /** Module-to-module API (spec P2-02 section 2). */
  getInvoice: InvoiceService['getInvoice'];
  listInvoicesForProject: InvoiceService['listInvoicesForProject'];
  getBilledAmount: InvoiceService['getBilledAmount'];
  getProjectBilling: InvoiceService['getProjectBilling'];
  /** BR-12: later invoice kinds (P3-04) register a provider for their source type. */
  registerInvoiceSource: InvoiceService['registerInvoiceSource'];
  /** Receipts (P2-04) tell billing that the money of an advance invoice arrived (BR-8). */
  markAdvanceReceived: AdvanceService['markReceived'];
}

/**
 * Wires billing on top of the kernel, projects, variations, quotations, the tax engine, approvals
 * and master data. It records no payment, posts no cash and touches no cost ledger.
 */
export function createBilling(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  projects: Pick<Projects, 'getProject'>;
  variations: Pick<Variations, 'getCurrentContractValue' | 'listApprovedVariations'>;
  quotations: Pick<Quotations, 'getQuotation'>;
  tax: Pick<Tax, 'calculateSalesTax' | 'calculateWithholding' | 'registerReportSource'>;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState' | 'cancelApproval'>;
  masterData: Pick<MasterData, 'getParty' | 'company' | 'getRegistration'>;
}): Billing {
  const schedule = createScheduleService(deps);
  const invoices = createInvoiceService({ ...deps, schedule });
  const advances = createAdvanceService({ ...deps, invoices, schedule });
  const creditNotes = createCreditNoteService(deps);
  subscribeToDecisions({ platform: deps.platform, invoices, schedule });
  subscribeToScheduleSources({ platform: deps.platform, schedule });
  // P2-01 BR-8: the tax report reads the stored snapshots through this view.
  deps.tax.registerReportSource({
    rows: async (db, query) => (await taxReportRows(db, query)) as TaxReportRow[],
  });
  return {
    schedule,
    invoices,
    advances,
    creditNotes,
    getInvoice: (db, id) => invoices.getInvoice(db, id),
    listInvoicesForProject: (db, projectId) => invoices.listInvoicesForProject(db, projectId),
    getBilledAmount: (db, projectId) => invoices.getBilledAmount(db, projectId),
    getProjectBilling: (db, projectId, asOf) => invoices.getProjectBilling(db, projectId, asOf),
    registerInvoiceSource: (type, provider) => invoices.registerInvoiceSource(type, provider),
    markAdvanceReceived: (advanceId, receivedOn, by, tx) =>
      advances.markReceived(advanceId, receivedOn, by, tx),
  };
}

export { registerBillingRoutes, type BillingRouteDeps } from './routes/billing.routes.js';
export type {
  AdvanceDto,
  BillingSummaryDto,
  CreditNoteDto,
  InvoiceDto,
  InvoiceHeaderDto,
  InvoiceLineDto,
  ScheduleDto,
  ScheduleStageDto,
} from './types.js';
export type {
  InvoiceSourceProvider,
  InvoiceSourceRequest,
  InvoiceSourceResult,
  SourceLine,
} from './service/sources.js';

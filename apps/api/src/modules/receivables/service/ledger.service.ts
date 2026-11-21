import {
  ageItems,
  invoiceOutstanding,
  parseBuckets,
  suggestAllocation,
} from '@emporium/domain/receivables';
import { BusinessDate, Money } from '@emporium/domain/kernel';
import { receivablesSettingKeys } from '@emporium/shared';
import { assertFound } from '../policy/receivables.policy.js';
import {
  collectedForProject,
  collectedSplitForProject,
  listAdjustments,
  listAdvanceAllocations,
  listInvoiceFigures,
  listReceiptEvents,
  unallocatedReceipts,
  type InvoiceFigures,
} from '../repo/receivables.repo.js';
import type {
  AgingReportDto,
  CustomerBalanceDto,
  Db,
  LedgerLineDto,
  OpenInvoiceDto,
  StatementDto,
} from '../types.js';
import { readerActor, type Context } from './context.js';

export interface LedgerService {
  /** Issued invoices of a customer that still owe money (module API, spec section 2). */
  getOpenInvoices(db: Db, partyId: string, asOf?: string): Promise<OpenInvoiceDto[]>;
  /** BR-1: balance and the customer credit next to it, as of a date. */
  getCustomerBalance(db: Db, partyId: string, date: string): Promise<CustomerBalanceDto>;
  /** Cash and advances collected against the invoices of a project, as of a date. */
  getCollectedAmount(db: Db, projectId: string, date?: string): Promise<string>;
  /** Collected against the project's invoices as of a date: gross (with withholding certified), the withholding part, and base. */
  getProjectCollected(
    db: Db,
    projectId: string,
    asOf: string,
  ): Promise<{ gross: string; withheld: string; base: string }>;
  /** What is still owed on the project's invoices as of a date and the oldest due date among them. */
  getProjectAging(
    db: Db,
    projectId: string,
    asOf: string,
  ): Promise<{
    asOf: string;
    outstanding: string;
    openInvoices: number;
    oldestDueDate: string | null;
  }>;
  /** The customer ledger screen: balance with credit, and the open invoices, as of a date (default today). */
  overview(
    db: Db,
    partyId: string,
    date?: string,
  ): Promise<{ balance: CustomerBalanceDto; openInvoices: OpenInvoiceDto[] }>;
  /** BR-10: opening balance, movements and closing balance for a period. */
  statement(db: Db, partyId: string, from: string, to: string): Promise<StatementDto>;
  /** BR-8: aging per customer or per project, as of any date. */
  aging(db: Db, asOf: string, groupBy: 'customer' | 'project'): Promise<AgingReportDto>;
  /** BR-3: the oldest-due-first suggestion; the user confirms it. */
  suggest(
    db: Db,
    partyId: string,
    amount: string,
  ): Promise<{ invoiceId: string; amount: string }[]>;
}

export const openInvoiceDto = (row: InvoiceFigures): OpenInvoiceDto => {
  const outstanding = invoiceOutstanding({
    gross: row.gross,
    credited: row.credited,
    allocated: row.allocated,
    adjusted: row.adjusted,
  });
  return {
    invoiceId: row.invoice_id,
    number: row.number,
    projectId: row.project_id,
    partyId: row.party_id,
    invoiceDate: row.invoice_date,
    dueDate: row.due_date,
    gross: row.gross,
    credited: row.credited,
    allocated: row.allocated,
    adjusted: row.adjusted,
    outstanding,
    pending: row.pending,
    allocatable: Money.of(outstanding).sub(Money.of(row.pending)).toString(),
    withholdingExpected: row.withholding_expected,
    withholdingAllocated: row.withholding_allocated,
  };
};

const sum = (values: readonly string[]): Money =>
  values.reduce((total, value) => total.add(Money.of(value)), Money.zero());

export function createLedgerService(ctx: Context): LedgerService {
  const { platform, billing, masterData, projects } = ctx;

  const openOf = async (db: Db, partyId: string, asOf: string) =>
    (await listInvoiceFigures(db, { asOf, partyId })).map(openInvoiceDto);

  /** BR-5: advances that arrived and billing has not yet used up. */
  async function unappliedAdvances(db: Db, partyId: string, asOf: string): Promise<Money> {
    const rows = await listAdvanceAllocations(db, partyId, asOf);
    const wanted = new Set(rows.map((r) => r.advance_id));
    let total = Money.zero();
    for (const projectId of new Set(rows.map((r) => r.project_id))) {
      for (const advance of await billing.advances.list(db, projectId, readerActor)) {
        if (wanted.has(advance.id)) {
          total = total.add(Money.of(advance.amount)).sub(Money.of(advance.applied));
        }
      }
    }
    return total;
  }

  const service: LedgerService = {
    async overview(db, partyId, date) {
      const on = date ?? ctx.today();
      return {
        balance: await service.getCustomerBalance(db, partyId, on),
        openInvoices: await service.getOpenInvoices(db, partyId, on),
      };
    },

    async getOpenInvoices(db, partyId, asOf) {
      const open = await openOf(db, partyId, asOf ?? ctx.today());
      return open.filter((row) => Money.of(row.outstanding).compare(Money.zero()) > 0);
    },

    async getCustomerBalance(db, partyId, date) {
      const asOf = BusinessDate.parse(date).toString();
      const rows = await listInvoiceFigures(db, { asOf, partyId });
      const invoiced = sum(rows.map((r) => r.gross));
      const credited = sum(rows.map((r) => r.credited));
      const withholding = sum(rows.map((r) => r.withholding_allocated));
      const receipts = sum(rows.map((r) => r.allocated)).sub(withholding);
      const adjustments = sum(rows.map((r) => r.adjusted));
      const unallocated = Money.of(await unallocatedReceipts(db, partyId, asOf));
      const advances = await unappliedAdvances(db, partyId, asOf);
      return {
        partyId,
        date: asOf,
        invoiced: invoiced.toString(),
        credited: credited.toString(),
        receipts: receipts.toString(),
        withholding: withholding.toString(),
        adjustments: adjustments.toString(),
        balance: invoiced.sub(credited).sub(receipts).sub(withholding).sub(adjustments).toString(),
        unallocatedReceipts: unallocated.toString(),
        unappliedAdvances: advances.toString(),
        credit: unallocated.add(advances).toString(),
      };
    },

    async getCollectedAmount(db, projectId, date) {
      return Money.of(await collectedForProject(db, projectId, date ?? ctx.today())).toString();
    },

    async getProjectCollected(db, projectId, asOf) {
      return collectedSplitForProject(db, projectId, BusinessDate.parse(asOf).toString());
    },

    async getProjectAging(db, projectId, asOf) {
      const date = BusinessDate.parse(asOf).toString();
      const open = (await listInvoiceFigures(db, { asOf: date, projectId }))
        .filter((row) => row.source_type !== 'advance')
        .map(openInvoiceDto)
        .filter((row) => Money.of(row.outstanding).compare(Money.zero()) > 0);
      // Invoices come ordered by due date, so the first one is the oldest.
      return {
        asOf: date,
        outstanding: sum(open.map((row) => row.outstanding)).toString(),
        openInvoices: open.length,
        oldestDueDate: open[0]?.dueDate ?? null,
      };
    },

    async statement(db, partyId, from, to) {
      const start = BusinessDate.parse(from).toString();
      const end = BusinessDate.parse(to).toString();
      const figures = await listInvoiceFigures(db, { asOf: end, partyId });
      const events: Omit<LedgerLineDto, 'balance'>[] = [];
      const line = (
        date: string,
        kind: LedgerLineDto['kind'],
        reference: string,
        invoiceId: string | null,
        debit: string,
        credit: string,
      ) => events.push({ date, kind, reference, invoiceId, debit, credit });
      for (const row of figures) {
        line(row.invoice_date, 'invoice', row.number as string, row.invoice_id, row.gross, '0.00');
        if (Money.of(row.credited).compare(Money.zero()) > 0) {
          for (const note of await billing.creditNotes.listForInvoice(
            db,
            row.invoice_id,
            readerActor,
          )) {
            // A draft credit note has no date and owes nothing yet.
            if (note.issuedOn !== null) {
              line(
                note.issuedOn,
                'credit_note',
                note.number as string,
                row.invoice_id,
                '0.00',
                note.grossTotal,
              );
            }
          }
        }
      }
      for (const receipt of await listReceiptEvents(db, partyId, end)) {
        const parts = [
          ['receipt', receipt.cash],
          ['withholding', receipt.withholding],
        ] as const;
        for (const [kind, amount] of parts) {
          if (Money.of(amount).isZero()) continue;
          line(receipt.cleared_on, kind, receipt.number, null, '0.00', amount);
          if (receipt.cancelled_on !== null) {
            line(receipt.cancelled_on, kind, `${receipt.number} (reversed)`, null, amount, '0.00');
          }
        }
      }
      for (const adjustment of await listAdjustments(db, partyId)) {
        line(
          adjustment.adjustment_date,
          'adjustment',
          adjustment.reason,
          adjustment.invoice_id,
          '0.00',
          adjustment.amount,
        );
      }
      events.sort((a, b) => a.date.localeCompare(b.date));
      let running = Money.zero();
      let opening = Money.zero();
      const lines: LedgerLineDto[] = [];
      for (const event of events) {
        // A reversal or write-off after the period belongs to a later statement.
        if (event.date > end) continue;
        if (event.date < start) {
          running = running.add(Money.of(event.debit)).sub(Money.of(event.credit));
          opening = running;
          continue;
        }
        running = running.add(Money.of(event.debit)).sub(Money.of(event.credit));
        lines.push({ ...event, balance: running.toString() });
      }
      return {
        partyId,
        from: start,
        to: end,
        opening: opening.toString(),
        lines,
        closing: running.toString(),
      };
    },

    async aging(db, asOf, groupBy) {
      const date = BusinessDate.parse(asOf).toString();
      const bounds = parseBuckets(
        String((await platform.settings.get(db, receivablesSettingKeys.agingBuckets)).value),
      );
      const rows = (await listInvoiceFigures(db, { asOf: date })).map(openInvoiceDto);
      const key = (row: OpenInvoiceDto) => (groupBy === 'customer' ? row.partyId : row.projectId);
      const report = ageItems(
        rows.map((row) => ({ key: key(row), dueDate: row.dueDate, outstanding: row.outstanding })),
        date,
        bounds,
      );
      const labelOf = async (id: string) =>
        groupBy === 'customer'
          ? assertFound(await masterData.getParty(db, id), 'party').name
          : (await projects.getProject(db, id)).name;
      return {
        asOf: date,
        groupBy,
        labels: report.labels,
        rows: await Promise.all(
          report.rows.map(async (r) => ({ ...r, label: await labelOf(r.key) })),
        ),
        totals: report.totals,
        total: report.total,
      };
    },

    async suggest(db, partyId, amount) {
      const open = await openOf(db, partyId, ctx.today());
      return suggestAllocation(
        amount,
        open.map((row) => ({
          invoiceId: row.invoiceId,
          dueDate: row.dueDate,
          allocatable: row.allocatable,
        })),
      );
    },
  };
  return service;
}

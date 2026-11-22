import type { ExportRow } from '@emporium/domain/accounting';
import { Money } from '@emporium/domain/kernel';
import type { Billing } from '../../billing/index.js';
import type { Cashbook } from '../../cashbook/index.js';
import type { Expenses } from '../../expenses/index.js';
import type { MasterData } from '../../masterdata/index.js';
import type { Payables } from '../../payables/index.js';
import type { Payroll } from '../../payroll/index.js';
import type { Profitability } from '../../profitability/index.js';
import type { Projects } from '../../projects/index.js';
import type { Receivables } from '../../receivables/index.js';
import type { Subcontracts } from '../../subcontracts/index.js';
import type { Tax } from '../../tax/index.js';
import type { Valuation } from '../../valuation/index.js';
import type { ExportSources, Loaded, LoadContext, TaggableDoc } from '../service/context.js';
import type { Actor, Db, ExportCode, ExportFilters } from '../types.js';
import {
  allPages,
  inPeriod,
  monthsBetween,
  negate,
  partyNamer,
  periodColumns,
  previousDay,
  sumMoney,
} from './support.js';

/** The exported query interfaces of the owning modules that the exports read (spec P2-09 section 2). */
export interface SourceDeps {
  billing: Pick<Billing, 'invoices' | 'creditNotes' | 'getProjectBilling' | 'getInvoice'>;
  payables: Pick<Payables, 'bills' | 'payments' | 'ledger' | 'getVendorBalance'>;
  receivables: Pick<Receivables, 'receipts' | 'pdcs' | 'ledger' | 'getCustomerBalance'>;
  cashbook: Pick<Cashbook, 'accounts' | 'transactions' | 'getAccountBalance'>;
  payroll: Pick<Payroll, 'runs'>;
  valuation: Pick<Valuation, 'reports'>;
  subcontracts: Pick<Subcontracts, 'ledger'>;
  profitability: Pick<Profitability, 'listProjectFinancials' | 'getProjectFinancials'>;
  projects: Pick<Projects, 'getProject' | 'getCostSummary'>;
  expenses: Pick<Expenses, 'claims'>;
  masterData: Pick<MasterData, 'getParty' | 'searchParties'>;
  tax: Pick<Tax, 'taxReportData'>;
}

type Values = ExportRow['values'];
const line = (values: Values, tag?: ExportRow['tag']): ExportRow => ({ values, tag });
const byDateThenNumber = (a: ExportRow, b: ExportRow): number =>
  String(a.values.date).localeCompare(String(b.values.date)) ||
  String(a.values.number ?? a.values.reference).localeCompare(
    String(b.values.number ?? b.values.reference),
  );

const BUCKETS = 4;
/** The first four aging buckets get a column each; any further bucket is added to the fourth. */
const bucketColumns = (buckets: readonly string[]): Values => {
  const columns: Record<string, string> = {};
  for (let i = 0; i < BUCKETS; i += 1) {
    const rest = i === BUCKETS - 1 ? buckets.slice(i) : [buckets[i] ?? '0.00'];
    columns[`bucket_${i + 1}`] = sumMoney(rest.length === 0 ? ['0.00'] : rest);
  }
  return columns;
};

/**
 * Builds the module's view of the owning modules. Each export lists rows from the owning modules'
 * query functions and gets its control figures from a different report function of the same module
 * where there is one (BR-5).
 */
export function createExportSources(deps: SourceDeps): ExportSources {
  const { billing, payables, receivables, cashbook, payroll, valuation, masterData } = deps;

  /* ------------------------------------------------------------ documents of every owning module */

  const issuedInvoices = (db: Db, actor: Actor) =>
    allPages((limit, offset) =>
      billing.invoices.list(db, { status: 'issued', limit, offset }, actor),
    );

  async function creditNotes(db: Db, actor: Actor) {
    const out = [];
    for (const invoice of await issuedInvoices(db, actor)) {
      for (const note of await billing.creditNotes.listForInvoice(db, invoice.id, actor)) {
        if (note.issuedOn !== null && note.status === 'issued') out.push({ note, invoice });
      }
    }
    return out;
  }

  async function postedBills(db: Db) {
    const bills = [];
    for (const status of ['posted', 'partly_paid', 'paid']) {
      bills.push(
        ...(await allPages((limit, offset) => payables.bills.list(db, { status, limit, offset }))),
      );
    }
    return bills;
  }

  const paidPayments = (db: Db) =>
    allPages((limit, offset) => payables.payments.list(db, { status: 'paid', limit, offset }));

  async function countedReceipts(db: Db) {
    const receipts = await allPages((limit, offset) =>
      receivables.receipts.list(db, { limit, offset }),
    );
    return receipts.filter((r) => r.status !== 'bounced' && r.status !== 'cancelled');
  }

  const cashTransactions = (db: Db, query: { accountId?: string; from?: string; to?: string }) =>
    allPages((limit, offset) => cashbook.transactions.list(db, { ...query, limit, offset }));

  const finalizedRuns = async (db: Db) =>
    (await allPages((limit, offset) => payroll.runs.list(db, { limit, offset }))).filter(
      (run) => run.status !== 'draft',
    );

  const postedClaims = (db: Db, actor: Actor) =>
    allPages((limit, offset) =>
      deps.expenses.claims.list(db, { status: 'posted', mine: false, limit, offset }, actor),
    );

  const stockMovements = (db: Db) =>
    allPages((limit, offset) => valuation.reports.movements(db, { limit, offset }));

  async function partiesOf(db: Db, roles: string[], only?: string): Promise<string[]> {
    if (only !== undefined) return [only];
    const ids = new Set<string>();
    for (const role of roles) {
      const found = await allPages((limit, offset) =>
        masterData.searchParties(db, { role, sort: 'name', direction: 'asc', limit, offset }),
      );
      for (const party of found) ids.add(party.id);
    }
    return [...ids];
  }

  /* ------------------------------------------------------------ the exports */

  type Loader = (
    db: Db,
    filters: ExportFilters,
    ctx: LoadContext,
    name: (id: string | null) => Promise<string>,
  ) => Promise<Loaded>;

  const projectCodes = (db: Db) => {
    const codes = new Map<string, string>();
    return async (projectId: string): Promise<string> => {
      const known = codes.get(projectId);
      if (known !== undefined) return known;
      const code = (await deps.projects.getProject(db, projectId)).code;
      codes.set(projectId, code);
      return code;
    };
  };

  const loaders: Record<ExportCode, Loader> = {
    async sales_register(db, f, ctx, name) {
      const code = projectCodes(db);
      const rows: ExportRow[] = [];
      const projects = new Set<string>();
      for (const i of await issuedInvoices(db, ctx.actor)) {
        if (!inPeriod(i.invoiceDate, f.from, f.to)) continue;
        if (f.partyId !== undefined && i.partyId !== f.partyId) continue;
        projects.add(i.projectId);
        rows.push(
          line(
            {
              ...periodColumns(i.invoiceDate, ctx.fiscalStartMonth),
              date: i.invoiceDate,
              doc_type: 'invoice',
              number: i.number,
              authority: i.authorityCode,
              party: await name(i.partyId),
              project: await code(i.projectId),
              base: i.baseAmount,
              tax: i.taxTotal,
              gross: i.grossTotal,
            },
            { docType: 'invoice', docId: i.id, lineRef: '' },
          ),
        );
      }
      for (const { note, invoice } of await creditNotes(db, ctx.actor)) {
        const issued = note.issuedOn as string;
        if (!inPeriod(issued, f.from, f.to)) continue;
        if (f.partyId !== undefined && invoice.partyId !== f.partyId) continue;
        projects.add(invoice.projectId);
        rows.push(
          line(
            {
              ...periodColumns(issued, ctx.fiscalStartMonth),
              date: issued,
              doc_type: 'credit_note',
              number: note.number,
              authority: invoice.authorityCode,
              party: await name(invoice.partyId),
              project: await code(invoice.projectId),
              base: negate(note.baseAmount),
              tax: negate(note.taxTotal),
              gross: negate(note.grossTotal),
            },
            { docType: 'credit_note', docId: note.id, lineRef: '' },
          ),
        );
      }
      // BR-5: billing's own figure of what is billed to the end date, less what was billed before the start.
      const base: string[] = [];
      const tax: string[] = [];
      for (const projectId of projects) {
        const end = await billing.getProjectBilling(db, projectId, f.to);
        const start = await billing.getProjectBilling(db, projectId, previousDay(f.from));
        base.push(end.base, negate(start.base));
        tax.push(end.tax, negate(start.tax));
      }
      return {
        rows: rows.sort(byDateThenNumber),
        control: { base: sumMoney(base), tax: sumMoney(tax) },
      };
    },

    async purchase_register(db, f, ctx, name) {
      const rows: ExportRow[] = [];
      const vendors = new Set<string>();
      for (const b of await postedBills(db)) {
        if (!inPeriod(b.billDate, f.from, f.to)) continue;
        if (f.partyId !== undefined && b.vendorPartyId !== f.partyId) continue;
        vendors.add(b.vendorPartyId);
        rows.push(
          line(
            {
              ...periodColumns(b.billDate, ctx.fiscalStartMonth),
              date: b.billDate,
              number: b.number,
              vendor_invoice_no: b.vendorInvoiceNo,
              authority: b.authorityCode,
              party: await name(b.vendorPartyId),
              base: b.baseAmount,
              tax: b.taxTotal,
              gross: b.grossTotal,
              withholding: b.withholdingTotal,
              net_payable: b.netPayable,
            },
            { docType: 'bill', docId: b.id, lineRef: '' },
          ),
        );
      }
      const net: string[] = [];
      for (const vendor of vendors) {
        net.push(
          (await payables.getVendorBalance(db, vendor, f.to)).netPayable,
          negate((await payables.getVendorBalance(db, vendor, previousDay(f.from))).netPayable),
        );
      }
      return { rows: rows.sort(byDateThenNumber), control: { net_payable: sumMoney(net) } };
    },

    async receipts_register(db, f, ctx, name) {
      const rows: ExportRow[] = [];
      const customers = new Set<string>();
      for (const r of await countedReceipts(db)) {
        if (!inPeriod(r.receiptDate, f.from, f.to)) continue;
        if (f.partyId !== undefined && r.partyId !== f.partyId) continue;
        customers.add(r.partyId);
        rows.push(
          line(
            {
              ...periodColumns(r.receiptDate, ctx.fiscalStartMonth),
              date: r.receiptDate,
              number: r.number,
              party: await name(r.partyId),
              method: r.method,
              amount: r.amount,
              withheld: r.withheldAmount,
            },
            { docType: 'receipt', docId: r.id, lineRef: '' },
          ),
        );
      }
      const amount: string[] = [];
      const withheld: string[] = [];
      for (const customer of customers) {
        const end = await receivables.getCustomerBalance(db, customer, f.to);
        const start = await receivables.getCustomerBalance(db, customer, previousDay(f.from));
        amount.push(end.receipts, negate(start.receipts));
        withheld.push(end.withholding, negate(start.withholding));
      }
      return {
        rows: rows.sort(byDateThenNumber),
        control: { amount: sumMoney(amount), withheld: sumMoney(withheld) },
      };
    },

    async payments_register(db, f, ctx, name) {
      const rows: ExportRow[] = [];
      const vendors = new Set<string>();
      for (const p of await paidPayments(db)) {
        if (!inPeriod(p.paymentDate, f.from, f.to)) continue;
        if (f.partyId !== undefined && p.vendorPartyId !== f.partyId) continue;
        vendors.add(p.vendorPartyId);
        rows.push(
          line(
            {
              ...periodColumns(p.paymentDate, ctx.fiscalStartMonth),
              date: p.paymentDate,
              number: p.number,
              party: await name(p.vendorPartyId),
              method: p.method,
              cheque_no: p.chequeNumber,
              amount: p.amount,
              withholding: p.withholdingDeducted,
            },
            { docType: 'vendor_payment', docId: p.id, lineRef: '' },
          ),
        );
      }
      const paid: string[] = [];
      for (const vendor of vendors) {
        paid.push(
          (await payables.getVendorBalance(db, vendor, f.to)).payments,
          negate((await payables.getVendorBalance(db, vendor, previousDay(f.from))).payments),
        );
      }
      return { rows: rows.sort(byDateThenNumber), control: { amount: sumMoney(paid) } };
    },

    async cash_bank_book(db, f, ctx) {
      const rows: ExportRow[] = [];
      const net: string[] = [];
      const accounts = (await cashbook.accounts.list(db, true)).filter(
        (a) => f.accountId === undefined || a.id === f.accountId,
      );
      for (const account of accounts) {
        for (const t of await cashTransactions(db, {
          accountId: account.id,
          from: f.from,
          to: f.to,
        })) {
          const inbound = t.direction === 'in';
          rows.push(
            line(
              {
                ...periodColumns(t.txnDate, ctx.fiscalStartMonth),
                account: account.code,
                date: t.txnDate,
                number: t.number,
                description: t.description ?? t.reference ?? '',
                money_in: inbound ? t.amount : '0.00',
                money_out: inbound ? '0.00' : t.amount,
                net: inbound ? t.amount : negate(t.amount),
                balance: t.runningBalance ?? null,
              },
              { docType: 'cash_transaction', docId: t.id, lineRef: '' },
            ),
          );
        }
        net.push(
          await cashbook.getAccountBalance(db, account.id, f.to),
          negate(await cashbook.getAccountBalance(db, account.id, previousDay(f.from))),
        );
      }
      return {
        rows: rows.sort(
          (a, b) =>
            String(a.values.account).localeCompare(String(b.values.account)) ||
            byDateThenNumber(a, b),
        ),
        control: { net: sumMoney(net) },
      };
    },

    async pdc_register(db, f, _ctx, name) {
      const register = await receivables.pdcs.register(db, { from: f.from, to: f.to });
      const rows = [];
      for (const c of register.items) {
        if (f.partyId !== undefined && c.partyId !== f.partyId) continue;
        rows.push(
          line({
            cheque_no: c.chequeNumber,
            bank: c.bankName,
            party: await name(c.partyId),
            cheque_date: c.chequeDate,
            status: c.status,
            cleared_on: c.clearedOn,
            amount: c.amount,
          }),
        );
      }
      const owning =
        f.partyId === undefined
          ? sumMoney(Object.values(register.byStatus).map((s) => s.total))
          : sumMoney(register.items.filter((c) => c.partyId === f.partyId).map((c) => c.amount));
      return {
        rows: rows.sort((a, b) =>
          String(a.values.cheque_date).localeCompare(String(b.values.cheque_date)),
        ),
        control: { amount: owning },
      };
    },

    async customer_ledger(db, f, _ctx, name) {
      const rows: ExportRow[] = [];
      const net: string[] = [];
      for (const partyId of await partiesOf(db, ['client'], f.partyId)) {
        const statement = await receivables.ledger.statement(db, partyId, f.from, f.to);
        const party = await name(partyId);
        for (const l of statement.lines) {
          rows.push(
            line({
              party,
              date: l.date,
              kind: l.kind,
              reference: l.reference,
              debit: l.debit,
              credit: l.credit,
              net: Money.of(l.debit).sub(Money.of(l.credit)).toString(),
              balance: l.balance,
            }),
          );
        }
        net.push(statement.closing, negate(statement.opening));
      }
      return { rows: sortLedger(rows), control: { net: sumMoney(net) } };
    },

    async vendor_ledger(db, f, _ctx, name) {
      const rows: ExportRow[] = [];
      const net: string[] = [];
      for (const partyId of await partiesOf(db, ['vendor', 'subcontractor'], f.partyId)) {
        const ledger = await payables.ledger.overview(db, partyId, f.to);
        const party = await name(partyId);
        let any = false;
        for (const l of ledger.lines) {
          if (!inPeriod(l.date, f.from, f.to)) continue;
          any = true;
          rows.push(
            line({
              party,
              date: l.date,
              kind: l.kind,
              reference: l.reference,
              debit: l.debit,
              credit: l.credit,
              net: Money.of(l.credit).sub(Money.of(l.debit)).toString(),
              balance: l.balance,
            }),
          );
        }
        if (any) {
          net.push(
            ledger.balance.balance,
            negate((await payables.getVendorBalance(db, partyId, previousDay(f.from))).balance),
          );
        }
      }
      return { rows: sortLedger(rows), control: { net: sumMoney(net) } };
    },

    async aging(db, f, _ctx, name) {
      const rows: ExportRow[] = [];
      const totals: string[] = [];
      if (f.side !== 'payable') {
        const report = await receivables.ledger.aging(db, f.to, 'customer');
        for (const r of report.rows) {
          rows.push(
            line({
              side: 'receivable',
              party: r.label,
              ...bucketColumns(r.buckets),
              total: r.total,
            }),
          );
        }
        totals.push(report.total);
      }
      if (f.side !== 'receivable') {
        const report = await payables.ledger.aging(db, f.to);
        for (const r of report.rows) {
          rows.push(
            line({
              side: 'payable',
              party: await name(r.key),
              ...bucketColumns(r.buckets),
              total: r.total,
            }),
          );
        }
        totals.push(report.total);
      }
      return { rows, control: { total: sumMoney(totals) } };
    },

    async withholding_report(db, f, ctx, name) {
      const rows: ExportRow[] = [];
      const pairs = new Set<string>();
      for (const month of monthsBetween(f.from, f.to)) {
        const report = await payables.ledger.withholdingReport(db, {
          month,
          authorityCode: f.authorityCode,
        });
        for (const r of report.rows) {
          pairs.add(`${r.authorityCode}|${r.month}`);
          rows.push(
            line({
              ...periodColumns(`${r.month}-01`, ctx.fiscalStartMonth),
              direction: 'we_withheld',
              authority: r.authorityCode,
              party: await name(r.vendorPartyId),
              document: r.paymentNumber,
              certificate_no: r.certificateNo,
              amount: r.amount,
            }),
          );
        }
      }
      for (const r of await countedReceipts(db)) {
        if (!inPeriod(r.receiptDate, f.from, f.to) || Money.of(r.withheldAmount).isZero()) continue;
        const first = r.allocations.find((a) => a.invoiceId !== undefined);
        const authority =
          first === undefined
            ? ''
            : ((await billing.getInvoice(db, first.invoiceId)).authorityCode ?? '');
        if (f.authorityCode !== undefined && authority !== f.authorityCode) continue;
        pairs.add(`${authority}|${r.receiptDate.slice(0, 7)}`);
        rows.push(
          line({
            ...periodColumns(r.receiptDate, ctx.fiscalStartMonth),
            direction: 'client_withheld',
            authority,
            party: await name(r.partyId),
            document: r.number,
            certificate_no: r.withholdingCertificateRef,
            amount: r.withheldAmount,
          }),
        );
      }
      const owning: string[] = [];
      for (const pair of pairs) {
        const [authority, month] = pair.split('|') as [string, string];
        const report = await deps.tax.taxReportData(db, authority, month);
        owning.push(report.withholdingDeducted.tax, report.withholdingSuffered.tax);
      }
      return {
        rows: rows.sort(
          (a, b) =>
            String(a.values.month).localeCompare(String(b.values.month)) ||
            String(a.values.direction).localeCompare(String(b.values.direction)) ||
            String(a.values.document).localeCompare(String(b.values.document)),
        ),
        control: { amount: sumMoney(owning) },
      };
    },

    async payroll_summary(db, f, ctx) {
      const rows: ExportRow[] = [];
      const netPay: string[] = [];
      const paid: string[] = [];
      for (const run of await finalizedRuns(db)) {
        const month = `${run.year}-${String(run.month).padStart(2, '0')}`;
        if (month < f.from.slice(0, 7) || month > f.to.slice(0, 7)) continue;
        rows.push(
          line(
            {
              ...periodColumns(`${month}-01`, ctx.fiscalStartMonth),
              status: run.status,
              net_pay: run.totalNet,
              paid: run.totalPaid,
              unpaid: run.totalUnpaid,
            },
            { docType: 'payroll_run', docId: run.id, lineRef: '' },
          ),
        );
        const detail = await payroll.runs.getPayrollRun(db, run.periodId);
        netPay.push(detail.totalNet);
        paid.push(detail.totalPaid);
      }
      return {
        rows: rows.sort((a, b) => String(a.values.month).localeCompare(String(b.values.month))),
        control: { net_pay: sumMoney(netPay), paid: sumMoney(paid) },
      };
    },

    async stock_valuation(db, f) {
      const report = await valuation.reports.getTotalValue(db, {
        storeId: f.storeId,
        categoryId: f.categoryId,
      });
      const groups = new Map<
        string,
        { store: string; category: string; method: string; qty: number; value: string[] }
      >();
      for (const item of report.items) {
        const key = `${item.storeId}|${item.categoryId ?? ''}|${item.method}`;
        const group = groups.get(key) ?? {
          store: item.storeId,
          category: item.categoryId ?? '',
          method: item.method,
          qty: 0,
          value: [],
        };
        group.qty += Number(item.quantity);
        group.value.push(item.value);
        groups.set(key, group);
      }
      const rows = [...groups.values()]
        .sort((a, b) =>
          `${a.store}|${a.category}|${a.method}`.localeCompare(
            `${b.store}|${b.category}|${b.method}`,
          ),
        )
        .map((g) =>
          line({
            store: g.store,
            category: g.category,
            method: g.method,
            quantity: g.qty.toFixed(4),
            value: sumMoney(g.value),
          }),
        );
      return { rows, control: { value: report.totalValue } };
    },

    async project_cost_profit(db, f, ctx) {
      const portfolio = await deps.profitability.listProjectFinancials(
        db,
        { asOf: f.to },
        ctx.actor,
      );
      const rows: ExportRow[] = [];
      const cost: string[] = [];
      for (const p of portfolio.items) {
        if (f.projectId !== undefined && p.projectId !== f.projectId) continue;
        const detail = await deps.profitability.getProjectFinancials(
          db,
          p.projectId,
          f.to,
          ctx.actor,
        );
        rows.push(
          line({
            project: `${p.code} ${p.name}`,
            status: p.status,
            contract_value: detail.contractValue,
            cost_total: detail.costToDate,
            expected_margin: detail.expectedMargin,
            cash_position: detail.cashPosition,
          }),
        );
        const summary = await deps.projects.getCostSummary(
          db,
          { type: 'project', id: p.projectId },
          f.to,
        );
        cost.push(summary.totals.committed, summary.totals.approved, summary.totals.posted);
      }
      return { rows, control: { cost_total: sumMoney(cost) } };
    },

    async subcontractor_statements(db, f, ctx, name) {
      const rows: ExportRow[] = [];
      const totals = { certified: [] as string[], billed: [] as string[], paid: [] as string[] };
      for (const partyId of await partiesOf(db, ['subcontractor'], f.partyId)) {
        const statement = await deps.subcontracts.ledger.statement(db, partyId, ctx.actor);
        const party = await name(partyId);
        for (const o of statement.orders) {
          rows.push(
            line({
              party,
              work_order: o.number,
              status: o.status,
              contract: o.contract,
              certified: o.certified,
              deductions: o.deductions,
              billed: o.billed,
              paid: o.paid,
            }),
          );
        }
        totals.certified.push(statement.totals.certified);
        totals.billed.push(statement.totals.billed);
        totals.paid.push(statement.totals.paid);
      }
      return {
        rows,
        control: {
          certified: sumMoney(totals.certified),
          billed: sumMoney(totals.billed),
          paid: sumMoney(totals.paid),
        },
      };
    },
  };

  function sortLedger(rows: ExportRow[]): ExportRow[] {
    return rows.sort(
      (a, b) =>
        String(a.values.party).localeCompare(String(b.values.party)) ||
        String(a.values.date).localeCompare(String(b.values.date)),
    );
  }

  /* ------------------------------------------------------------ taggable lines (the untagged queue) */

  async function taggable(
    db: Db,
    range: { from?: string; to?: string },
    actor: Actor,
  ): Promise<TaggableDoc[]> {
    const name = partyNamer(masterData, db);
    const from = range.from ?? '0000-01-01';
    const to = range.to ?? '9999-12-31';
    const docs: TaggableDoc[] = [];
    const add = (doc: TaggableDoc) => {
      if (inPeriod(doc.date, from, to)) docs.push(doc);
    };
    for (const i of await issuedInvoices(db, actor)) {
      add({
        docType: 'invoice',
        docId: i.id,
        lineRef: '',
        date: i.invoiceDate,
        attrs: { kind: i.sourceType },
        number: i.number ?? '',
        party: await name(i.partyId),
        amount: i.grossTotal,
        description: '',
      });
    }
    for (const { note, invoice } of await creditNotes(db, actor)) {
      add({
        docType: 'credit_note',
        docId: note.id,
        lineRef: '',
        date: note.issuedOn as string,
        attrs: {},
        number: note.number ?? '',
        party: await name(invoice.partyId),
        amount: note.grossTotal,
        description: note.reason,
      });
    }
    for (const b of await postedBills(db)) {
      add({
        docType: 'bill',
        docId: b.id,
        lineRef: '',
        date: b.billDate,
        attrs: { kind: b.sourceType },
        number: b.number,
        party: await name(b.vendorPartyId),
        amount: b.grossTotal,
        description: b.vendorInvoiceNo,
      });
    }
    for (const p of await paidPayments(db)) {
      add({
        docType: 'vendor_payment',
        docId: p.id,
        lineRef: '',
        date: p.paymentDate,
        attrs: { method: p.method },
        number: p.number,
        party: await name(p.vendorPartyId),
        amount: p.amount,
        description: p.reference ?? '',
      });
    }
    for (const r of await countedReceipts(db)) {
      add({
        docType: 'receipt',
        docId: r.id,
        lineRef: '',
        date: r.receiptDate,
        attrs: { method: r.method },
        number: r.number,
        party: await name(r.partyId),
        amount: r.amount,
        description: r.reference ?? '',
      });
    }
    for (const t of await cashTransactions(db, { from: range.from, to: range.to })) {
      add({
        docType: 'cash_transaction',
        docId: t.id,
        lineRef: '',
        date: t.txnDate,
        attrs: { direction: t.direction, method: t.method, type: t.txnType },
        number: t.number,
        party: await name(t.counterpartyPartyId),
        amount: t.amount,
        description: t.description ?? '',
      });
    }
    for (const run of await finalizedRuns(db)) {
      add({
        docType: 'payroll_run',
        docId: run.id,
        lineRef: '',
        date: `${run.year}-${String(run.month).padStart(2, '0')}-01`,
        attrs: {},
        number: `${run.year}-${String(run.month).padStart(2, '0')}`,
        party: '',
        amount: run.totalNet,
        description: '',
      });
    }
    for (const m of await stockMovements(db)) {
      add({
        docType: 'stock_movement',
        docId: m.movementId,
        lineRef: '',
        date: m.postingDate,
        attrs: { direction: m.type === 'issue' ? 'issue' : 'receipt', type: m.type },
        number: m.sourceRef ?? String(m.seq),
        party: '',
        amount: m.value,
        description: m.type,
      });
    }
    for (const c of await postedClaims(db, actor)) {
      add({
        docType: 'expense_claim',
        docId: c.id,
        lineRef: '',
        date: c.submittedOn ?? '0000-01-01',
        attrs: {},
        number: c.number,
        party: '',
        amount: c.total,
        description: c.note,
      });
    }
    return docs;
  }

  return {
    async load(db, code, filters, ctx) {
      return loaders[code](db, filters, ctx, partyNamer(masterData, db));
    },
    taggable,
  };
}

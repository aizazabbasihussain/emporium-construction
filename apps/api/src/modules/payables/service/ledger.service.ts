import { Money } from '@emporium/domain/kernel';
import { vendorBalance, withholdingMonth } from '@emporium/domain/payables';
import { ageItems, parseBuckets } from '@emporium/domain/receivables';
import { receivablesSettingKeys } from '@emporium/shared';
import {
  balanceFigures,
  listBillFigures,
  listLedgerRows,
  listWithholding,
  paidAgainstSource,
} from '../repo/payables.repo.js';
import type {
  AgingReportDto,
  Db,
  OpenBillDto,
  VendorBalanceDto,
  VendorLedgerDto,
  WithholdingReportDto,
} from '../types.js';
import type { Context } from './context.js';

export interface LedgerService {
  /** BR-9: posted bills' net payable plus withholding payable (shown apart) less payments allocated. */
  getVendorBalance(db: Db, partyId: string, date?: string): Promise<VendorBalanceDto>;
  /** Posted bills that still owe money, oldest due date first. */
  getOpenBills(db: Db, partyId: string, asOf?: string): Promise<OpenBillDto[]>;
  /** What payments have taken of the bills of one source document (P2-06 reads this). */
  getPaidAmount(db: Db, source: { type: string; id: string }, date?: string): Promise<string>;
  overview(db: Db, partyId: string, date?: string): Promise<VendorLedgerDto>;
  /** BR-9: open bills by due date in the receivables buckets. */
  aging(db: Db, asOf?: string): Promise<AgingReportDto>;
  /** BR-8: withholding deducted per authority and month. */
  withholdingReport(
    db: Db,
    query: { month: string; authorityCode?: string | undefined },
  ): Promise<WithholdingReportDto>;
}

const lastDay = (month: string): string => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`;
};

export function createLedgerService(ctx: Context): LedgerService {
  const openBills = async (db: Db, asOf: string, vendorPartyId?: string): Promise<OpenBillDto[]> =>
    (await listBillFigures(db, { asOf, vendorPartyId }))
      .map((row) => ({
        billId: row.bill_id,
        number: row.number,
        vendorInvoiceNo: row.vendor_invoice_no,
        vendorPartyId: row.vendor_party_id,
        billDate: row.bill_date,
        dueDate: row.due_date,
        gross: row.gross,
        withholdingTotal: row.withholding_total,
        allocated: row.allocated,
        withheld: row.withheld,
        outstanding: Money.of(row.gross).sub(Money.of(row.allocated)).toString(),
      }))
      .filter((bill) => !Money.of(bill.outstanding).isZero());

  const service: LedgerService = {
    async getVendorBalance(db, partyId, date = ctx.today()) {
      const figures = await balanceFigures(db, partyId, date);
      return {
        partyId,
        date,
        ...vendorBalance({
          bills: figures.bills.map((b) => ({
            netPayable: b.net_payable,
            withholdingTotal: b.withholding_total,
          })),
          allocated: figures.allocations,
        }),
      };
    },

    getOpenBills: (db, partyId, asOf = ctx.today()) => openBills(db, asOf, partyId),

    getPaidAmount: (db, source, date = ctx.today()) =>
      paidAgainstSource(db, source.type, source.id, date),

    async overview(db, partyId, date = ctx.today()) {
      let running = Money.zero();
      const lines = (await listLedgerRows(db, partyId, '1970-01-01', date)).map((row) => {
        running = running.add(Money.of(row.credit)).sub(Money.of(row.debit));
        return {
          date: row.entry_date,
          kind: row.kind as 'bill' | 'payment',
          reference: row.reference,
          documentId: row.document_id,
          debit: row.debit,
          credit: row.credit,
          balance: running.toString(),
        };
      });
      return {
        partyId,
        date,
        balance: await service.getVendorBalance(db, partyId, date),
        lines,
        openBills: await openBills(db, date, partyId),
      };
    },

    async aging(db, asOf = ctx.today()) {
      const bounds = parseBuckets(await ctx.setting(db, receivablesSettingKeys.agingBuckets));
      const report = ageItems(
        (await openBills(db, asOf)).map((bill) => ({
          key: bill.vendorPartyId,
          dueDate: bill.dueDate,
          outstanding: bill.outstanding,
        })),
        asOf,
        bounds,
      );
      return { asOf, ...report };
    },

    async withholdingReport(db, query) {
      const rows = (
        await listWithholding(db, {
          from: `${query.month}-01`,
          to: lastDay(query.month),
          authorityCode: query.authorityCode,
        })
      ).map((row) => ({
        authorityCode: row.authority_code as string,
        month: withholdingMonth(row.paid_on),
        vendorPartyId: row.vendor_party_id,
        paymentId: row.payment_id,
        paymentNumber: row.payment_number,
        billId: row.bill_id,
        billNumber: row.bill_number,
        amount: row.amount,
        certificateNo: row.certificate_no,
      }));
      const totals = new Map<string, { authorityCode: string; month: string; amount: Money }>();
      for (const row of rows) {
        const key = `${row.authorityCode}|${row.month}`;
        const current = totals.get(key) ?? {
          authorityCode: row.authorityCode,
          month: row.month,
          amount: Money.zero(),
        };
        totals.set(key, { ...current, amount: current.amount.add(Money.of(row.amount)) });
      }
      return {
        rows,
        totals: [...totals.values()].map((t) => ({ ...t, amount: t.amount.toString() })),
      };
    },
  };
  return service;
}

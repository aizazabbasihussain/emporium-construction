import { columnTotals, controlMismatches, layoutOf } from '@emporium/domain/accounting';
import { Money } from '@emporium/domain/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ExportSources, LoadContext } from '../service/context.js';
import type { Actor, Db, ExportCode, ExportFilters } from '../types.js';
import { createExportSources, type SourceDeps } from './sources.js';
import { allPages, monthsBetween, previousDay } from './support.js';

const db = {} as Db;
const actor: Actor = {
  userId: 'u1',
  roles: ['accountant'],
  scopes: [],
  permissions: new Set(),
  requestId: null,
};
const ctx: LoadContext = { actor, fiscalStartMonth: 7 };
const period: ExportFilters = { from: '2026-10-01', to: '2026-10-31' };

/** A page of everything the query was asked for; the fakes ignore the paging. */
const page = <T>(items: T[]) => ({ items, total: items.length, limit: 200, offset: 0 });
const pageOnce =
  <T>(items: T[]) =>
  async (_db: Db, query: { offset?: number }) =>
    page(query.offset === undefined || query.offset === 0 ? items : []);

const sum = (items: readonly string[]) =>
  items.reduce((all, value) => all.add(Money.of(value)), Money.zero()).toString();

/** The dated facts of the scripted world; every figure was worked out by hand (see each test). */
const invoices = [
  {
    id: 'inv1',
    number: 'INV-2026-0001',
    invoiceDate: '2026-10-05',
    projectId: 'p1',
    partyId: 'c1',
    authorityCode: 'FBR',
    baseAmount: '100000.00',
    taxTotal: '8000.00',
    grossTotal: '108000.00',
    sourceType: 'project_stage',
  },
  {
    id: 'inv2',
    number: 'INV-2026-0002',
    invoiceDate: '2026-10-20',
    projectId: 'p1',
    partyId: 'c1',
    authorityCode: 'FBR',
    baseAmount: '50000.00',
    taxTotal: '4000.00',
    grossTotal: '54000.00',
    sourceType: 'project_stage',
  },
  {
    id: 'inv3',
    number: 'INV-2026-0000',
    invoiceDate: '2026-09-15',
    projectId: 'p1',
    partyId: 'c2',
    authorityCode: 'FBR',
    baseAmount: '20000.00',
    taxTotal: '1600.00',
    grossTotal: '21600.00',
    sourceType: 'advance',
  },
];
const creditNotes = [
  {
    id: 'cn1',
    number: 'CN-2026-0001',
    issuedOn: '2026-10-25',
    status: 'issued',
    baseAmount: '10000.00',
    taxTotal: '800.00',
    grossTotal: '10800.00',
    reason: 'Short work',
    invoiceId: 'inv1',
  },
  {
    id: 'cn2',
    number: null,
    issuedOn: null,
    status: 'draft',
    baseAmount: '1.00',
    taxTotal: '0.00',
    grossTotal: '1.00',
    reason: 'Draft',
    invoiceId: 'inv1',
  },
];
const bills = [
  {
    id: 'b1',
    number: 'BILL-2026-0001',
    vendorInvoiceNo: 'V-77',
    vendorPartyId: 'v1',
    billDate: '2026-10-06',
    status: 'posted',
    baseAmount: '50000.00',
    taxTotal: '4000.00',
    grossTotal: '54000.00',
    withholdingTotal: '1080.00',
    netPayable: '52920.00',
    authorityCode: 'FBR',
    sourceType: 'purchase',
  },
  {
    id: 'b2',
    number: 'BILL-2026-0002',
    vendorInvoiceNo: 'V-78',
    vendorPartyId: 'v1',
    billDate: '2026-10-12',
    status: 'partly_paid',
    baseAmount: '10000.00',
    taxTotal: '800.00',
    grossTotal: '10800.00',
    withholdingTotal: '216.00',
    netPayable: '10584.00',
    authorityCode: 'FBR',
    sourceType: 'subcontract',
  },
  {
    id: 'b3',
    number: 'BILL-2026-0003',
    vendorInvoiceNo: 'V-79',
    vendorPartyId: 'v1',
    billDate: '2026-10-13',
    status: 'draft',
    baseAmount: '1.00',
    taxTotal: '0.00',
    grossTotal: '1.00',
    withholdingTotal: '0.00',
    netPayable: '1.00',
    authorityCode: null,
    sourceType: 'purchase',
  },
];
const payments = [
  {
    id: 'pay1',
    number: 'PV-2026-0001',
    vendorPartyId: 'v1',
    paymentDate: '2026-10-15',
    method: 'cheque',
    chequeNumber: '000555',
    amount: '30000.00',
    withholdingDeducted: '1296.00',
    reference: 'Cheque run',
    status: 'paid',
  },
  {
    id: 'pay2',
    number: 'PV-2026-0002',
    vendorPartyId: 'v1',
    paymentDate: '2026-10-28',
    method: 'bank_transfer',
    chequeNumber: null,
    amount: '20000.00',
    withholdingDeducted: '0.00',
    reference: null,
    status: 'paid',
  },
  {
    id: 'pay3',
    number: 'PV-2026-0003',
    vendorPartyId: 'v2',
    paymentDate: '2026-10-29',
    method: 'cash',
    chequeNumber: null,
    amount: '1.00',
    withholdingDeducted: '0.00',
    reference: null,
    status: 'draft',
  },
];
const receipts = [
  {
    id: 'rc1',
    number: 'RV-2026-0001',
    partyId: 'c1',
    receiptDate: '2026-10-08',
    method: 'bank_transfer',
    amount: '60000.00',
    withheldAmount: '1000.00',
    withholdingCertificateRef: 'WC-9',
    reference: 'Stage 1',
    status: 'recorded',
    allocations: [{ invoiceId: 'inv1' }],
  },
  {
    id: 'rc2',
    number: 'RV-2026-0002',
    partyId: 'c1',
    receiptDate: '2026-10-22',
    method: 'cash',
    amount: '40000.00',
    withheldAmount: '0.00',
    withholdingCertificateRef: null,
    reference: null,
    status: 'cleared',
    allocations: [],
  },
  {
    id: 'rc3',
    number: 'RV-2026-0003',
    partyId: 'c2',
    receiptDate: '2026-10-23',
    method: 'cheque',
    amount: '999.00',
    withheldAmount: '0.00',
    withholdingCertificateRef: null,
    reference: null,
    status: 'bounced',
    allocations: [],
  },
  {
    id: 'rc4',
    number: 'RV-2026-0000',
    partyId: 'c2',
    receiptDate: '2026-09-10',
    method: 'cash',
    amount: '5000.00',
    withheldAmount: '0.00',
    withholdingCertificateRef: null,
    reference: null,
    status: 'cancelled',
    allocations: [],
  },
  {
    id: 'rc5',
    number: 'RV-2026-0004',
    partyId: 'c2',
    receiptDate: '2026-09-11',
    method: 'cash',
    amount: '5000.00',
    withheldAmount: '0.00',
    withholdingCertificateRef: null,
    reference: null,
    status: 'cleared',
    allocations: [],
  },
];

interface Faults {
  billing?: string;
  receipts?: string;
}

function world(faults: Faults = {}): { deps: SourceDeps; sources: ExportSources } {
  const upTo = <T extends { date: string }>(items: T[], asOf: string) =>
    items.filter((item) => item.date <= asOf);
  const dated = invoices.map((i) => ({ ...i, date: i.invoiceDate }));
  const credits = creditNotes
    .filter((c) => c.status === 'issued')
    .map((c) => ({ ...c, date: c.issuedOn as string }));
  const countedReceipts = receipts
    .filter((r) => r.status !== 'bounced' && r.status !== 'cancelled')
    .map((r) => ({ ...r, date: r.receiptDate }));
  const liveBills = bills
    .filter((b) => b.status !== 'draft')
    .map((b) => ({ ...b, date: b.billDate }));
  const paid = payments
    .filter((p) => p.status === 'paid')
    .map((p) => ({ ...p, date: p.paymentDate }));
  const parties: Record<string, string> = {
    c1: 'Synthetic Client A',
    c2: 'Synthetic Client B',
    v1: 'Synthetic Vendor',
    s1: 'Synthetic Subcontractor',
  };

  const deps = {
    billing: {
      invoices: {
        list: async (_d: Db, q: { offset: number }) => page(q.offset === 0 ? invoices : []),
      },
      creditNotes: {
        listForInvoice: async (_d: Db, id: string) =>
          creditNotes.filter((c) => c.invoiceId === id && id === 'inv1'),
      },
      getProjectBilling: async (_d: Db, _p: string, asOf: string) => {
        const net = (key: 'baseAmount' | 'taxTotal') =>
          sum([
            ...upTo(dated, asOf).map((i) => i[key]),
            ...upTo(credits, asOf).map((c) => Money.of(c[key]).negate().toString()),
          ]);
        const fault = asOf === '2026-10-31' ? (faults.billing ?? '0.00') : '0.00';
        return { base: sum([net('baseAmount'), fault]), tax: net('taxTotal'), gross: '0.00' };
      },
      getInvoice: async (_d: Db, id: string) => invoices.find((i) => i.id === id),
    },
    payables: {
      bills: {
        list: async (_d: Db, q: { status: string; offset: number }) =>
          page(q.offset === 0 ? bills.filter((b) => b.status === q.status) : []),
      },
      payments: {
        list: async (_d: Db, q: { status: string; offset: number }) =>
          page(q.offset === 0 ? payments.filter((p) => p.status === q.status) : []),
      },
      getVendorBalance: async (_d: Db, _v: string, date: string) => ({
        netPayable: sum(upTo(liveBills, date).map((b) => b.netPayable)),
        payments: sum(upTo(paid, date).map((p) => p.amount)),
        balance: sum([
          ...upTo(liveBills, date).map((b) => b.netPayable),
          ...upTo(paid, date).map((p) => Money.of(p.amount).negate().toString()),
        ]),
      }),
      ledger: {
        overview: async (_d: Db, partyId: string) => ({
          balance: { balance: partyId === 'v1' ? '22920.00' : '0.00' },
          lines:
            partyId === 'v1'
              ? [
                  {
                    date: '2026-09-01',
                    kind: 'bill',
                    reference: 'OLD',
                    documentId: 'x',
                    debit: '0.00',
                    credit: '1.00',
                    balance: '1.00',
                  },
                  {
                    date: '2026-10-06',
                    kind: 'bill',
                    reference: 'BILL-2026-0001',
                    documentId: 'b1',
                    debit: '0.00',
                    credit: '52920.00',
                    balance: '52920.00',
                  },
                  {
                    date: '2026-10-15',
                    kind: 'payment',
                    reference: 'PV-2026-0001',
                    documentId: 'pay1',
                    debit: '30000.00',
                    credit: '0.00',
                    balance: '22920.00',
                  },
                ]
              : [],
        }),
        aging: async () => ({
          rows: [
            { key: 'v1', buckets: ['1000.00', '0.00', '0.00', '0.00', '500.00'], total: '1500.00' },
            { key: 'v2', buckets: ['10.00'], total: '10.00' },
          ],
          total: '1510.00',
        }),
        withholdingReport: async (_d: Db, q: { month: string; authorityCode?: string }) => ({
          rows:
            q.month === '2026-10' && (q.authorityCode === undefined || q.authorityCode === 'FBR')
              ? [
                  {
                    authorityCode: 'FBR',
                    month: '2026-10',
                    vendorPartyId: 'v1',
                    paymentNumber: 'PV-2026-0001',
                    amount: '1296.00',
                    certificateNo: 'WC-1',
                  },
                ]
              : [],
          totals: [],
        }),
      },
    },
    receivables: {
      receipts: {
        list: async (_d: Db, q: { offset: number }) => page(q.offset === 0 ? receipts : []),
      },
      pdcs: {
        register: async () => ({
          items: [
            {
              partyId: 'c1',
              chequeNumber: '000902',
              bankName: 'Synthetic Bank',
              chequeDate: '2026-10-30',
              status: 'received',
              clearedOn: null,
              amount: '25000.00',
            },
            {
              partyId: 'c2',
              chequeNumber: '000901',
              bankName: 'Synthetic Bank',
              chequeDate: '2026-10-10',
              status: 'cleared',
              clearedOn: '2026-10-12',
              amount: '15000.00',
            },
          ],
          byStatus: {
            received: { count: 1, total: '25000.00' },
            cleared: { count: 1, total: '15000.00' },
          },
        }),
      },
      getCustomerBalance: async (_d: Db, _c: string, date: string) => ({
        receipts: sum([
          ...upTo(countedReceipts, date).map((r) => r.amount),
          date === '2026-10-31' ? (faults.receipts ?? '0.00') : '0.00',
        ]),
        withholding: sum(upTo(countedReceipts, date).map((r) => r.withheldAmount)),
      }),
      ledger: {
        statement: async (_d: Db, partyId: string) =>
          partyId === 'c1'
            ? {
                opening: '0.00',
                closing: '48000.00',
                lines: [
                  {
                    date: '2026-10-05',
                    kind: 'invoice',
                    reference: 'INV-2026-0001',
                    debit: '108000.00',
                    credit: '0.00',
                    balance: '108000.00',
                  },
                  {
                    date: '2026-10-08',
                    kind: 'receipt',
                    reference: 'RV-2026-0001',
                    debit: '0.00',
                    credit: '60000.00',
                    balance: '48000.00',
                  },
                ],
              }
            : { opening: '0.00', closing: '0.00', lines: [] },
        aging: async () => ({
          rows: [
            {
              key: 'c1',
              label: 'Synthetic Client A',
              buckets: ['10000.00', '20000.00', '0.00', '5000.00'],
              total: '35000.00',
            },
          ],
          total: '35000.00',
        }),
      },
    },
    cashbook: {
      accounts: {
        list: async () => [
          { id: 'a1', code: 'CASH-01' },
          { id: 'a2', code: 'BANK-01' },
        ],
      },
      transactions: {
        list: async (_d: Db, q: { accountId: string; offset: number }) =>
          page(
            q.offset > 0 || (q.accountId !== undefined && q.accountId !== 'a1')
              ? []
              : [
                  {
                    id: 't1',
                    number: 'CR-1',
                    txnDate: '2026-10-08',
                    direction: 'in',
                    amount: '60000.00',
                    description: null,
                    reference: 'RV-2026-0001',
                    runningBalance: '70000.00',
                    method: 'cash',
                    txnType: 'receipt',
                    counterpartyPartyId: 'c1',
                  },
                  {
                    id: 't2',
                    number: 'CP-1',
                    txnDate: '2026-10-15',
                    direction: 'out',
                    amount: '30000.00',
                    description: 'Cheque run',
                    reference: null,
                    runningBalance: '40000.00',
                    method: 'cheque',
                    txnType: 'payment',
                    counterpartyPartyId: null,
                  },
                ],
          ),
      },
      getAccountBalance: async (_d: Db, id: string, date: string) =>
        id === 'a1' ? (date === '2026-10-31' ? '40000.00' : '10000.00') : '0.00',
    },
    payroll: {
      runs: {
        list: pageOnce([
          {
            id: 'run1',
            periodId: 'per1',
            year: 2026,
            month: 10,
            status: 'paid',
            totalNet: '500000.00',
            totalPaid: '500000.00',
            totalUnpaid: '0.00',
          },
          {
            id: 'run0',
            periodId: 'per0',
            year: 2026,
            month: 9,
            status: 'paid',
            totalNet: '480000.00',
            totalPaid: '480000.00',
            totalUnpaid: '0.00',
          },
          {
            id: 'run2',
            periodId: 'per2',
            year: 2026,
            month: 10,
            status: 'draft',
            totalNet: '1.00',
            totalPaid: '0.00',
            totalUnpaid: '1.00',
          },
        ]),
        getPayrollRun: async (_d: Db, periodId: string) =>
          periodId === 'per1'
            ? { totalNet: '500000.00', totalPaid: '500000.00' }
            : { totalNet: '0.00', totalPaid: '0.00' },
      },
    },
    valuation: {
      reports: {
        getTotalValue: async () => ({
          items: [
            {
              storeId: 's1',
              itemId: 'i1',
              categoryId: 'cat-cement',
              method: 'weighted_average',
              quantity: '100.0000',
              value: '50000.00',
            },
            {
              storeId: 's1',
              itemId: 'i2',
              categoryId: 'cat-cement',
              method: 'weighted_average',
              quantity: '50.5000',
              value: '25000.50',
            },
            {
              storeId: 's2',
              itemId: 'i3',
              categoryId: null,
              method: 'fifo',
              quantity: '10.0000',
              value: '5000.00',
            },
          ],
          totalValue: '80000.50',
        }),
        movements: pageOnce([
          {
            movementId: 'mv1',
            seq: 7,
            type: 'receipt',
            postingDate: '2026-10-03',
            sourceRef: 'GRN-1',
            value: '5000.00',
          },
          {
            movementId: 'mv2',
            seq: 8,
            type: 'issue',
            postingDate: '2026-10-04',
            sourceRef: null,
            value: '1200.00',
          },
        ]),
      },
    },
    subcontracts: {
      ledger: {
        statement: async () => ({
          orders: [
            {
              number: 'WO-2026-0001',
              status: 'completed',
              contract: '200000.00',
              certified: '150000.00',
              deductions: '5000.00',
              billed: '150000.00',
              paid: '100000.00',
            },
          ],
          totals: { certified: '150000.00', billed: '150000.00', paid: '100000.00' },
        }),
      },
    },
    profitability: {
      listProjectFinancials: async () => ({
        asOf: '2026-10-31',
        items: [
          { projectId: 'p1', code: 'P-001', name: 'Boundary wall', status: 'active' },
          { projectId: 'p2', code: 'P-002', name: 'Demolition', status: 'active' },
        ],
      }),
      getProjectFinancials: async (_d: Db, id: string) =>
        id === 'p1'
          ? {
              contractValue: '1000000.00',
              costToDate: '400000.00',
              expectedMargin: '150000.00',
              cashPosition: '80000.00',
            }
          : {
              contractValue: '300000.00',
              costToDate: '10000.00',
              expectedMargin: '5000.00',
              cashPosition: '0.00',
            },
    },
    projects: {
      getProject: async (_d: Db, id: string) => ({ code: id === 'p1' ? 'P-001' : 'P-002' }),
      getCostSummary: async (_d: Db, object: { id: string }) =>
        object.id === 'p1'
          ? { totals: { committed: '100000.00', approved: '120000.00', posted: '180000.00' } }
          : { totals: { committed: '0.00', approved: '10000.00', posted: '0.00' } },
    },
    expenses: {
      claims: {
        list: async (_d: Db, q: { offset: number }) =>
          page(
            q.offset === 0
              ? [
                  {
                    id: 'ec1',
                    number: 'EX-1',
                    submittedOn: '2026-10-09',
                    total: '2500.00',
                    note: 'Site tea',
                  },
                  { id: 'ec2', number: 'EX-0', submittedOn: null, total: '1.00', note: '' },
                ]
              : [],
          ),
      },
    },
    masterData: {
      getParty: async (_d: Db, id: string) =>
        parties[id] === undefined ? undefined : { name: parties[id] },
      searchParties: async (_d: Db, q: { role: string; offset: number }) =>
        page(
          q.offset > 0
            ? []
            : q.role === 'client'
              ? [{ id: 'c1' }, { id: 'c2' }]
              : q.role === 'vendor'
                ? [{ id: 'v1' }]
                : q.role === 'subcontractor'
                  ? [{ id: 's1' }, { id: 'v1' }]
                  : [],
        ),
    },
    tax: {
      taxReportData: async (_d: Db, authority: string, month: string) =>
        authority === 'FBR' && month === '2026-10'
          ? { withholdingDeducted: { tax: '1296.00' }, withholdingSuffered: { tax: '1000.00' } }
          : { withholdingDeducted: { tax: '0.00' }, withholdingSuffered: { tax: '0.00' } },
    },
  };
  return { deps: deps as never, sources: createExportSources(deps as never) };
}

const load = async (code: ExportCode, filters: ExportFilters = period, w = world()) => {
  const loaded = await w.sources.load(db, code, filters, ctx);
  const layout = layoutOf(code);
  return {
    loaded,
    layout,
    totals: columnTotals(layout, loaded.rows),
    values: loaded.rows.map((row) => row.values),
    mismatches: controlMismatches(layout, columnTotals(layout, loaded.rows), loaded.control),
  };
};

describe('every export: rows, control totals and layout (T-1, AC-1)', () => {
  it('sales register: invoices and credit notes by authority and month; 100,000 + 50,000 - 10,000', async () => {
    const r = await load('sales_register');
    expect(
      r.values.map((v) => [
        v.doc_type,
        v.number,
        v.date,
        v.authority,
        v.party,
        v.project,
        v.base,
        v.tax,
        v.gross,
      ]),
    ).toEqual([
      [
        'invoice',
        'INV-2026-0001',
        '2026-10-05',
        'FBR',
        'Synthetic Client A',
        'P-001',
        '100000.00',
        '8000.00',
        '108000.00',
      ],
      [
        'invoice',
        'INV-2026-0002',
        '2026-10-20',
        'FBR',
        'Synthetic Client A',
        'P-001',
        '50000.00',
        '4000.00',
        '54000.00',
      ],
      [
        'credit_note',
        'CN-2026-0001',
        '2026-10-25',
        'FBR',
        'Synthetic Client A',
        'P-001',
        '-10000.00',
        '-800.00',
        '-10800.00',
      ],
    ]);
    expect(r.values[0]).toMatchObject({ fiscal_year: 'FY2026-27', month: '2026-10' });
    expect(r.totals).toMatchObject({ base: '140000.00', tax: '11200.00', gross: '151200.00' });
    expect(r.loaded.control).toEqual({ base: '140000.00', tax: '11200.00' });
    expect(r.mismatches).toEqual([]);
    expect(r.loaded.rows[0]?.tag).toEqual({ docType: 'invoice', docId: 'inv1', lineRef: '' });
    expect(r.loaded.rows[2]?.tag).toEqual({ docType: 'credit_note', docId: 'cn1', lineRef: '' });
  });

  it('sales register: filters by customer and ties out against billing for the project', async () => {
    const r = await load('sales_register', { ...period, partyId: 'c2' });
    expect(r.values).toEqual([]);
    expect(r.loaded.control).toEqual({ base: '0.00', tax: '0.00' });
  });

  it('purchase register: posted, partly paid and paid bills; net payable 52,920 + 10,584', async () => {
    const r = await load('purchase_register');
    expect(
      r.values.map((v) => [
        v.number,
        v.vendor_invoice_no,
        v.party,
        v.gross,
        v.withholding,
        v.net_payable,
      ]),
    ).toEqual([
      ['BILL-2026-0001', 'V-77', 'Synthetic Vendor', '54000.00', '1080.00', '52920.00'],
      ['BILL-2026-0002', 'V-78', 'Synthetic Vendor', '10800.00', '216.00', '10584.00'],
    ]);
    expect(r.totals).toMatchObject({ base: '60000.00', tax: '4800.00', net_payable: '63504.00' });
    expect(r.loaded.control).toEqual({ net_payable: '63504.00' });
    expect(r.mismatches).toEqual([]);
    expect((await load('purchase_register', { ...period, partyId: 'v9' })).values).toEqual([]);
  });

  it('receipts register: counted receipts only; 60,000 + 40,000 with 1,000 withheld', async () => {
    const r = await load('receipts_register');
    expect(r.values.map((v) => [v.number, v.party, v.method, v.amount, v.withheld])).toEqual([
      ['RV-2026-0001', 'Synthetic Client A', 'bank_transfer', '60000.00', '1000.00'],
      ['RV-2026-0002', 'Synthetic Client A', 'cash', '40000.00', '0.00'],
    ]);
    expect(r.loaded.control).toEqual({ amount: '100000.00', withheld: '1000.00' });
    expect(r.mismatches).toEqual([]);
    expect((await load('receipts_register', { ...period, partyId: 'c2' })).values).toEqual([]);
  });

  it('payments register: paid payments only; 30,000 + 20,000', async () => {
    const r = await load('payments_register');
    expect(r.values.map((v) => [v.number, v.method, v.cheque_no, v.amount, v.withholding])).toEqual(
      [
        ['PV-2026-0001', 'cheque', '000555', '30000.00', '1296.00'],
        ['PV-2026-0002', 'bank_transfer', null, '20000.00', '0.00'],
      ],
    );
    expect(r.loaded.control).toEqual({ amount: '50000.00' });
    expect(r.mismatches).toEqual([]);
    expect((await load('payments_register', { ...period, partyId: 'v9' })).values).toEqual([]);
  });

  it('cash and bank book: per account, in and out; net 60,000 - 30,000 = balance 40,000 - 10,000', async () => {
    const r = await load('cash_bank_book');
    expect(
      r.values.map((v) => [
        v.account,
        v.number,
        v.description,
        v.money_in,
        v.money_out,
        v.net,
        v.balance,
      ]),
    ).toEqual([
      ['CASH-01', 'CR-1', 'RV-2026-0001', '60000.00', '0.00', '60000.00', '70000.00'],
      ['CASH-01', 'CP-1', 'Cheque run', '0.00', '30000.00', '-30000.00', '40000.00'],
    ]);
    expect(r.loaded.control).toEqual({ net: '30000.00' });
    expect(r.mismatches).toEqual([]);
    const one = await load('cash_bank_book', { ...period, accountId: 'a2' });
    expect(one.values).toEqual([]);
    expect(one.loaded.control).toEqual({ net: '0.00' });
  });

  it('post-dated cheque register: by cheque date; in hand and cleared add to the status totals', async () => {
    const r = await load('pdc_register');
    expect(
      r.values.map((v) => [v.cheque_no, v.party, v.cheque_date, v.status, v.cleared_on, v.amount]),
    ).toEqual([
      ['000901', 'Synthetic Client B', '2026-10-10', 'cleared', '2026-10-12', '15000.00'],
      ['000902', 'Synthetic Client A', '2026-10-30', 'received', null, '25000.00'],
    ]);
    expect(r.loaded.control).toEqual({ amount: '40000.00' });
    expect(r.mismatches).toEqual([]);
    const mine = await load('pdc_register', { ...period, partyId: 'c1' });
    expect(mine.values).toHaveLength(1);
    expect(mine.loaded.control).toEqual({ amount: '25000.00' });
  });

  it('customer ledger: movement of the balance, 108,000 - 60,000 = closing 48,000', async () => {
    const r = await load('customer_ledger');
    expect(
      r.values.map((v) => [v.party, v.kind, v.reference, v.debit, v.credit, v.net, v.balance]),
    ).toEqual([
      [
        'Synthetic Client A',
        'invoice',
        'INV-2026-0001',
        '108000.00',
        '0.00',
        '108000.00',
        '108000.00',
      ],
      [
        'Synthetic Client A',
        'receipt',
        'RV-2026-0001',
        '0.00',
        '60000.00',
        '-60000.00',
        '48000.00',
      ],
    ]);
    expect(r.loaded.control).toEqual({ net: '48000.00' });
    expect(r.mismatches).toEqual([]);
    expect((await load('customer_ledger', { ...period, partyId: 'c2' })).values).toEqual([]);
  });

  it('vendor ledger: lines inside the period; 52,920 - 30,000 = balance 22,920', async () => {
    const r = await load('vendor_ledger');
    expect(
      r.values.map((v) => [v.party, v.kind, v.reference, v.debit, v.credit, v.net, v.balance]),
    ).toEqual([
      ['Synthetic Vendor', 'bill', 'BILL-2026-0001', '0.00', '52920.00', '52920.00', '52920.00'],
      ['Synthetic Vendor', 'payment', 'PV-2026-0001', '30000.00', '0.00', '-30000.00', '22920.00'],
    ]);
    expect(r.loaded.control).toEqual({ net: '22920.00' });
    expect(r.mismatches).toEqual([]);
  });

  it('aging: receivables and payables side by side, the fifth bucket added to the fourth', async () => {
    const r = await load('aging');
    expect(
      r.values.map((v) => [
        v.side,
        v.party,
        v.bucket_1,
        v.bucket_2,
        v.bucket_3,
        v.bucket_4,
        v.total,
      ]),
    ).toEqual([
      ['receivable', 'Synthetic Client A', '10000.00', '20000.00', '0.00', '5000.00', '35000.00'],
      ['payable', 'Synthetic Vendor', '1000.00', '0.00', '0.00', '500.00', '1500.00'],
      ['payable', 'v2', '10.00', '0.00', '0.00', '0.00', '10.00'],
    ]);
    expect(r.loaded.control).toEqual({ total: '36510.00' });
    expect(r.mismatches).toEqual([]);
    const receivable = await load('aging', { ...period, side: 'receivable' });
    expect(receivable.values).toHaveLength(1);
    expect(receivable.loaded.control).toEqual({ total: '35000.00' });
    const payable = await load('aging', { ...period, side: 'payable' });
    expect(payable.values).toHaveLength(2);
    expect(payable.loaded.control).toEqual({ total: '1510.00' });
  });

  it('withholding report: what we withheld and what clients withheld, by authority and month', async () => {
    const r = await load('withholding_report');
    expect(
      r.values.map((v) => [
        v.direction,
        v.authority,
        v.month,
        v.party,
        v.document,
        v.certificate_no,
        v.amount,
      ]),
    ).toEqual([
      [
        'client_withheld',
        'FBR',
        '2026-10',
        'Synthetic Client A',
        'RV-2026-0001',
        'WC-9',
        '1000.00',
      ],
      ['we_withheld', 'FBR', '2026-10', 'Synthetic Vendor', 'PV-2026-0001', 'WC-1', '1296.00'],
    ]);
    expect(r.loaded.control).toEqual({ amount: '2296.00' });
    expect(r.mismatches).toEqual([]);
    const onlyFbr = await load('withholding_report', { ...period, authorityCode: 'FBR' });
    expect(onlyFbr.values).toHaveLength(2);
    const other = await load('withholding_report', { ...period, authorityCode: 'PRA' });
    expect(other.values).toEqual([]);
    expect(other.loaded.control).toEqual({ amount: '0.00' });
  });

  it('payroll summary: finalized runs of the months in the period', async () => {
    const r = await load('payroll_summary');
    expect(
      r.values.map((v) => [v.fiscal_year, v.month, v.status, v.net_pay, v.paid, v.unpaid]),
    ).toEqual([['FY2026-27', '2026-10', 'paid', '500000.00', '500000.00', '0.00']]);
    expect(r.loaded.control).toEqual({ net_pay: '500000.00', paid: '500000.00' });
    expect(r.mismatches).toEqual([]);
    const wide = await load('payroll_summary', { from: '2026-09-01', to: '2026-10-31' });
    expect(wide.values.map((v) => v.month)).toEqual(['2026-09', '2026-10']);
    expect(wide.loaded.control.net_pay).toBe('500000.00');
  });

  it('stock valuation: by store, category and method; 75,000.50 + 5,000.00', async () => {
    const r = await load('stock_valuation');
    expect(r.values.map((v) => [v.store, v.category, v.method, v.quantity, v.value])).toEqual([
      ['s1', 'cat-cement', 'weighted_average', '150.5000', '75000.50'],
      ['s2', '', 'fifo', '10.0000', '5000.00'],
    ]);
    expect(r.loaded.control).toEqual({ value: '80000.50' });
    expect(r.mismatches).toEqual([]);
  });

  it('project cost and profit: cost to date against the cost ledger, 100,000 + 120,000 + 180,000', async () => {
    const r = await load('project_cost_profit');
    expect(
      r.values.map((v) => [
        v.project,
        v.contract_value,
        v.cost_total,
        v.expected_margin,
        v.cash_position,
      ]),
    ).toEqual([
      ['P-001 Boundary wall', '1000000.00', '400000.00', '150000.00', '80000.00'],
      ['P-002 Demolition', '300000.00', '10000.00', '5000.00', '0.00'],
    ]);
    expect(r.loaded.control).toEqual({ cost_total: '410000.00' });
    expect(r.mismatches).toEqual([]);
    const one = await load('project_cost_profit', { ...period, projectId: 'p2' });
    expect(one.values).toHaveLength(1);
    expect(one.loaded.control).toEqual({ cost_total: '10000.00' });
  });

  it('subcontractor statements: orders of each subcontractor against the statement totals', async () => {
    const r = await load('subcontractor_statements', { ...period, partyId: 's1' });
    expect(r.values).toEqual([
      {
        party: 'Synthetic Subcontractor',
        work_order: 'WO-2026-0001',
        status: 'completed',
        contract: '200000.00',
        certified: '150000.00',
        deductions: '5000.00',
        billed: '150000.00',
        paid: '100000.00',
      },
    ]);
    expect(r.loaded.control).toEqual({
      certified: '150000.00',
      billed: '150000.00',
      paid: '100000.00',
    });
    expect(r.mismatches).toEqual([]);
    const all = await load('subcontractor_statements');
    expect(all.values).toHaveLength(2);
  });
});

describe('a faulty owning module is caught by the control totals (T-2)', () => {
  it('shows a mismatch when billing reports more than the rows add up to', async () => {
    const r = await load('sales_register', period, world({ billing: '1.00' }));
    expect(r.mismatches).toEqual([{ column: 'base', exported: '140000.00', owning: '140001.00' }]);
  });

  it('shows a mismatch when receivables reports more receipts than are listed', async () => {
    const r = await load('receipts_register', period, world({ receipts: '5.50' }));
    expect(r.mismatches).toEqual([
      { column: 'amount', exported: '100000.00', owning: '100005.50' },
    ]);
  });
});

describe('the lines that can carry a tag', () => {
  it('lists every kind of financial document of the period with what a rule can test', async () => {
    const docs = await world().sources.taggable(
      db,
      { from: '2026-10-01', to: '2026-10-31' },
      actor,
    );
    const byType = (type: string) => docs.filter((d) => d.docType === type);
    expect(
      byType('invoice').map((d) => [d.docId, d.attrs.kind, d.number, d.party, d.amount]),
    ).toEqual([
      ['inv1', 'project_stage', 'INV-2026-0001', 'Synthetic Client A', '108000.00'],
      ['inv2', 'project_stage', 'INV-2026-0002', 'Synthetic Client A', '54000.00'],
    ]);
    expect(byType('credit_note').map((d) => [d.docId, d.description])).toEqual([
      ['cn1', 'Short work'],
    ]);
    expect(byType('bill').map((d) => [d.docId, d.attrs.kind])).toEqual([
      ['b1', 'purchase'],
      ['b2', 'subcontract'],
    ]);
    expect(byType('vendor_payment').map((d) => [d.docId, d.attrs.method, d.description])).toEqual([
      ['pay1', 'cheque', 'Cheque run'],
      ['pay2', 'bank_transfer', ''],
    ]);
    expect(byType('receipt').map((d) => d.docId)).toEqual(['rc1', 'rc2']);
    expect(byType('cash_transaction').map((d) => [d.docId, d.attrs.direction, d.party])).toEqual([
      ['t1', 'in', 'Synthetic Client A'],
      ['t2', 'out', ''],
    ]);
    expect(byType('payroll_run').map((d) => [d.docId, d.date, d.amount])).toEqual([
      ['run1', '2026-10-01', '500000.00'],
    ]);
    expect(byType('stock_movement').map((d) => [d.docId, d.attrs.direction, d.number])).toEqual([
      ['mv1', 'receipt', 'GRN-1'],
      ['mv2', 'issue', '8'],
    ]);
    expect(byType('expense_claim').map((d) => [d.docId, d.number])).toEqual([['ec1', 'EX-1']]);
  });

  it('reads the whole history when no period is given', async () => {
    const docs = await world().sources.taggable(db, {}, actor);
    expect(docs.filter((d) => d.docType === 'invoice')).toHaveLength(3);
    expect(docs.some((d) => d.docType === 'expense_claim' && d.docId === 'ec2')).toBe(true);
    expect(docs.some((d) => d.docType === 'receipt' && d.docId === 'rc5')).toBe(true);
  });
});

describe('helpers', () => {
  it('reads every page of a paged query', async () => {
    const calls: number[] = [];
    const all = await allPages(async (limit, offset) => {
      calls.push(offset);
      const items = offset < 400 ? Array.from({ length: limit }, (_, i) => offset + i) : [offset];
      return { items, total: 401 };
    });
    expect(all).toHaveLength(401);
    expect(calls).toEqual([0, 200, 400]);
    expect(await allPages(async () => ({ items: [], total: 5 }))).toEqual([]);
  });

  it('finds the previous day across a month and a year', () => {
    expect(previousDay('2026-10-01')).toBe('2026-09-30');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });

  it('lists the months of a period', () => {
    expect(monthsBetween('2026-10-15', '2026-10-31')).toEqual(['2026-10']);
    expect(monthsBetween('2026-11-30', '2027-02-01')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });
});

describe('the sum of the exported rows equals the owning total, for random data (T-8)', () => {
  it('holds for random receipts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 0, maxLength: 12 }),
        async (cents) => {
          const rows = cents.map((n, i) => ({
            ...receipts[0],
            id: `r${i}`,
            number: `RV-${i}`,
            receiptDate: '2026-10-10',
            amount: (n / 100).toFixed(2),
            withheldAmount: '0.00',
            status: 'cleared',
          }));
          const owning = sum(rows.map((r) => r.amount));
          const w = world();
          const deps = {
            ...(w.deps as unknown as Record<string, unknown>),
            receivables: {
              receipts: {
                list: async (_d: Db, q: { offset: number }) => page(q.offset === 0 ? rows : []),
              },
              getCustomerBalance: async (_d: Db, _c: string, date: string) => ({
                receipts: date >= '2026-10-10' ? owning : '0.00',
                withholding: '0.00',
              }),
            },
          };
          const sources = createExportSources(deps as never);
          const loaded = await sources.load(db, 'receipts_register', period, ctx);
          const totals = columnTotals(layoutOf('receipts_register'), loaded.rows);
          expect(totals.amount).toBe(Money.of(owning).toString());
          expect(controlMismatches(layoutOf('receipts_register'), totals, loaded.control)).toEqual(
            [],
          );
        },
      ),
      { numRuns: 30 },
    );
  });
});

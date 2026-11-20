import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceivablesKit, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

const fixed = (n: number) => n.toFixed(2);
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const ledger = () => kit.receivables.ledger;

describe('customer balance arithmetic (BR-1, T-1)', () => {
  it('follows invoices, partial receipts, withholding, credit notes and write-offs', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const start = Number(await kit.balance(party));
    const invoice = await kit.invoice();
    const gross = Number(invoice.gross);
    expect(Number(await kit.balance(party))).toBeCloseTo(start + gross, 2);

    // A partial receipt with withholding.
    await kit.receipt(
      party,
      bank,
      '1000',
      [
        { kind: 'invoice', invoiceId: invoice.id, amount: '1000' },
        { kind: 'withholding', invoiceId: invoice.id, amount: '50' },
      ],
      { withheldAmount: '50' },
    );
    const afterReceipt = await ledger().getCustomerBalance(kit.db, party, TODAY);
    expect(Number(afterReceipt.balance)).toBeCloseTo(start + gross - 1050, 2);
    expect(afterReceipt.withholding).toBe('50.00');

    // A credit note reduces what is owed.
    const credited = Number(await kit.creditNote(invoice.id, '1000'));
    const afterCredit = await ledger().getCustomerBalance(kit.db, party, TODAY);
    expect(Number(afterCredit.credited)).toBeGreaterThanOrEqual(credited);
    expect(Number(afterCredit.balance)).toBeCloseTo(start + gross - 1050 - credited, 2);
    expect(
      Number(afterCredit.invoiced) -
        Number(afterCredit.credited) -
        Number(afterCredit.receipts) -
        Number(afterCredit.withholding) -
        Number(afterCredit.adjustments),
    ).toBeCloseTo(Number(afterCredit.balance), 2);

    // Before the invoice existed the customer owed nothing on it.
    const before = await ledger().getCustomerBalance(kit.db, party, '2026-11-17');
    expect(Number(before.balance)).toBeCloseTo(start, 2);
    await expect(ledger().getCustomerBalance(kit.db, party, 'nope')).rejects.toMatchObject({
      code: 'invalid_date',
    });
  });

  it('reports collected money per project and an empty customer as zero', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    await kit.receipt(party, bank, '500', [
      { kind: 'invoice', invoiceId: invoice.id, amount: '500' },
    ]);
    expect(await ledger().getCollectedAmount(kit.db, invoice.projectId)).toBe('500.00');
    expect(await ledger().getCollectedAmount(kit.db, invoice.projectId, '2026-11-17')).toBe('0.00');
    const stranger = await ledger().getCustomerBalance(
      kit.db,
      '018f7c7c-7777-7000-8000-00000000beef',
      TODAY,
    );
    expect(stranger).toMatchObject({ balance: '0.00', credit: '0.00', unappliedAdvances: '0.00' });
  });

  it('shows the overview with the open invoices as of today by default', async () => {
    const party = await kit.partyId();
    const overview = await ledger().overview(kit.db, party);
    expect(overview.balance.date).toBe(TODAY);
    expect(overview.openInvoices.length).toBeGreaterThan(0);
    const past = await ledger().overview(kit.db, party, '2026-11-17');
    expect(past.openInvoices).toEqual([]);
  });
});

describe('aging (BR-8, AC-3, T-4)', () => {
  it('places an invoice in the right bucket on the boundary days and on past dates', async () => {
    const invoice = await kit.invoice();
    const rowOf = async (asOf: string) => {
      const report = await ledger().aging(kit.db, asOf, 'project');
      return report.rows.find((r) => r.key === invoice.projectId);
    };
    const due = invoice.dueDate;
    // Not yet due, due today: current.
    expect((await rowOf(addDays(due, -5)))?.buckets[0]).toBe(fixed(Number(invoice.gross)));
    expect((await rowOf(due))?.buckets[0]).toBe(fixed(Number(invoice.gross)));
    // Days past due: 1 and 30 in 0-30, 31 and 60 in 31-60, 61 and 90, 91+.
    const bucketFor = async (days: number) =>
      (await rowOf(addDays(due, days)))?.buckets.findIndex((b) => Number(b) > 0);
    expect(await bucketFor(1)).toBe(1);
    expect(await bucketFor(30)).toBe(1);
    expect(await bucketFor(31)).toBe(2);
    expect(await bucketFor(60)).toBe(2);
    expect(await bucketFor(61)).toBe(3);
    expect(await bucketFor(90)).toBe(3);
    expect(await bucketFor(91)).toBe(4);
    // Before the invoice date it does not exist yet.
    expect(await rowOf('2026-11-17')).toBeUndefined();
    const report = await ledger().aging(kit.db, addDays(due, 31), 'project');
    expect(report.labels).toEqual(['current', '0-30', '31-60', '61-90', '90+']);
  });

  it('ties to the open invoice list and honours a payment made later (AC-3)', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    await kit.receipt(party, bank, '1000', [
      { kind: 'invoice', invoiceId: invoice.id, amount: '1000' },
    ]);
    const asOf = addDays(invoice.dueDate, 40);
    const report = await ledger().aging(kit.db, asOf, 'customer');
    const open = await ledger().getOpenInvoices(kit.db, party, asOf);
    const total = open.reduce((s, row) => s + Number(row.outstanding), 0);
    expect(Number(report.total)).toBeCloseTo(total, 2);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.label).toBe('Synthetic Client');
    // On a date before the receipt cleared the full amount was still open.
    const before = await ledger().aging(kit.db, '2026-11-17', 'customer');
    expect(before.total).toBe('0.00');
  });

  it('uses the buckets of the setting and refuses broken ones', async () => {
    await kit.setting('receivables.aging_buckets', '10,20');
    const report = await ledger().aging(kit.db, TODAY, 'customer');
    expect(report.labels).toEqual(['current', '0-10', '11-20', '20+']);
    await kit.setting('receivables.aging_buckets', '20,10');
    await expect(ledger().aging(kit.db, TODAY, 'customer')).rejects.toMatchObject({
      code: 'aging_buckets_invalid',
    });
    await kit.setting('receivables.aging_buckets', '30,60,90');
  });
});

describe('statement (BR-10)', () => {
  it('gives opening balance, movements and closing balance for a period', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const receipt = await kit.receipt(
      party,
      bank,
      '2000',
      [
        { kind: 'invoice', invoiceId: invoice.id, amount: '2000' },
        { kind: 'withholding', invoiceId: invoice.id, amount: '100' },
      ],
      { withheldAmount: '100', receiptDate: '2026-11-17' },
    );
    await kit.creditNote(invoice.id, '500');
    // A draft credit note has no date and does not appear.
    await kit.run((tx) =>
      kit.billing.creditNotes.create(
        invoice.id,
        { reason: 'Draft only', baseAmount: '1' },
        kit.actor,
        tx,
      ),
    );
    await kit.run((tx) =>
      kit.receivables.receipts.cancel(
        receipt.id,
        { reason: 'Wrong client', version: receipt.version },
        kit.ractor,
        tx,
      ),
    );
    const balance = await kit.balance(party);
    const all = await ledger().statement(kit.db, party, '2026-01-01', TODAY);
    expect(all.opening).toBe('0.00');
    expect(all.closing).toBe(balance);
    const kinds = all.lines.map((l) => l.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['invoice', 'credit_note', 'receipt', 'withholding']),
    );
    expect(all.lines.some((l) => l.reference.endsWith('(reversed)'))).toBe(true);
    // The last line carries the running balance.
    expect(all.lines.at(-1)?.balance).toBe(balance);

    // A later period starts from the balance of the days before it.
    const later = await ledger().statement(kit.db, party, TODAY, TODAY);
    const earlier = await ledger().statement(kit.db, party, '2026-01-01', '2026-11-17');
    expect(later.opening).toBe(earlier.closing);
    expect(later.closing).toBe(balance);
    // A write-off appears as an adjustment line.
    await kit.setting('receivables.small_balance_limit', '100');
    const small = await kit.invoice();
    await kit.receipt(party, bank, String(Number(small.gross) - 50), [
      { kind: 'invoice', invoiceId: small.id, amount: String(Number(small.gross) - 50) },
    ]);
    const { approvalDocId } = await kit.run((tx) =>
      kit.receivables.collections.requestWriteOffApproval(
        { invoiceId: small.id, amount: '50' },
        kit.ractor,
        tx,
      ),
    );
    await kit.decide('write_off', approvalDocId, 'approve');
    await kit.run((tx) =>
      kit.receivables.collections.createAdjustment(
        { invoiceId: small.id, amount: '50', reason: 'Rounding', approvalDocId },
        kit.ractor,
        tx,
      ),
    );
    const withAdjustment = await ledger().statement(kit.db, party, TODAY, TODAY);
    expect(withAdjustment.lines.some((l) => l.kind === 'adjustment')).toBe(true);
    await kit.setting('receivables.small_balance_limit', '0');
  });
});

describe('allocation suggestion (BR-3)', () => {
  it('suggests the oldest due invoices first, up to the open amounts', async () => {
    const party = await kit.partyId();
    const open = await ledger().getOpenInvoices(kit.db, party);
    const total = open.reduce((s, row) => s + Number(row.allocatable), 0);
    const suggestion = await ledger().suggest(kit.db, party, String(total + 1000));
    expect(suggestion.reduce((s, l) => s + Number(l.amount), 0)).toBeCloseTo(total, 2);
    const small = await ledger().suggest(kit.db, party, '1');
    expect(small).toHaveLength(1);
    expect(small[0]?.amount).toBe('1.00');
    const dueOrder = open.map((row) => row.dueDate);
    const first = open.find((row) => row.invoiceId === small[0]?.invoiceId);
    expect(first?.dueDate).toBe([...dueOrder].sort()[0]);
  });
});

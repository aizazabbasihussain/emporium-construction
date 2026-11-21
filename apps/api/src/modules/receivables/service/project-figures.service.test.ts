import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReceivablesKit, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

describe('project collected and aging as of a date (P2-08)', () => {
  it('splits collected money into gross, withheld tax and base, leaving advances out', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const collected = (asOf: string) =>
      kit.receivables.getProjectCollected(kit.db, invoice.projectId, asOf);
    expect(await collected(TODAY)).toEqual({ gross: '0.00', withheld: '0.00', base: '0.00' });

    // Invoice: base 1,500,000, tax 150,000, gross 1,650,000. A receipt of 1,000 cash with 50
    // withheld and certified; each allocation takes the tax share (1/11) off by itself:
    // base = round(1000 x 1500000 / 1650000) + round(50 x 1500000 / 1650000) = 909.09 + 45.45.
    await kit.receipt(
      party,
      bank,
      '1000',
      [
        { kind: 'invoice', invoiceId: invoice.id, amount: '1000' },
        { kind: 'withholding', invoiceId: invoice.id, amount: '50' },
      ],
      { withheldAmount: '50', withholdingCertificateRef: 'CPR-9' },
    );
    expect(await collected(TODAY)).toEqual({ gross: '1050.00', withheld: '50.00', base: '954.54' });
    // Later days see the same; an earlier day sees nothing.
    expect(await collected('2026-11-30')).toEqual(await collected(TODAY));
    expect(await collected('2026-11-17')).toEqual({
      gross: '0.00',
      withheld: '0.00',
      base: '0.00',
    });

    // An advance that was paid and not yet applied is not collected on the project's invoices.
    const advance = await kit.advance(invoice.projectId, '100000');
    await kit.receipt(party, bank, advance.gross, [
      {
        kind: 'advance',
        invoiceId: advance.invoiceId,
        advanceId: advance.advanceId,
        amount: advance.gross,
      },
    ]);
    expect((await collected(TODAY)).gross).toBe('1050.00');
    expect(await kit.receivables.getCollectedAmount(kit.db, invoice.projectId)).not.toBe('1050.00');

    await expect(collected('not a date')).rejects.toMatchObject({ code: 'invalid_date' });
  });

  it('reports what is still owed and the oldest due date among the open invoices', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const aging = (projectId: string, asOf: string) =>
      kit.receivables.getProjectAging(kit.db, projectId, asOf);
    const first = await kit.invoice();
    expect(await aging(first.projectId, TODAY)).toEqual({
      asOf: TODAY,
      outstanding: first.gross,
      openInvoices: 1,
      oldestDueDate: first.dueDate,
    });
    // An unpaid advance invoice of the project is not a receivable here.
    await kit.advance(first.projectId, '5000');
    expect((await aging(first.projectId, TODAY)).openInvoices).toBe(1);
    // Before the invoice existed there is nothing; once paid in full there is nothing again.
    expect(await aging(first.projectId, '2026-11-17')).toEqual({
      asOf: '2026-11-17',
      outstanding: '0.00',
      openInvoices: 0,
      oldestDueDate: null,
    });
    await kit.receipt(party, bank, first.gross, [
      { kind: 'invoice', invoiceId: first.id, amount: first.gross },
    ]);
    expect(await aging(first.projectId, TODAY)).toMatchObject({
      outstanding: '0.00',
      openInvoices: 0,
      oldestDueDate: null,
    });
    await expect(aging(first.projectId, 'x')).rejects.toMatchObject({ code: 'invalid_date' });
  });
});

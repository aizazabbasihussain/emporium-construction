import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, createBillingKit, eventCount, uid, type BillingKit } from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

const create = (
  invoiceId: string,
  input: { reason: string; baseAmount?: string },
  actor = kit.actor,
) => kit.tx((tx) => kit.billing.creditNotes.create(invoiceId, input, actor, tx));
const submit = (id: string, version: number) =>
  kit.tx((tx) => kit.billing.creditNotes.submit(id, version, kit.actor, tx));
const issue = (id: string, version: number) =>
  kit.tx((tx) => kit.billing.creditNotes.issue(id, version, kit.actor, tx));
const getCredit = (id: string) => kit.billing.creditNotes.get(kit.db, id, kit.actor);

/** Created, submitted, approved by the owner and issued. */
async function issuedCredit(invoiceId: string, input: { reason: string; baseAmount?: string }) {
  const draft = await create(invoiceId, input);
  const submitted = await submit(draft.id, draft.version);
  await kit.decide('credit_note', draft.id, 'approve');
  return issue(submitted.id, submitted.version);
}

describe('credit notes (T-6, BR-9)', () => {
  it('cancelling an issued invoice takes a credit note: approval, number, tax reversed, stage released (AC-3)', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const credit = await kit.tx((tx) =>
      kit.billing.creditNotes.cancelByCreditNote(invoice.id, 'Wrong stage billed', kit.actor, tx),
    );
    expect(credit).toMatchObject({
      status: 'draft',
      number: null,
      baseAmount: '1500000.00',
      taxTotal: '150000.00',
      grossTotal: '1650000.00',
      advanceRestored: '0.00',
    });
    expect(credit.approval.status).toBe('pending');
    // Until the owner approves, the invoice stands and the credit note cannot be issued.
    expect((await kit.get(invoice.id)).status).toBe('issued');
    await expect(issue(credit.id, credit.version)).rejects.toThrow('not approved yet');
    await kit.decide('credit_note', credit.id, 'approve');
    const issuedBefore = await eventCount(kit.db, 'creditnote.issued');
    const cancelledBefore = await eventCount(kit.db, 'invoice.cancelled');
    const done = await issue(credit.id, credit.version);
    expect(done).toMatchObject({ status: 'issued', issuedOn: '2026-11-18' });
    expect(done.number).toMatch(/^CN-2026-\d{4}$/);
    expect(await kit.get(invoice.id)).toMatchObject({
      status: 'cancelled',
      number: invoice.number,
    });
    expect((await kit.schedule(project.id)).stages.map((s) => s.status)).toEqual([
      'planned',
      'planned',
      'planned',
    ]);
    expect(await eventCount(kit.db, 'creditnote.issued')).toBe(issuedBefore + 1);
    expect(await eventCount(kit.db, 'invoice.cancelled')).toBe(cancelledBefore + 1);
    expect(await auditCount(kit.db, 'billing.creditnote.issue')).toBeGreaterThan(0);
    expect((await kit.get(invoice.id)).creditedBase).toBe('1500000.00');
    // The released stage can be billed again, and a credited invoice cannot be credited twice.
    expect((await kit.draft(project.id, [1])).status).toBe('draft');
    await expect(create(invoice.id, { reason: 'again' })).rejects.toThrow('Only an issued invoice');
  });

  it('a part credit reverses tax with the stored rate; the rest credits and cancels the invoice', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    // A later rule change must not touch the credit: the snapshot rate is used.
    const rule = await kit.tx((tx) =>
      kit.tax.rules.requestSalesRule(
        {
          authorityCode: 'FBR',
          supplyKind: 'services',
          ratePercent: '18',
          taxCode: 'NEW',
          effectiveFrom: '2026-11-19',
        },
        { userId: kit.actor.userId, requestId: null },
        tx,
      ),
    );
    await kit.decide('tax_rule', rule.id, 'approve');
    const part = await issuedCredit(invoice.id, { reason: 'Discount', baseAmount: '500000' });
    expect(part).toMatchObject({
      baseAmount: '500000.00',
      taxTotal: '50000.00',
      grossTotal: '550000.00',
    });
    expect(await kit.get(invoice.id)).toMatchObject({
      status: 'issued',
      creditedBase: '500000.00',
    });
    expect((await kit.schedule(project.id)).stages[0]?.status).toBe('invoiced');
    const rest = await issuedCredit(invoice.id, { reason: 'Rest' });
    expect(rest).toMatchObject({
      baseAmount: '1000000.00',
      taxTotal: '100000.00',
      grossTotal: '1100000.00',
    });
    expect((await kit.get(invoice.id)).status).toBe('cancelled');
    const listed = await kit.billing.creditNotes.listForInvoice(kit.db, invoice.id, kit.actor);
    expect(listed.map((c) => c.status)).toEqual(['issued', 'issued']);
    expect(await kit.billing.getBilledAmount(kit.db, project.id)).toBe('0.00');
  });

  it('reports the billing of a project as of a date, net of credit notes and before advance recovery (P2-08)', async () => {
    const project = await kit.project();
    await kit.receivedAdvance(project.id, '500000');
    const invoice = await kit.issued(project.id, [1]);
    expect(invoice).toMatchObject({ advanceRecovery: '150000.00', invoiceDate: '2026-11-18' });
    kit.now.current = new Date('2026-11-20T10:00:00Z');
    await issuedCredit(invoice.id, { reason: 'Discount', baseAmount: '500000' });
    kit.now.current = new Date('2026-11-18T10:00:00Z');
    const at = (asOf: string) => kit.billing.getProjectBilling(kit.db, project.id, asOf);
    // The advance invoice is not billing, and the recovery is not taken off the base.
    expect(await at('2026-11-17')).toEqual({ base: '0.00', tax: '0.00', gross: '0.00' });
    expect(await at('2026-11-18')).toEqual({
      base: '1500000.00',
      tax: '150000.00',
      gross: invoice.grossTotal,
    });
    expect(await at('2026-11-19')).toEqual(await at('2026-11-18'));
    // The credit note counts from the day it was issued: base 500,000 and tax 50,000, and a gross of
    // 500,000 because the third of the advance recovery (50,000) goes back to the advance.
    expect(await at('2026-11-20')).toEqual({
      base: '1000000.00',
      tax: '100000.00',
      gross: '1000000.00',
    });
    await expect(kit.billing.getProjectBilling(kit.db, project.id, '2026-13-40')).rejects.toThrow();
  });

  it('gives the advance recovery of the credited invoice back to the advance', async () => {
    const project = await kit.project();
    await kit.receivedAdvance(project.id, '500000');
    const invoice = await kit.issued(project.id, [1]);
    expect(invoice.advanceRecovery).toBe('150000.00');
    const credit = await issuedCredit(invoice.id, { reason: 'Cancel stage' });
    expect(credit).toMatchObject({ advanceRestored: '150000.00', grossTotal: '1500000.00' });
    const advance = (await kit.billing.advances.list(kit.db, project.id, kit.actor))[0];
    expect(advance).toMatchObject({ applied: '0.00', status: 'received' });
  });

  it('gives the credit back to applied advances, newest first, skipping those with nothing applied', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.receivedAdvance(project.id, '100000');
    await kit.receivedAdvance(project.id, '1000');
    const first = await kit.issued(project.id, [1]);
    const second = await kit.issued(project.id, [2]);
    // Recoveries are 30,300 and 40,400: the oldest advance takes both, the newer one is untouched.
    expect([first.advanceRecovery, second.advanceRecovery]).toEqual(['30300.00', '40400.00']);
    await issuedCredit(second.id, { reason: 'Redo' });
    const after = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    expect(after.map((a) => [a.applied, a.status])).toEqual([
      ['30300.00', 'received'],
      ['0.00', 'received'],
    ]);
  });

  it('a part credit restores its share of the recovery and stops at the first advance that covers it', async () => {
    const project = await kit.project({ value: '1000000' });
    await kit.receivedAdvance(project.id, '1000');
    await kit.receivedAdvance(project.id, '100000');
    const invoice = await kit.issued(project.id, [1]);
    expect(invoice.advanceRecovery).toBe('30300.00');
    const credit = await issuedCredit(invoice.id, { reason: 'A third', baseAmount: '100000' });
    // One third of the 300,000 base gives back one third of the 30,300 recovery.
    expect(credit.advanceRestored).toBe('10100.00');
    const [oldest, newest] = await kit.billing.advances.list(kit.db, project.id, kit.actor);
    expect([oldest?.applied, newest?.applied]).toEqual(['1000.00', '19200.00']);
  });

  it('refuses a credit above what is left, counting drafts, and an amount of zero', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    await create(invoice.id, { reason: 'First', baseAmount: '1000000' });
    await expect(create(invoice.id, { reason: 'Second', baseAmount: '600000' })).rejects.toThrow(
      'exceeds the 500000.00 still creditable',
    );
    await expect(create(invoice.id, { reason: 'Zero', baseAmount: '0' })).rejects.toThrow(
      'above zero',
    );
    await expect(create(invoice.id, { reason: '  ' })).rejects.toThrow('reason is required');
  });

  it('credits only an issued invoice', async () => {
    const project = await kit.project();
    const draft = await kit.draft(project.id, [1]);
    await expect(create(draft.id, { reason: 'x' })).rejects.toThrow(
      'Only an issued invoice can be credited',
    );
  });

  it('may be submitted again only after the owner refused it, and issued only once', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const draft = await create(invoice.id, { reason: 'Mistake', baseAmount: '100000' });
    const submitted = await submit(draft.id, draft.version);
    await expect(submit(draft.id, draft.version)).rejects.toThrow('already submitted');
    await kit.decide('credit_note', draft.id, 'reject');
    await submit(draft.id, draft.version);
    await kit.decide('credit_note', draft.id, 'approve');
    await expect(submit(draft.id, draft.version)).rejects.toThrow('already submitted');
    const done = await issue(submitted.id, submitted.version);
    expect(done.status).toBe('issued');
    await expect(issue(done.id, done.version)).rejects.toThrow('already issued');
    await expect(submit(done.id, done.version)).rejects.toThrow('already issued');
  });

  it('refuses a stale version and reports missing records', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const draft = await create(invoice.id, { reason: 'x', baseAmount: '100' });
    await expect(submit(draft.id, draft.version + 3)).rejects.toThrow('changed by someone else');
    await expect(getCredit(uid(424242))).rejects.toThrow('Not found');
    await expect(create(uid(424243), { reason: 'x' })).rejects.toThrow('Not found');
    await expect(submit(uid(424244), 1)).rejects.toThrow('Not found');
    await expect(
      kit.billing.creditNotes.listForInvoice(kit.db, uid(424245), kit.actor),
    ).rejects.toThrow('Not found');
  });

  it('hides credit notes of a project the user cannot reach', async () => {
    const project = await kit.project();
    const invoice = await kit.issued(project.id, [1]);
    const draft = await create(invoice.id, { reason: 'x', baseAmount: '100' });
    await expect(create(invoice.id, { reason: 'x' }, kit.outsider)).rejects.toThrow('Not found');
    await expect(kit.billing.creditNotes.get(kit.db, draft.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
    await expect(
      kit.billing.creditNotes.listForInvoice(kit.db, invoice.id, kit.outsider),
    ).rejects.toThrow('Not found');
    await expect(
      kit.tx((tx) => kit.billing.creditNotes.submit(draft.id, draft.version, kit.outsider, tx)),
    ).rejects.toThrow('Not found');
  });
});

describe('credit notes against advance invoices (BR-8, BR-9)', () => {
  it('a part credit keeps the advance; the full credit of an unused advance refunds it', async () => {
    const project = await kit.project();
    const advanceId = await kit.receivedAdvance(project.id, '100000');
    const advanceInvoice = (await kit.billing.listInvoicesForProject(kit.db, project.id))[0];
    const id = (advanceInvoice as { id: string }).id;
    await issuedCredit(id, { reason: 'Part', baseAmount: '10000' });
    expect((await kit.billing.advances.list(kit.db, project.id, kit.actor))[0]?.status).toBe(
      'received',
    );
    await issuedCredit(id, { reason: 'Rest' });
    const advance = (await kit.billing.advances.list(kit.db, project.id, kit.actor)).find(
      (a) => a.id === advanceId,
    );
    expect(advance?.status).toBe('refunded');
    expect((await kit.get(id)).status).toBe('cancelled');
  });

  it('refuses to credit an advance that has been applied to invoices', async () => {
    const project = await kit.project();
    await kit.receivedAdvance(project.id, '100000');
    await kit.issued(project.id, [1]);
    const advanceInvoice = (await kit.billing.listInvoicesForProject(kit.db, project.id)).find(
      (i) => i.sourceType === 'advance',
    );
    await expect(create((advanceInvoice as { id: string }).id, { reason: 'x' })).rejects.toThrow(
      'already applied to invoices',
    );
  });
});

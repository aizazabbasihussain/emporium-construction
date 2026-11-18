import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNTANT, createBillingKit, uid, type BillingKit } from '../test-support.js';

let kit: BillingKit;
beforeAll(async () => {
  kit = await createBillingKit();
}, 120_000);
afterAll(() => kit.close());

const request = (projectId: string, amount: string, actor = kit.actor) =>
  kit.tx((tx) =>
    kit.billing.advances.request({ projectId, amount, invoiceDate: '2026-11-18' }, actor, tx),
  );
const receive = (advanceId: string) =>
  kit.tx((tx) =>
    kit.billing.markAdvanceReceived(
      advanceId,
      '2026-11-19',
      { userId: ACCOUNTANT, requestId: null },
      tx,
    ),
  );

describe('advances (BR-8)', () => {
  it('a request creates the advance and its advance invoice, taxed like any invoice', async () => {
    const project = await kit.project();
    const { advance, invoice } = await request(project.id, '500000');
    expect(advance).toMatchObject({
      projectId: project.id,
      amount: '500000.00',
      applied: '0.00',
      receivedOn: null,
      status: 'requested',
      invoiceId: invoice.id,
    });
    expect(invoice).toMatchObject({
      sourceType: 'advance',
      status: 'draft',
      baseAmount: '500000.00',
    });
    expect(invoice.lines).toEqual([
      expect.objectContaining({ description: 'Advance payment', scheduleId: null }),
    ]);
    const figures = await kit.billing.invoices.preview(kit.db, invoice.id, kit.actor);
    expect([figures.taxTotal, figures.grossTotal, figures.advanceRecovery]).toEqual([
      '50000.00',
      '550000.00',
      '0.00',
    ]);
  });

  it('becomes a received customer credit only after its invoice is issued, and only once', async () => {
    const project = await kit.project();
    const { advance, invoice } = await request(project.id, '100000');
    await expect(receive(advance.id)).rejects.toThrow('advance invoice must be issued');
    await kit.tx((tx) => kit.billing.invoices.submit(invoice.id, invoice.version, kit.actor, tx));
    await kit.decide('invoice', invoice.id, 'approve');
    const approved = await kit.get(invoice.id);
    await kit.tx((tx) => kit.billing.invoices.issue(approved.id, approved.version, kit.actor, tx));
    expect(await receive(advance.id)).toMatchObject({
      status: 'received',
      receivedOn: '2026-11-19',
    });
    await expect(receive(advance.id)).rejects.toThrow('already received');
    const summary = await kit.billing.advances.summary(kit.db, project.id, kit.actor);
    expect(summary.unappliedAdvance).toBe('100000.00');
    expect(summary.invoices).toBe(1);
    expect(summary.advances).toHaveLength(1);
  });

  it('reports an unknown advance and an advance without an invoice as not found', async () => {
    await expect(receive(uid(123456))).rejects.toThrow('Not found');
    const project = await kit.project();
    const id = uid(123457);
    await kit.db.query(
      `insert into bil_advances (id, project_id, party_id, amount) values ($1, $2, $3, 10)`,
      [id, project.id, uid(123458)],
    );
    await expect(receive(id)).rejects.toThrow('Not found');
  });

  it('refuses an amount at or below zero, a closed project and a user outside the project', async () => {
    const project = await kit.project();
    await expect(request(project.id, '0')).rejects.toThrow('amount must be above zero');
    await expect(request(project.id, '10', kit.outsider)).rejects.toThrow('Not found');
    await expect(kit.billing.advances.list(kit.db, project.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
    await expect(kit.billing.advances.summary(kit.db, project.id, kit.outsider)).rejects.toThrow(
      'Not found',
    );
    const detail = await kit.projects.service.get(kit.db, project.id, kit.actor);
    await kit.tx((tx) =>
      kit.projects.service.transition(
        project.id,
        'cancelled',
        detail.version,
        kit.actor as never,
        tx,
      ),
    );
    await expect(request(project.id, '10')).rejects.toThrow('cancelled project cannot be billed');
  });

  it('cancelling the draft advance invoice drops the advance from the tracker', async () => {
    const project = await kit.project();
    const { invoice } = await request(project.id, '5000');
    await kit.tx((tx) => kit.billing.invoices.cancel(invoice.id, invoice.version, kit.actor, tx));
    expect(await kit.billing.advances.list(kit.db, project.id, kit.actor)).toEqual([]);
  });
});

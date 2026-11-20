import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, eventCount } from '../billing-kit.js';
import { createReceivablesKit, MANAGEMENT, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

const GHOST = '018f7c7c-7777-7000-8000-00000000dead';
const collections = () => kit.receivables.collections;

describe('follow-ups', () => {
  it('creates, updates, completes and deletes a follow-up', async () => {
    const party = await kit.partyId();
    const created = await kit.run((tx) =>
      collections().createFollowup(
        {
          partyId: party,
          dueDate: '2026-11-25',
          note: ' Call the client ',
          assignedTo: kit.actor.userId,
        },
        kit.ractor,
        tx,
      ),
    );
    expect(created).toMatchObject({
      note: 'Call the client',
      status: 'open',
      assignedTo: kit.actor.userId,
    });
    const moved = await kit.run((tx) =>
      collections().updateFollowup(
        created.id,
        {
          dueDate: '2026-11-30',
          note: 'Visit the client',
          assignedTo: kit.actor.userId,
          version: created.version,
        },
        kit.ractor,
        tx,
      ),
    );
    expect(moved).toMatchObject({ dueDate: '2026-11-30', note: 'Visit the client' });
    await expect(
      kit.run((tx) =>
        collections().updateFollowup(
          created.id,
          { note: 'Old', version: created.version },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    const done = await kit.run((tx) =>
      collections().updateFollowup(
        created.id,
        { status: 'done', version: moved.version },
        kit.ractor,
        tx,
      ),
    );
    expect(done.status).toBe('done');
    await expect(
      kit.run((tx) =>
        collections().updateFollowup(
          created.id,
          { note: 'More', version: done.version },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'followup_closed' });
    expect(
      await collections().listFollowups(kit.db, { partyId: party, status: 'done' }),
    ).toHaveLength(1);
    expect((await collections().listFollowups(kit.db, {})).length).toBeGreaterThan(0);

    const other = await kit.run((tx) =>
      collections().createFollowup(
        { partyId: party, dueDate: TODAY, note: 'Again' },
        kit.ractor,
        tx,
      ),
    );
    await expect(
      kit.run((tx) => collections().deleteFollowup(other.id, other.version + 1, kit.ractor, tx)),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await kit.run((tx) => collections().deleteFollowup(other.id, other.version, kit.ractor, tx));
    expect(
      (await collections().listFollowups(kit.db, { partyId: party })).map((f) => f.id),
    ).not.toContain(other.id);
    expect(await auditCount(kit.db, 'receivables.followup.delete')).toBe(1);
    expect(await eventCount(kit.db, 'followup.changed')).toBeGreaterThan(2);
  });

  it('refuses empty notes, unknown customers and unknown follow-ups', async () => {
    const party = await kit.partyId();
    await expect(
      kit.run((tx) =>
        collections().createFollowup({ partyId: party, dueDate: TODAY, note: ' ' }, kit.ractor, tx),
      ),
    ).rejects.toMatchObject({ code: 'note_required' });
    await expect(
      kit.run((tx) =>
        collections().createFollowup({ partyId: GHOST, dueDate: TODAY, note: 'x' }, kit.ractor, tx),
      ),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      kit.run((tx) => collections().updateFollowup(GHOST, { version: 1 }, kit.ractor, tx)),
    ).rejects.toMatchObject({ code: 'followup_not_found' });
    await expect(
      kit.run((tx) => collections().deleteFollowup(GHOST, 1, kit.ractor, tx)),
    ).rejects.toMatchObject({ code: 'followup_not_found' });
  });
});

describe('small-balance write-offs (BR-11)', () => {
  /** An invoice with `left` PKR still owing. */
  async function nearlyPaid(left: number) {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const paid = (Number(invoice.gross) - left).toFixed(2);
    await kit.receipt(party, bank, paid, [
      { kind: 'invoice', invoiceId: invoice.id, amount: paid },
    ]);
    return { party, invoice };
  }
  const request = (invoiceId: string, amount: string) =>
    kit.run((tx) =>
      collections().requestWriteOffApproval(
        { invoiceId, amount, note: 'Rounding' },
        kit.ractor,
        tx,
      ),
    );
  const write = (
    invoiceId: string,
    amount: string,
    approvalDocId: string | undefined,
    actor = kit.ractor,
    extra = {},
  ) =>
    kit.run((tx) =>
      collections().createAdjustment(
        { invoiceId, amount, reason: 'Rounding', approvalDocId, ...extra },
        actor,
        tx,
      ),
    );

  it('closes the balance of an invoice after the owner approved it', async () => {
    await kit.setting('receivables.small_balance_limit', '100');
    const { party, invoice } = await nearlyPaid(40);
    const before = Number(await kit.balance(party));
    const { approvalDocId } = await request(invoice.id, '40');
    await kit.decide('write_off', approvalDocId, 'approve');
    const adjustment = await write(invoice.id, '40', approvalDocId, kit.ractor, {
      adjustmentDate: TODAY,
    });
    expect(adjustment).toMatchObject({ amount: '40.00', partyId: party, approvedBy: MANAGEMENT });
    expect(Number(await kit.balance(party))).toBeCloseTo(before - 40, 2);
    expect((await collections().listAdjustments(kit.db, party)).map((a) => a.id)).toContain(
      adjustment.id,
    );
    expect(
      (await kit.receivables.getOpenInvoices(kit.db, party)).some(
        (row) => row.invoiceId === invoice.id,
      ),
    ).toBe(false);
    // The approval is used up.
    await expect(write(invoice.id, '1', approvalDocId)).rejects.toMatchObject({
      kind: 'rule_violation',
    });
  });

  it('refuses without a usable approval', async () => {
    await kit.setting('receivables.small_balance_limit', '100');
    const { invoice } = await nearlyPaid(40);
    await expect(write(invoice.id, '10', undefined)).rejects.toMatchObject({
      code: 'approval_required',
    });
    await expect(write(invoice.id, '10', GHOST)).rejects.toMatchObject({
      code: 'approval_not_found',
    });
    const pending = await request(invoice.id, '10');
    await expect(write(invoice.id, '10', pending.approvalDocId)).rejects.toMatchObject({
      code: 'approval_not_approved',
    });
    await kit.decide('write_off', pending.approvalDocId, 'approve');
    // The approver cannot record it; a larger amount than approved is refused; a smaller one is used up once.
    const asApprover = { ...kit.ractor, userId: MANAGEMENT };
    await expect(write(invoice.id, '10', pending.approvalDocId, asApprover)).rejects.toMatchObject({
      code: 'approver_cannot_record',
    });
    await expect(write(invoice.id, '11', pending.approvalDocId)).rejects.toMatchObject({
      code: 'approval_amount_exceeded',
    });
    await write(invoice.id, '10', pending.approvalDocId);
    await expect(write(invoice.id, '10', pending.approvalDocId)).rejects.toMatchObject({
      code: 'approval_used',
    });
  });

  it('refuses above the limit, above the balance and for an unknown invoice', async () => {
    await kit.setting('receivables.small_balance_limit', '100');
    const { invoice } = await nearlyPaid(40);
    await expect(write(invoice.id, '101', GHOST)).rejects.toMatchObject({
      code: 'write_off_above_limit',
    });
    await expect(write(invoice.id, '50', GHOST)).rejects.toMatchObject({
      code: 'write_off_above_balance',
    });
    await expect(write(GHOST, '10', GHOST)).rejects.toMatchObject({ code: 'invoice_not_found' });
    await expect(
      kit.run((tx) =>
        collections().createAdjustment(
          { invoiceId: invoice.id, amount: '10', reason: ' ' },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'reason_required' });
    await kit.setting('receivables.small_balance_limit', '0');
    await expect(write(invoice.id, '1', GHOST)).rejects.toMatchObject({
      code: 'write_off_above_limit',
    });
  });
});

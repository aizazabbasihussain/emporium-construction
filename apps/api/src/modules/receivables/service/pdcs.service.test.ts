import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditCount, eventCount } from '../billing-kit.js';
import { ACCOUNTANT, createReceivablesKit, TODAY, type ReceivablesKit } from '../test-support.js';

let kit: ReceivablesKit;
beforeAll(async () => {
  kit = await createReceivablesKit();
});
afterAll(async () => {
  await kit.close();
});

const GHOST = '018f7c7c-7777-7000-8000-00000000dead';
const pdcs = () => kit.receivables.pdcs;
const deposit = (id: string, version: number, accountId: string, extra = {}) =>
  kit.run((tx) => pdcs().deposit(id, { accountId, version, ...extra }, kit.ractor, tx));
const clear = (id: string, version: number) =>
  kit.run((tx) => pdcs().clear(id, { version }, kit.ractor, tx));
const bounce = (id: string, version: number, reason = 'Insufficient funds') =>
  kit.run((tx) => pdcs().bounce(id, { reason, version }, kit.ractor, tx));
const half = (gross: string) => (Number(gross) / 2).toFixed(2);

describe('paying an invoice with a cheque and a transfer (AC-1, T-3)', () => {
  it('clears the cheque into the cash book once and reaches a zero balance', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const part = half(invoice.gross);
    const before = Number(await kit.balance(party));
    const { receipt, pdc } = await kit.cheque(party, part, [
      { kind: 'invoice', invoiceId: invoice.id, amount: part },
    ]);
    expect(receipt.status).toBe('pending_clearing');
    expect(pdc.status).toBe('received');
    // A cheque in hand moves no cash and does not reduce the balance yet.
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe('0.00');
    expect(Number(await kit.balance(party))).toBe(before);
    // ...but its allocation is reserved, so the invoice cannot be over-allocated.
    const open = (await kit.receivables.getOpenInvoices(kit.db, party)).find(
      (row) => row.invoiceId === invoice.id,
    );
    expect(open).toMatchObject({ pending: part, allocatable: part });
    await expect(
      kit.receipt(party, bank, invoice.gross, [
        { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
      ]),
    ).rejects.toMatchObject({ code: 'over_allocation' });

    const deposited = await deposit(pdc.id, pdc.version, bank);
    expect(deposited).toMatchObject({ status: 'deposited', depositedOn: TODAY });
    const cleared = await clear(pdc.id, deposited.version);
    expect(cleared).toMatchObject({ status: 'cleared', clearedOn: TODAY });
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe(part);
    // Clearing again is refused and posts nothing more.
    await expect(clear(pdc.id, cleared.version)).rejects.toMatchObject({
      code: 'pdc_transition_forbidden',
    });
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe(part);

    await kit.receipt(party, bank, part, [
      { kind: 'invoice', invoiceId: invoice.id, amount: part },
    ]);
    expect(
      (await kit.receivables.getOpenInvoices(kit.db, party)).some(
        (row) => row.invoiceId === invoice.id,
      ),
    ).toBe(false);
    expect(Number(await kit.balance(party))).toBeCloseTo(before - Number(invoice.gross), 2);
    expect(await eventCount(kit.db, 'pdc.cleared')).toBeGreaterThan(0);
    expect(await auditCount(kit.db, 'receivables.pdc.cleared')).toBeGreaterThan(0);
  });
});

describe('depositing (BR-6)', () => {
  it('needs a reason before the cheque date and records it', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const { pdc } = await kit.cheque(party, '100', [], { chequeDate: '2026-11-25' });
    await expect(deposit(pdc.id, pdc.version, bank)).rejects.toMatchObject({
      code: 'pdc_before_cheque_date',
    });
    const done = await deposit(pdc.id, pdc.version, bank, { overrideReason: 'Client agreed' });
    expect(done.earlyDepositReason).toBe('Client agreed');
    expect(done.depositAccountId).toBe(bank);
  });

  it('refuses an unknown cheque or account, a stale version and a second deposit', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const { pdc } = await kit.cheque(party, '100');
    await expect(deposit(GHOST, 1, bank)).rejects.toMatchObject({ code: 'pdc_not_found' });
    await expect(deposit(pdc.id, pdc.version + 1, bank)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    await expect(deposit(pdc.id, pdc.version, GHOST)).rejects.toMatchObject({ kind: 'not_found' });
    const done = await deposit(pdc.id, pdc.version, bank, { depositedOn: TODAY });
    await expect(deposit(pdc.id, done.version, bank)).rejects.toMatchObject({
      code: 'pdc_transition_forbidden',
    });
  });
});

describe('bouncing (AC-2, T-3, T-7)', () => {
  it('reopens the invoice and reverses the cash of a cleared cheque', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const open = await kit.balance(party);
    const { pdc } = await kit.clearedCheque(party, bank, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe(invoice.gross);
    expect(Number(await kit.balance(party))).toBeCloseTo(Number(open) - Number(invoice.gross), 2);

    const bounced = await bounce(pdc.id, pdc.version);
    expect(bounced).toMatchObject({ status: 'bounced', bouncedOn: TODAY });
    const receipt = await kit.receivables.receipts.get(kit.db, pdc.receiptId);
    expect(receipt.status).toBe('bounced');
    expect(receipt.reversalTxnId).not.toBeNull();
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe('0.00');
    expect(await kit.balance(party)).toBe(open);
    const reopened = await kit.receivables.getOpenInvoices(kit.db, party);
    expect(reopened.find((row) => row.invoiceId === invoice.id)?.outstanding).toBe(invoice.gross);

    // A follow-up is opened and the accountant is told.
    const followups = await kit.receivables.collections.listFollowups(kit.db, { status: 'open' });
    expect(followups.find((f) => f.pdcId === pdc.id)).toMatchObject({
      partyId: party,
      invoiceId: invoice.id,
    });
    const inbox = await kit.notifications.service.list(kit.db, ACCOUNTANT);
    expect(JSON.stringify(inbox)).toContain('pdc.bounced');
    expect(await eventCount(kit.db, 'pdc.bounced')).toBeGreaterThan(0);

    // Re-receiving the money restores the balances exactly.
    await kit.receipt(party, bank, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    expect(Number(await kit.balance(party))).toBeCloseTo(Number(open) - Number(invoice.gross), 2);
  });

  it('bounces a deposited cheque that never reached the cash book', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const { pdc } = await kit.cheque(party, '250');
    const deposited = await deposit(pdc.id, pdc.version, bank);
    const bounced = await bounce(pdc.id, deposited.version);
    expect(bounced.status).toBe('bounced');
    expect((await kit.receivables.receipts.get(kit.db, pdc.receiptId)).reversalTxnId).toBeNull();
    expect(await kit.cashbook.getAccountBalance(kit.db, bank, TODAY)).toBe('0.00');
  });

  it('needs a reason and a cheque that can bounce, and refuses a received advance', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const { pdc } = await kit.cheque(party, '250');
    await expect(bounce(pdc.id, pdc.version)).rejects.toMatchObject({
      code: 'pdc_transition_forbidden',
    });
    const deposited = await deposit(pdc.id, pdc.version, bank);
    await expect(bounce(pdc.id, deposited.version, ' ')).rejects.toMatchObject({
      code: 'reason_required',
    });

    const project = await kit.project();
    const adv = await kit.advance(project.id, '3000');
    const cleared = await kit.clearedCheque(party, bank, adv.gross, [
      { kind: 'advance', invoiceId: adv.invoiceId, advanceId: adv.advanceId, amount: adv.gross },
    ]);
    await expect(bounce(cleared.pdc.id, cleared.pdc.version)).rejects.toMatchObject({
      code: 'advance_already_received',
    });
    // A deposited advance cheque has not told billing anything yet, so it can bounce.
    const second = await kit.cheque(party, adv.gross, []);
    const dep = await deposit(second.pdc.id, second.pdc.version, bank);
    expect((await bounce(second.pdc.id, dep.version)).status).toBe('bounced');
  });
});

describe('returning and replacing (BR-6)', () => {
  it('gives back a cheque in hand or a bounced one, nothing else', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const held = await kit.cheque(party, '100');
    const returned = await kit.run((tx) =>
      pdcs().giveBack(held.pdc.id, { version: held.pdc.version }, kit.ractor, tx),
    );
    expect(returned.status).toBe('returned');
    expect((await kit.receivables.receipts.get(kit.db, held.receipt.id)).status).toBe('cancelled');

    const other = await kit.cheque(party, '100');
    const dep = await deposit(other.pdc.id, other.pdc.version, bank);
    await expect(
      kit.run((tx) => pdcs().giveBack(other.pdc.id, { version: dep.version }, kit.ractor, tx)),
    ).rejects.toMatchObject({ code: 'pdc_transition_forbidden' });
    const bounced = await bounce(other.pdc.id, dep.version);
    const back = await kit.run((tx) =>
      pdcs().giveBack(
        other.pdc.id,
        { reason: 'Client collected it', version: bounced.version },
        kit.ractor,
        tx,
      ),
    );
    expect(back.status).toBe('returned');
    expect((await kit.receivables.receipts.get(kit.db, other.receipt.id)).status).toBe('bounced');
  });

  it('replaces a bounced cheque with a new one that carries the same allocations', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const invoice = await kit.invoice();
    const first = await kit.cheque(party, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    const dep = await deposit(first.pdc.id, first.pdc.version, bank);
    const bounced = await bounce(first.pdc.id, dep.version);
    const replacement = await kit.run((tx) =>
      pdcs().replace(
        first.pdc.id,
        {
          cheque: { chequeNumber: 'CH-002', bankName: 'Other Bank', chequeDate: TODAY },
          version: bounced.version,
        },
        kit.ractor,
        tx,
      ),
    );
    expect(replacement).toMatchObject({
      chequeNumber: 'CH-002',
      status: 'received',
      amount: invoice.gross,
    });
    const old = await pdcs().get(kit.db, first.pdc.id);
    expect(old).toMatchObject({ status: 'replaced', replacedByPdcId: replacement.id });
    const receipt = await kit.receivables.receipts.get(kit.db, replacement.receiptId);
    expect(receipt.allocations).toHaveLength(1);
    expect(receipt.status).toBe('pending_clearing');
  });

  it('replaces a cheque still in hand and cancels its receipt', async () => {
    const party = await kit.partyId();
    const invoice = await kit.invoice();
    const first = await kit.cheque(party, invoice.gross, [
      { kind: 'invoice', invoiceId: invoice.id, amount: invoice.gross },
    ]);
    const replacement = await kit.run((tx) =>
      pdcs().replace(
        first.pdc.id,
        {
          cheque: { chequeNumber: 'CH-003', bankName: 'Bank', chequeDate: TODAY },
          version: first.pdc.version,
        },
        kit.ractor,
        tx,
      ),
    );
    expect((await kit.receivables.receipts.get(kit.db, first.receipt.id)).status).toBe('cancelled');
    expect(replacement.status).toBe('received');
    // A cleared cheque cannot be replaced.
    const bank = await kit.bank();
    const cleared = await kit.clearedCheque(party, bank, '10');
    await expect(
      kit.run((tx) =>
        pdcs().replace(
          cleared.pdc.id,
          {
            cheque: { chequeNumber: 'X', bankName: 'B', chequeDate: TODAY },
            version: cleared.pdc.version,
          },
          kit.ractor,
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'pdc_transition_forbidden' });
  });
});

describe('the register and the reminder (BR-7, T-8)', () => {
  it('lists cheques by status and date with the upcoming ones and the value in hand', async () => {
    const party = await kit.partyId();
    const bank = await kit.bank();
    const soon = await kit.cheque(party, '700', [], {
      chequeDate: '2026-11-21',
      chequeNumber: 'SOON',
    });
    const later = await kit.cheque(party, '900', [], {
      chequeDate: '2026-12-30',
      chequeNumber: 'LATER',
    });
    await deposit(later.pdc.id, later.pdc.version, bank, { overrideReason: 'Early' });
    const register = await pdcs().register(kit.db, {});
    expect(register.upcoming.map((p) => p.chequeNumber)).toContain('SOON');
    expect(register.upcoming.map((p) => p.chequeNumber)).not.toContain('LATER');
    expect(register.byStatus.received?.count).toBeGreaterThan(0);
    expect(register.byStatus.deposited?.total).toBeDefined();
    expect(Number(register.totalInHand)).toBeGreaterThanOrEqual(1600);
    const filtered = await pdcs().register(kit.db, {
      status: 'received',
      from: '2026-11-21',
      to: '2026-11-21',
    });
    expect(
      filtered.items.every((p) => p.status === 'received' && p.chequeDate === '2026-11-21'),
    ).toBe(true);
    expect(filtered.items.map((p) => p.id)).toContain(soon.pdc.id);
    expect((await pdcs().get(kit.db, soon.pdc.id)).chequeNumber).toBe('SOON');
    await expect(pdcs().get(kit.db, GHOST)).rejects.toMatchObject({ code: 'pdc_not_found' });
  });

  it('reminds the accountant once a day from 09:00 Karachi', async () => {
    const remind = (iso: string) =>
      kit.run((tx) => kit.receivables.remindUpcomingPdcs(tx, new Date(iso)));
    // 03:59 UTC is 08:59 in Karachi: not yet, and nothing is claimed.
    expect(await remind('2030-03-10T03:59:00Z')).toBe(0);
    const party = await kit.partyId();
    await kit.cheque(party, '100', [], { chequeDate: '2030-03-12', chequeNumber: 'R1' });
    await kit.cheque(party, '200', [], { chequeDate: '2030-03-17', chequeNumber: 'R2' });
    await kit.cheque(party, '300', [], { chequeDate: '2030-03-18', chequeNumber: 'R3' });
    expect(await remind('2030-03-10T04:00:00Z')).toBe(2);
    expect(await remind('2030-03-10T05:00:00Z')).toBe(0);
    // A day with nothing due still claims the day and sends nothing.
    expect(await remind('2031-01-01T04:00:00Z')).toBe(0);
    expect(await remind('2031-01-01T06:00:00Z')).toBe(0);
    const inbox = JSON.stringify(await kit.notifications.service.list(kit.db, ACCOUNTANT));
    expect(inbox.match(/pdc\.upcoming/g)?.length).toBe(1);
  });
});

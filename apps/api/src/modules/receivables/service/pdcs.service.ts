import { BusinessDate, Money } from '@emporium/domain/kernel';
import {
  assertDepositable,
  isReminderTime,
  isUpcoming,
  nextPdcStatus,
  type PdcStatus,
} from '@emporium/domain/receivables';
import {
  assertFound,
  assertNoReceivedAdvance,
  assertUpdated,
  assertVersion,
} from '../policy/receivables.policy.js';
import {
  claimReminderRun,
  findPdc,
  findReceipt,
  insertFollowup,
  listAllocations,
  listPdcs,
  updatePdc,
  findPdcByReceipt,
  type PdcRow,
} from '../repo/receivables.repo.js';
import type { Actor, Db, PdcDto, PdcRegisterDto } from '../types.js';
import { requiredText, textOrNull, type Context } from './context.js';
import type { ChequeInput, ReceiptService } from './receipts.service.js';

export interface PdcQuery {
  status?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface PdcService {
  /** BR-7: cheques by status and date, the next seven days, and the value in hand. */
  register(db: Db, query: PdcQuery): Promise<PdcRegisterDto>;
  get(db: Db, id: string): Promise<PdcDto>;
  /** BR-6: deposit into a bank account; before the cheque date it needs a reason. */
  deposit(
    id: string,
    input: {
      accountId: string;
      depositedOn?: string | undefined;
      overrideReason?: string | undefined;
      version: number;
    },
    actor: Actor,
    tx: Db,
  ): Promise<PdcDto>;
  /** BR-2, BR-6: the money reaches the cash book, once. */
  clear(
    id: string,
    input: { clearedOn?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PdcDto>;
  /** BR-6: reverses the cash and the allocations, reopens the invoices, opens a follow-up. */
  bounce(
    id: string,
    input: { reason: string; bouncedOn?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PdcDto>;
  giveBack(
    id: string,
    input: { reason?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PdcDto>;
  /** BR-6: a new cheque takes the place of this one, with the same allocations. */
  replace(
    id: string,
    input: { cheque: ChequeInput; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PdcDto>;
  /** BR-7, T-8: the daily 09:00 reminder; returns how many cheques were announced. */
  remindUpcoming(tx: Db, now: Date): Promise<number>;
}

export const pdcDto = (row: PdcRow): PdcDto => ({
  id: row.id,
  receiptId: row.receipt_id,
  partyId: row.party_id,
  chequeNumber: row.cheque_number,
  bankName: row.bank_name,
  drawer: row.drawer,
  chequeDate: row.cheque_date,
  amount: row.amount,
  status: row.status as PdcStatus,
  depositAccountId: row.deposit_account_id,
  depositedOn: row.deposited_on,
  earlyDepositReason: row.early_deposit_reason,
  clearedOn: row.cleared_on,
  bouncedOn: row.bounced_on,
  bounceReason: row.bounce_reason,
  replacedByPdcId: row.replaced_by_pdc_id,
  version: row.version,
});

export function createPdcService(ctx: Context, receipts: ReceiptService): PdcService {
  const { clock, newId, cashbook, notifications } = ctx;
  const inHand = (status: string) => status === 'received' || status === 'deposited';

  const changed = (row: PdcRow, change: string) => ({
    type: `pdc.${change}`,
    payload: {
      pdcId: row.id,
      receiptId: row.receipt_id,
      partyId: row.party_id,
      amount: row.amount,
      chequeNumber: row.cheque_number,
      status: row.status,
    },
  });

  /** One locked cheque, at the version the caller saw. */
  async function lockPdc(tx: Db, id: string, version: number): Promise<PdcRow> {
    const row = assertFound(await findPdc(tx, id, true), 'pdc');
    assertVersion(row.version, version);
    return row;
  }

  async function save(
    tx: Db,
    row: PdcRow,
    values: Record<string, unknown>,
    actor: Actor,
    action: string,
  ): Promise<PdcRow> {
    const next = assertUpdated(
      await updatePdc(tx, row.id, row.version, values, actor.userId, clock.now()),
    );
    await ctx.record(tx, actor, {
      action: `receivables.pdc.${action}`,
      entityType: 'rcv_pdc',
      entityId: row.id,
      before: { status: row.status },
      after: { status: next.status, ...values },
      event: changed(next, action),
    });
    return next;
  }

  return {
    async register(db, query) {
      const rows = await listPdcs(db, query);
      const today = ctx.today();
      const windowEnd = BusinessDate.parse(today).addDays(7).toString();
      const byStatus: PdcRegisterDto['byStatus'] = {};
      let totalInHand = Money.zero();
      for (const row of rows) {
        const entry = byStatus[row.status] ?? { count: 0, total: '0.00' };
        byStatus[row.status] = {
          count: entry.count + 1,
          total: Money.of(entry.total).add(Money.of(row.amount)).toString(),
        };
        if (inHand(row.status)) totalInHand = totalInHand.add(Money.of(row.amount));
      }
      return {
        items: rows.map(pdcDto),
        upcoming: rows
          .filter(
            (row) => row.status === 'received' && isUpcoming(row.cheque_date, today, windowEnd),
          )
          .map(pdcDto),
        totalInHand: totalInHand.toString(),
        byStatus,
      };
    },

    async get(db, id) {
      return pdcDto(assertFound(await findPdc(db, id), 'pdc'));
    },

    async deposit(id, input, actor, tx) {
      const row = await lockPdc(tx, id, input.version);
      const status = nextPdcStatus(row.status as PdcStatus, 'deposit');
      const date = BusinessDate.parse(input.depositedOn ?? ctx.today()).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_pdc');
      const reason = assertDepositable(row.cheque_date, date, input.overrideReason);
      await cashbook.accounts.get(tx, input.accountId);
      return pdcDto(
        await save(
          tx,
          row,
          {
            status,
            deposit_account_id: input.accountId,
            deposited_on: date,
            early_deposit_reason: reason,
          },
          actor,
          'deposited',
        ),
      );
    },

    async clear(id, input, actor, tx) {
      const row = await lockPdc(tx, id, input.version);
      const status = nextPdcStatus(row.status as PdcStatus, 'clear');
      const date = BusinessDate.parse(input.clearedOn ?? ctx.today()).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_pdc');
      const receipt = assertFound(await findReceipt(tx, row.receipt_id, true), 'receipt');
      await receipts.clear(tx, receipt, row.deposit_account_id as string, date, actor);
      return pdcDto(await save(tx, row, { status, cleared_on: date }, actor, 'cleared'));
    },

    async bounce(id, input, actor, tx) {
      const row = await lockPdc(tx, id, input.version);
      const status = nextPdcStatus(row.status as PdcStatus, 'bounce');
      const reason = requiredText(input.reason, 'reason');
      const date = BusinessDate.parse(input.bouncedOn ?? ctx.today()).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_pdc');
      const receipt = assertFound(await findReceipt(tx, row.receipt_id, true), 'receipt');
      assertNoReceivedAdvance(
        receipt.status === 'cleared' && (await receipts.hasReceivedAdvance(tx, receipt.id)),
      );
      await receipts.end(tx, receipt, { status: 'bounced', date, reason }, actor);
      const next = await save(
        tx,
        row,
        { status, bounced_on: date, bounce_reason: reason },
        actor,
        'bounced',
      );
      const firstInvoice = (await listAllocations(tx, receipt.id))[0]?.invoice_id ?? null;
      await insertFollowup(
        tx,
        {
          id: newId(),
          party_id: receipt.party_id,
          invoice_id: firstInvoice,
          pdc_id: row.id,
          due_date: date,
          note: `Cheque ${row.cheque_number} (${row.bank_name}) bounced: ${reason}`,
          status: 'open',
        },
        actor.userId,
        clock.now(),
      );
      await notifications.notifyRole(
        'accountant',
        'pdc.bounced',
        { cheque: row.cheque_number, bank: row.bank_name, amount: row.amount, reason },
        tx,
      );
      return pdcDto(next);
    },

    async giveBack(id, input, actor, tx) {
      const row = await lockPdc(tx, id, input.version);
      const status = nextPdcStatus(row.status as PdcStatus, 'return');
      const reason = textOrNull(input.reason) ?? 'Cheque returned to the client';
      if (row.status === 'received') {
        const receipt = assertFound(await findReceipt(tx, row.receipt_id, true), 'receipt');
        await receipts.end(tx, receipt, { status: 'cancelled', date: ctx.today(), reason }, actor);
      }
      return pdcDto(await save(tx, row, { status }, actor, 'returned'));
    },

    async replace(id, input, actor, tx) {
      const row = await lockPdc(tx, id, input.version);
      const status = nextPdcStatus(row.status as PdcStatus, 'replace');
      const receipt = assertFound(await findReceipt(tx, row.receipt_id, true), 'receipt');
      const allocations = await receipts.allocationsOf(tx, receipt.id);
      if (row.status === 'received') {
        const reason = `Replaced by cheque ${input.cheque.chequeNumber}`;
        await receipts.end(tx, receipt, { status: 'cancelled', date: ctx.today(), reason }, actor);
      }
      const created = await receipts.create(
        {
          partyId: receipt.party_id,
          receiptDate: ctx.today(),
          method: 'pdc',
          amount: receipt.amount,
          reference: receipt.reference ?? undefined,
          withheldAmount: receipt.withheld_amount,
          withholdingCertificateRef: receipt.withholding_certificate_ref ?? undefined,
          cheque: input.cheque,
          allocations,
        },
        actor,
        tx,
      );
      const replacement = assertFound(await findPdcByReceipt(tx, created.id), 'pdc');
      await save(tx, row, { status, replaced_by_pdc_id: replacement.id }, actor, 'replaced');
      return pdcDto(replacement);
    },

    async remindUpcoming(tx, now) {
      if (!isReminderTime(now)) return 0;
      const today = BusinessDate.fromInstant(now);
      const day = today.toString();
      const end = today.addDays(7).toString();
      const due = (await listPdcs(tx, { status: 'received' })).filter((row) =>
        isUpcoming(row.cheque_date, day, end),
      );
      if (!(await claimReminderRun(tx, day, due.length))) return 0;
      if (due.length > 0) {
        const total = due.reduce((sum, row) => sum.add(Money.of(row.amount)), Money.zero());
        await notifications.notifyRole(
          'accountant',
          'pdc.upcoming',
          { date: day, count: due.length, total: total.toString() },
          tx,
        );
      }
      return due.length;
    },
  };
}

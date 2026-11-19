import {
  assertAfterOpening,
  assertPositiveAmount,
  assertReversible,
  assertWithinOverdraft,
  balanceOn,
  lowestBalanceFrom,
  movementOn,
  oppositeDirection,
  summarizePosition,
  type AccountKind,
  type Direction,
  type LedgerEntry,
  type TxnType,
} from '@emporium/domain/cashbook';
import { BusinessDate } from '@emporium/domain/kernel';
import {
  cashbookSettingKeys,
  cashbookSeries,
  paymentDocType,
  type CashMethod,
} from '@emporium/shared';
import {
  assertAccountActive,
  assertApproved,
  assertDifferentAccounts,
  assertFound,
  assertReversalDate,
  normalizeTag,
  requiresApproval,
  type ApprovalFacts,
} from '../policy/cashbook.policy.js';
import {
  findAccount,
  findTxn,
  findTxnByKey,
  findTxnsByPair,
  insertTxn,
  listAccounts,
  listEntries,
  paidAgainstApproval,
  searchTxns,
  setTxnTag,
  type AccountRow,
  type TxnRow,
} from '../repo/cashbook.repo.js';
import type { Actor, Db, PageResult, PositionDto, TransactionDto } from '../types.js';
import type { Context } from './context.js';
import { requiredText, textOrNull, type Recorded } from './support.js';

/** The approval document type of a manual change to a balance (BR-1). */
export const adjustmentDocType = 'cash_adjustment';

interface Source {
  counterpartyPartyId?: string | null | undefined;
  sourceModule?: string | null | undefined;
  sourceDocType?: string | null | undefined;
  sourceDocId?: string | null | undefined;
  reference?: string | null | undefined;
  description?: string | null | undefined;
  accountTag?: string | null | undefined;
  /** Callers that retry (receivables, payables, event handlers) pass a stable key (BR-2). */
  idempotencyKey?: string | undefined;
}

export interface ReceiptCommand extends Source {
  accountId: string;
  txnDate: string;
  amount: string;
  method: CashMethod;
}

export interface PaymentCommand extends Source {
  accountId: string;
  txnDate: string;
  amount: string;
  method: CashMethod;
  /** `bank_charge` needs no approval: the bank has already taken the money. */
  txnType?: 'payment' | 'bank_charge' | undefined;
  /** The approved payment request (doc id) the caller obtained (BR-5). */
  approvalDocId?: string | undefined;
}

export interface TransferCommand {
  fromAccountId: string;
  toAccountId: string;
  txnDate: string;
  amount: string;
  method?: CashMethod | undefined;
  reference?: string | undefined;
  description?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface AdjustmentCommand {
  accountId: string;
  txnDate: string;
  direction: Direction;
  amount: string;
  reason: string;
  approvalDocId?: string | undefined;
}

export interface TransactionQuery {
  accountId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  needsTag?: boolean | undefined;
  limit: number;
  offset: number;
}

interface Entry extends Source {
  accountId: string;
  txnDate: string;
  direction: Direction;
  amount: string;
  txnType: TxnType;
  method: CashMethod;
  reversesId?: string | undefined;
  reversalReason?: string | undefined;
  transferPairId?: string | undefined;
  approvalDocId?: string | undefined;
}

export interface TransactionService {
  recordReceipt(cmd: ReceiptCommand, actor: Actor, tx: Db): Promise<TransactionDto>;
  recordPayment(cmd: PaymentCommand, actor: Actor, tx: Db): Promise<TransactionDto>;
  recordTransfer(
    cmd: TransferCommand,
    actor: Actor,
    tx: Db,
  ): Promise<{ out: TransactionDto; in: TransactionDto }>;
  /** BR-1: the only way to change a balance by hand; the owner approves it. */
  recordAdjustment(cmd: AdjustmentCommand, actor: Actor, tx: Db): Promise<TransactionDto>;
  /** BR-2: a reversal posts the opposite entry; both legs of a transfer go together. */
  reverse(
    id: string,
    input: { reason: string; txnDate?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<TransactionDto[]>;
  /** BR-7: the accountant tags a transaction with a chart-of-accounts code (or clears it). */
  setTag(id: string, tag: string | null, actor: Actor, tx: Db): Promise<TransactionDto>;
  /** BR-5: asks the owner to approve a payment or an adjustment; returns the id to pass later. */
  requestApproval(
    input: {
      docType: 'payment' | 'cash_adjustment';
      amount: string;
      accountId?: string;
      note?: string;
    },
    actor: Actor,
    tx: Db,
  ): Promise<{ approvalDocId: string }>;
  get(db: Db, id: string): Promise<TransactionDto>;
  list(db: Db, query: TransactionQuery): Promise<PageResult<TransactionDto>>;
  /** BR-9: balances per account, cash and bank totals and the movement of the day. */
  getCashPosition(db: Db, date: string): Promise<PositionDto>;
  /** BR-6: the entry an advance (or any outflow from a source module) makes; system or accountant. */
  recordSourceOutflow(
    input: {
      accountId: string;
      txnDate: string;
      amount: string;
      sourceModule: string;
      sourceDocType: string;
      sourceDocId: string;
      description: string | null;
      idempotencyKey: string;
    },
    who: Recorded,
    tx: Db,
  ): Promise<TransactionDto>;
  /** BR-3, BR-1: throws when an outflow would not be allowed; writes nothing. */
  checkOutflow(
    db: Db,
    input: { accountId: string; txnDate: string; amount: string },
  ): Promise<void>;
}

export const transactionDto = (row: TxnRow): TransactionDto => ({
  id: row.id,
  number: row.number,
  accountId: row.account_id,
  txnDate: row.txn_date,
  direction: row.direction as Direction,
  amount: row.amount,
  txnType: row.txn_type as TxnType,
  counterpartyPartyId: row.counterparty_party_id,
  sourceModule: row.source_module,
  sourceDocType: row.source_doc_type,
  sourceDocId: row.source_doc_id,
  method: row.method as CashMethod,
  reference: row.reference,
  description: row.description,
  accountTag: row.account_tag,
  reconciledIn: row.reconciled_in,
  reversesId: row.reverses_id,
  reversed: row.reversed_by_id !== null,
  transferPairId: row.transfer_pair_id,
  ...(row.running_balance === undefined ? {} : { runningBalance: row.running_balance }),
});

const eventTypeOf = (entry: Entry): string => {
  if (entry.reversesId !== undefined) return 'cash.transaction.reversed';
  if (entry.txnType === 'receipt') return 'cash.receipt.recorded';
  if (entry.txnType === 'payment') return 'cash.payment.recorded';
  return 'cash.transaction.recorded';
};

export function createTransactionService(ctx: Context): TransactionService {
  const { platform, clock, newId, approvals, record } = ctx;

  /** BR-1, BR-3, BR-10: every rule that does not need a write; an outflow also keeps the balance. */
  async function validate(db: Db, entry: Entry, account: AccountRow): Promise<void> {
    assertAccountActive(account.active);
    assertPositiveAmount(entry.amount);
    assertAfterOpening(entry.txnDate, account.opening_date);
    if (entry.direction === 'out') {
      const entries = await listEntries(db, account.id);
      const added: LedgerEntry = {
        direction: 'out',
        amount: entry.amount,
        txnDate: entry.txnDate,
      };
      assertWithinOverdraft({
        kind: account.kind as AccountKind,
        allowOverdraft: account.allow_overdraft,
        lowestBalance: lowestBalanceFrom(
          account.opening_balance,
          [...entries, added],
          entry.txnDate,
        ),
      });
    }
  }

  /** Posts one entry (BR-2: append-only); a repeated idempotency key returns the first entry. */
  async function post(tx: Db, entry: Entry, who: Recorded): Promise<TxnRow> {
    const key = entry.idempotencyKey ?? `cmd:${newId()}`;
    const existing = await findTxnByKey(tx, key);
    if (existing !== undefined) return existing;
    const account = assertFound(await findAccount(tx, entry.accountId, true), 'account');
    await validate(tx, entry, account);
    const id = newId();
    const row = await insertTxn(tx, {
      id,
      number: await platform.numbering.next(cashbookSeries, tx),
      account_id: entry.accountId,
      txn_date: BusinessDate.parse(entry.txnDate).toString(),
      direction: entry.direction,
      amount: entry.amount,
      txn_type: entry.txnType,
      counterparty_party_id: textOrNull(entry.counterpartyPartyId),
      source_module: textOrNull(entry.sourceModule),
      source_doc_type: textOrNull(entry.sourceDocType),
      source_doc_id: textOrNull(entry.sourceDocId),
      method: entry.method,
      reference: textOrNull(entry.reference),
      description: textOrNull(entry.description),
      // BR-7: an explicit tag wins; otherwise the account's default tag applies.
      account_tag: normalizeTag(entry.accountTag) ?? account.account_code_tag,
      reverses_id: entry.reversesId ?? null,
      reversal_reason: entry.reversalReason ?? null,
      transfer_pair_id: entry.transferPairId ?? null,
      approval_doc_id: entry.approvalDocId ?? null,
      idempotency_key: key,
      posted_at: clock.now().toISOString(),
      posted_by: who.userId,
    });
    await record(tx, who, {
      action: `cashbook.txn.${entry.reversesId === undefined ? 'post' : 'reverse'}`,
      entityType: 'cbk_transaction',
      entityId: id,
      after: transactionDto(row),
      event: {
        type: eventTypeOf(entry),
        payload: {
          transactionId: id,
          number: row.number,
          accountId: row.account_id,
          direction: row.direction,
          amount: row.amount,
          txnDate: row.txn_date,
          txnType: row.txn_type,
          counterpartyPartyId: row.counterparty_party_id,
          sourceModule: row.source_module,
          sourceDocType: row.source_doc_type,
          sourceDocId: row.source_doc_id,
        },
      },
    });
    return row;
  }

  /** BR-5: what the approval module says about a request and how much of it is already paid. */
  async function approvalFacts(
    db: Db,
    docType: string,
    docId: string | undefined,
  ): Promise<ApprovalFacts | undefined> {
    if (docId === undefined) return undefined;
    const state = await approvals.getApprovalState(db, docType, docId);
    if (state.status === 'none') return undefined;
    return {
      status: state.status,
      amount: state.amount,
      approvers: state.actions.filter((a) => a.action === 'approve').map((a) => a.actorId),
      alreadyPaid: await paidAgainstApproval(db, docId),
    };
  }

  const sourceOf = (cmd: Source) => ({
    counterpartyPartyId: cmd.counterpartyPartyId,
    sourceModule: cmd.sourceModule,
    sourceDocType: cmd.sourceDocType,
    sourceDocId: cmd.sourceDocId,
    reference: cmd.reference,
    description: cmd.description,
    accountTag: cmd.accountTag,
    idempotencyKey: cmd.idempotencyKey,
  });

  return {
    async recordReceipt(cmd, actor, tx) {
      await ctx.checkDate(tx, cmd.txnDate, actor, 'cbk_transaction');
      const row = await post(
        tx,
        {
          ...sourceOf(cmd),
          accountId: cmd.accountId,
          txnDate: cmd.txnDate,
          direction: 'in',
          amount: cmd.amount,
          txnType: 'receipt',
          method: cmd.method,
        },
        actor,
      );
      return transactionDto(row);
    },

    async recordPayment(cmd, actor, tx) {
      await ctx.checkDate(tx, cmd.txnDate, actor, 'cbk_transaction');
      const txnType = cmd.txnType ?? 'payment';
      if (txnType === 'payment') {
        const threshold = (
          await platform.settings.get(tx, cashbookSettingKeys.paymentApprovalThreshold)
        ).value as string;
        if (requiresApproval(cmd.amount, threshold)) {
          assertApproved({
            approvalDocId: cmd.approvalDocId,
            facts: await approvalFacts(tx, paymentDocType, cmd.approvalDocId),
            amount: cmd.amount,
            actorUserId: actor.userId,
          });
        }
      }
      const row = await post(
        tx,
        {
          ...sourceOf(cmd),
          accountId: cmd.accountId,
          txnDate: cmd.txnDate,
          direction: 'out',
          amount: cmd.amount,
          txnType,
          method: cmd.method,
          approvalDocId: cmd.approvalDocId,
        },
        actor,
      );
      return transactionDto(row);
    },

    async recordTransfer(cmd, actor, tx) {
      assertDifferentAccounts(cmd.fromAccountId, cmd.toAccountId);
      await ctx.checkDate(tx, cmd.txnDate, actor, 'cbk_transaction');
      // Locks in a fixed order so two opposite transfers cannot wait on each other.
      for (const id of [cmd.fromAccountId, cmd.toAccountId].sort()) await findAccount(tx, id, true);
      const pair = newId();
      const key = cmd.idempotencyKey ?? `cmd:${pair}`;
      const common = {
        txnDate: cmd.txnDate,
        amount: cmd.amount,
        method: cmd.method ?? 'bank_transfer',
        reference: cmd.reference,
        description: cmd.description,
        transferPairId: pair,
      };
      // BR-4: both legs or neither; the second leg failing rolls the first back with the transaction.
      const out = await post(
        tx,
        {
          ...common,
          accountId: cmd.fromAccountId,
          direction: 'out',
          txnType: 'transfer_out',
          idempotencyKey: `${key}:out`,
        },
        actor,
      );
      const inbound = await post(
        tx,
        {
          ...common,
          accountId: cmd.toAccountId,
          direction: 'in',
          txnType: 'transfer_in',
          idempotencyKey: `${key}:in`,
        },
        actor,
      );
      return { out: transactionDto(out), in: transactionDto(inbound) };
    },

    async recordAdjustment(cmd, actor, tx) {
      const reason = requiredText(cmd.reason, 'reason');
      await ctx.checkDate(tx, cmd.txnDate, actor, 'cbk_transaction');
      assertApproved({
        approvalDocId: cmd.approvalDocId,
        facts: await approvalFacts(tx, adjustmentDocType, cmd.approvalDocId),
        amount: cmd.amount,
        actorUserId: actor.userId,
      });
      const row = await post(
        tx,
        {
          accountId: cmd.accountId,
          txnDate: cmd.txnDate,
          direction: cmd.direction,
          amount: cmd.amount,
          txnType: 'other',
          method: 'bank_transfer',
          description: reason,
          approvalDocId: cmd.approvalDocId,
        },
        actor,
      );
      return transactionDto(row);
    },

    async reverse(id, input, actor, tx) {
      const original = assertFound(await findTxn(tx, id, true), 'transaction');
      const legs =
        original.transfer_pair_id === null
          ? [original]
          : await findTxnsByPair(tx, original.transfer_pair_id);
      const reason = requiredText(input.reason, 'reason');
      for (const leg of legs) {
        assertReversible(
          {
            reversesId: leg.reverses_id,
            reversedById: leg.reversed_by_id,
            reconciledIn: leg.reconciled_in,
          },
          reason,
        );
      }
      const date = input.txnDate ?? ctx.today();
      await ctx.checkDate(tx, date, actor, 'cbk_transaction');
      const pair = original.transfer_pair_id === null ? undefined : newId();
      const reversed: TransactionDto[] = [];
      for (const leg of legs) {
        assertReversalDate(date, leg.txn_date);
        const row = await post(
          tx,
          {
            accountId: leg.account_id,
            txnDate: date,
            direction: oppositeDirection(leg.direction as Direction),
            amount: leg.amount,
            txnType: leg.txn_type as TxnType,
            method: leg.method as CashMethod,
            counterpartyPartyId: leg.counterparty_party_id,
            sourceModule: leg.source_module,
            sourceDocType: leg.source_doc_type,
            sourceDocId: leg.source_doc_id,
            description: `Reversal of ${leg.number}: ${reason}`,
            accountTag: leg.account_tag,
            reversesId: leg.id,
            reversalReason: reason,
            transferPairId: pair,
            idempotencyKey: `reverse:${leg.id}`,
          },
          actor,
        );
        reversed.push(transactionDto(row));
      }
      return reversed;
    },

    async setTag(id, tag, actor, tx) {
      const before = assertFound(await findTxn(tx, id, true), 'transaction');
      const next = normalizeTag(tag);
      await setTxnTag(tx, id, next);
      const row = assertFound(await findTxn(tx, id), 'transaction');
      await record(tx, actor, {
        action: 'cashbook.txn.tag',
        entityType: 'cbk_transaction',
        entityId: id,
        before: { accountTag: before.account_tag },
        after: { accountTag: next },
        event: {
          type: 'cashbook.transaction.tagged',
          payload: { transactionId: id, accountTag: next },
        },
      });
      return transactionDto(row);
    },

    async requestApproval(input, actor, tx) {
      const approvalDocId = newId();
      await approvals.requestApproval(
        {
          docType: input.docType,
          docId: approvalDocId,
          amount: input.amount,
          requesterId: actor.userId,
          context: { accountId: input.accountId ?? null, note: input.note ?? null },
          requestId: actor.requestId,
        },
        tx,
      );
      return { approvalDocId };
    },

    async get(db, id) {
      return transactionDto(assertFound(await findTxn(db, id), 'transaction'));
    },

    async list(db, query) {
      const { rows, total } = await searchTxns(db, {
        accountId: query.accountId,
        from: query.from,
        to: query.to,
        needsTag: query.needsTag,
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map(transactionDto), total, limit: query.limit, offset: query.offset };
    },

    async getCashPosition(db, date) {
      const day = BusinessDate.parse(date).toString();
      const accounts = await listAccounts(db, true);
      const lines = await Promise.all(
        accounts.map(async (account) => {
          const entries = await listEntries(db, account.id);
          const movement = movementOn(entries, day);
          return {
            accountId: account.id,
            code: account.code,
            name: account.name,
            kind: account.kind as AccountKind,
            balance: balanceOn(account.opening_balance, entries, day).toString(),
            movementIn: movement.in.toString(),
            movementOut: movement.out.toString(),
          };
        }),
      );
      return { date: day, accounts: lines, ...summarizePosition(lines) };
    },

    async recordSourceOutflow(input, who, tx) {
      const row = await post(
        tx,
        {
          accountId: input.accountId,
          txnDate: input.txnDate,
          direction: 'out',
          amount: input.amount,
          txnType: 'advance',
          method: 'cash',
          sourceModule: input.sourceModule,
          sourceDocType: input.sourceDocType,
          sourceDocId: input.sourceDocId,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
        },
        who,
      );
      return transactionDto(row);
    },

    async checkOutflow(db, input) {
      const account = assertFound(await findAccount(db, input.accountId), 'account');
      await validate(
        db,
        {
          accountId: input.accountId,
          txnDate: input.txnDate,
          direction: 'out',
          amount: input.amount,
          txnType: 'advance',
          method: 'cash',
        },
        account,
      );
    },
  };
}

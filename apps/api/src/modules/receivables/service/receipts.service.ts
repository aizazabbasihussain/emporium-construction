import { BusinessDate, Money } from '@emporium/domain/kernel';
import {
  assertChequeDetails,
  checkWithholding,
  nextPdcStatus,
  validateAllocations,
} from '@emporium/domain/receivables';
import {
  receiptSeries,
  receivablesSettingKeys,
  type AllocationKind,
  type CashMethod,
  type ReceiptMethod,
  type ReceiptStatus,
} from '@emporium/shared';
import {
  assertAccountForImmediate,
  assertAdvanceMatches,
  assertAllocatable,
  assertCancellable,
  assertFound,
  assertInvoicesOfParty,
  assertPositive,
  assertReversalDate,
  assertUpdated,
  assertVersion,
  isChequeMethod,
} from '../policy/receivables.policy.js';
import {
  findPdcByReceipt,
  findReceipt,
  insertAllocation,
  insertPdc,
  insertReceipt,
  listAllocations,
  listInvoiceFigures,
  searchReceipts,
  updatePdc,
  updateReceipt,
  type InvoiceFigures,
  type ReceiptRow,
} from '../repo/receivables.repo.js';
import type { Actor, Db, PageResult, ReceiptDto, WithholdingFlagDto } from '../types.js';
import { readerActor, textOrNull, type Context } from './context.js';

export interface ChequeInput {
  chequeNumber: string;
  bankName: string;
  drawer?: string | undefined;
  chequeDate: string;
}

export interface AllocationCommand {
  kind: AllocationKind;
  invoiceId: string;
  advanceId?: string | undefined;
  amount: string;
}

export interface ReceiptCommand {
  partyId: string;
  receiptDate: string;
  method: ReceiptMethod;
  amount: string;
  accountId?: string | undefined;
  reference?: string | undefined;
  withheldAmount?: string | undefined;
  withholdingCertificateRef?: string | undefined;
  cheque?: ChequeInput | undefined;
  allocations?: AllocationCommand[] | undefined;
}

export interface ReceiptService {
  /** BR-2, BR-3: records the receipt, allocates it when allocations are given, moves cash when it clears at once. */
  create(cmd: ReceiptCommand, actor: Actor, tx: Db): Promise<ReceiptDto>;
  /** BR-3: the one-time allocation of a receipt recorded without allocations (customer credit until then). */
  allocate(id: string, allocations: AllocationCommand[], actor: Actor, tx: Db): Promise<ReceiptDto>;
  /** BR-9: cancellation with a reason; cash that moved is reversed through the cash book. */
  cancel(
    id: string,
    input: { reason: string; cancelledOn?: string | undefined; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<ReceiptDto>;
  get(db: Db, id: string): Promise<ReceiptDto>;
  list(
    db: Db,
    query: { partyId?: string | undefined; limit: number; offset: number },
  ): Promise<PageResult<ReceiptDto>>;
  /** Used by the cheque register. */
  clear(
    tx: Db,
    receipt: ReceiptRow,
    accountId: string,
    date: string,
    actor: Actor,
  ): Promise<ReceiptRow>;
  /** BR-6: a bounced receipt stops counting; cash that moved is reversed. */
  end(
    tx: Db,
    receipt: ReceiptRow,
    input: { status: 'cancelled' | 'bounced'; date: string; reason: string },
    actor: Actor,
  ): Promise<ReceiptRow>;
  dto(db: Db, row: ReceiptRow): Promise<ReceiptDto>;
  hasReceivedAdvance(db: Db, receiptId: string): Promise<boolean>;
  /** Used by replacement: re-creates the allocations of a receipt for a new one. */
  allocationsOf(db: Db, receiptId: string): Promise<AllocationCommand[]>;
}

const cashMethodOf = (method: ReceiptMethod): CashMethod =>
  isChequeMethod(method) ? 'cheque' : (method as CashMethod);

export function createReceiptService(ctx: Context): ReceiptService {
  const { platform, clock, newId, cashbook, billing, masterData } = ctx;

  const toReceiptDto = async (db: Db, row: ReceiptRow): Promise<ReceiptDto> => {
    const allocations = (await listAllocations(db, row.id)).map((a) => ({
      id: a.id,
      receiptId: a.receipt_id,
      invoiceId: a.invoice_id,
      advanceId: a.advance_id,
      amount: a.amount,
      kind: a.kind as AllocationKind,
    }));
    const allocated = allocations.reduce((s, a) => s.add(Money.of(a.amount)), Money.zero());
    const withholdingLines = allocations.filter((a) => a.kind === 'withholding');
    const flags: WithholdingFlagDto[] = [];
    if (withholdingLines.length > 0) {
      const tolerance = String(
        (await platform.settings.get(db, receivablesSettingKeys.withholdingTolerance)).value,
      );
      const figures = await listInvoiceFigures(db, {
        asOf: ctx.today(),
        invoiceIds: withholdingLines.map((a) => a.invoiceId),
      });
      for (const line of withholdingLines) {
        const invoice = figures.find((f) => f.invoice_id === line.invoiceId) as InvoiceFigures;
        // A cheque still in hand is not in the counted total yet.
        const actual = Money.of(invoice.withholding_allocated).add(
          row.status === 'pending_clearing' ? Money.of(line.amount) : Money.zero(),
        );
        flags.push({
          invoiceId: line.invoiceId,
          ...checkWithholding(invoice.withholding_expected, actual.toString(), tolerance),
        });
      }
    }
    return {
      id: row.id,
      number: row.number,
      partyId: row.party_id,
      receiptDate: row.receipt_date,
      method: row.method as ReceiptMethod,
      amount: row.amount,
      accountId: row.account_id,
      reference: row.reference,
      status: row.status as ReceiptStatus,
      withheldAmount: row.withheld_amount,
      withholdingCertificateRef: row.withholding_certificate_ref,
      cashbookTxnId: row.cashbook_txn_id,
      reversalTxnId: row.reversal_txn_id,
      clearedOn: row.cleared_on,
      cancelledOn: row.cancelled_on,
      cancelReason: row.cancel_reason,
      allocations,
      unallocated: Money.of(row.amount)
        .add(Money.of(row.withheld_amount))
        .sub(allocated)
        .toString(),
      withholdingFlags: flags,
      version: row.version,
    };
  };

  /** BR-3: every rule on a set of allocations, checked before anything is written. */
  async function checkAllocations(
    tx: Db,
    receipt: { partyId: string; amount: string; withheldAmount: string },
    commands: readonly AllocationCommand[],
  ): Promise<void> {
    const ids = [...new Set(commands.map((c) => c.invoiceId))];
    const figures = await listInvoiceFigures(tx, { asOf: ctx.today(), invoiceIds: ids });
    const known = new Map(
      figures.map((f) => [f.invoice_id, { partyId: f.party_id, sourceType: f.source_type }]),
    );
    assertInvoicesOfParty(ids, known, receipt.partyId);
    for (const command of commands.filter((c) => c.kind === 'advance')) {
      const figure = figures.find((f) => f.invoice_id === command.invoiceId) as InvoiceFigures;
      const advances = await billing.advances.list(tx, figure.project_id, readerActor);
      const advance = advances.find((a) => a.id === command.advanceId);
      assertAdvanceMatches(
        known.get(command.invoiceId)?.sourceType,
        advance?.invoiceId,
        command.invoiceId,
      );
    }
    const allocatable = new Map(
      figures.map((f) => {
        const outstanding = Money.of(f.gross)
          .sub(Money.of(f.credited))
          .sub(Money.of(f.allocated))
          .sub(Money.of(f.adjusted))
          .sub(Money.of(f.pending));
        return [f.invoice_id, outstanding.toString()];
      }),
    );
    validateAllocations({
      receiptAmount: receipt.amount,
      withheldAmount: receipt.withheldAmount,
      allocations: commands,
      allocatable,
    });
  }

  async function insertAllocations(
    tx: Db,
    receiptId: string,
    commands: readonly AllocationCommand[],
    actor: Actor,
  ): Promise<void> {
    for (const command of commands) {
      await insertAllocation(
        tx,
        {
          id: newId(),
          receipt_id: receiptId,
          invoice_id: command.invoiceId,
          advance_id: command.advanceId ?? null,
          amount: Money.of(command.amount).toString(),
          kind: command.kind,
        },
        actor.userId,
        clock.now(),
      );
    }
  }

  /** BR-5: billing learns that the money of an advance has arrived. */
  async function markAdvances(
    tx: Db,
    receiptId: string,
    date: string,
    actor: Actor,
  ): Promise<void> {
    for (const line of await listAllocations(tx, receiptId)) {
      if (line.kind === 'advance') {
        await billing.markAdvanceReceived(
          line.advance_id as string,
          date,
          { userId: actor.userId, requestId: actor.requestId },
          tx,
        );
      }
    }
  }

  async function moveMoney(
    tx: Db,
    receipt: { id: string; partyId: string; amount: string; method: ReceiptMethod; number: string },
    accountId: string,
    date: string,
    actor: Actor,
  ) {
    return cashbook.recordReceipt(
      {
        accountId,
        txnDate: date,
        amount: receipt.amount,
        method: cashMethodOf(receipt.method),
        counterpartyPartyId: receipt.partyId,
        sourceModule: 'receivables',
        sourceDocType: 'receipt',
        sourceDocId: receipt.id,
        reference: receipt.number,
        idempotencyKey: `rcv:receipt:${receipt.id}`,
      },
      actor,
      tx,
    );
  }

  const recorded = (row: ReceiptRow) => ({
    type: 'receipt.recorded',
    payload: {
      receiptId: row.id,
      number: row.number,
      partyId: row.party_id,
      amount: row.amount,
      method: row.method,
      status: row.status,
      receiptDate: row.receipt_date,
    },
  });

  const service: ReceiptService = {
    async create(cmd, actor, tx) {
      assertPositive(cmd.amount, 'amount');
      assertAccountForImmediate(cmd.method, cmd.accountId);
      if (isChequeMethod(cmd.method)) {
        assertChequeDetails({
          chequeNumber: cmd.cheque?.chequeNumber,
          bankName: cmd.cheque?.bankName,
          chequeDate: cmd.cheque?.chequeDate,
        });
      }
      const date = BusinessDate.parse(cmd.receiptDate).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_receipt');
      assertFound(await masterData.getParty(tx, cmd.partyId), 'party');
      const amount = Money.of(cmd.amount).toString();
      const withheld = Money.of(cmd.withheldAmount ?? '0').toString();
      const allocations = cmd.allocations ?? [];
      if (allocations.length > 0) {
        await checkAllocations(
          tx,
          { partyId: cmd.partyId, amount, withheldAmount: withheld },
          allocations,
        );
      }
      const id = newId();
      const number = await platform.numbering.next(receiptSeries, tx);
      const immediate = !isChequeMethod(cmd.method);
      const cash = immediate
        ? await moveMoney(
            tx,
            { id, partyId: cmd.partyId, amount, method: cmd.method, number },
            cmd.accountId as string,
            date,
            actor,
          )
        : undefined;
      const row = await insertReceipt(
        tx,
        {
          id,
          number,
          party_id: cmd.partyId,
          receipt_date: date,
          method: cmd.method,
          amount,
          account_id: cmd.accountId ?? null,
          reference: textOrNull(cmd.reference),
          status: immediate ? 'cleared' : 'pending_clearing',
          withheld_amount: withheld,
          withholding_certificate_ref: textOrNull(cmd.withholdingCertificateRef),
          cashbook_txn_id: cash?.id ?? null,
          cleared_on: immediate ? date : null,
        },
        actor.userId,
        clock.now(),
      );
      await insertAllocations(tx, id, allocations, actor);
      if (!immediate) {
        const cheque = cmd.cheque as ChequeInput;
        await insertPdc(
          tx,
          {
            id: newId(),
            receipt_id: id,
            cheque_number: cheque.chequeNumber.trim(),
            bank_name: cheque.bankName.trim(),
            drawer: textOrNull(cheque.drawer),
            cheque_date: BusinessDate.parse(cheque.chequeDate).toString(),
            amount,
          },
          actor.userId,
          clock.now(),
        );
      } else {
        await markAdvances(tx, id, date, actor);
      }
      const view = await toReceiptDto(tx, row);
      await ctx.record(tx, actor, {
        action: 'receivables.receipt.record',
        entityType: 'rcv_receipt',
        entityId: id,
        after: view,
        event: recorded(row),
      });
      return view;
    },

    async allocate(id, allocations, actor, tx) {
      const row = assertFound(await findReceipt(tx, id, true), 'receipt');
      const existing = await listAllocations(tx, id);
      assertAllocatable(row.status as ReceiptStatus, existing.length);
      await checkAllocations(
        tx,
        { partyId: row.party_id, amount: row.amount, withheldAmount: row.withheld_amount },
        allocations,
      );
      await insertAllocations(tx, id, allocations, actor);
      if (row.status === 'cleared') {
        await markAdvances(tx, id, row.cleared_on as string, actor);
      }
      const view = await toReceiptDto(tx, row);
      await ctx.record(tx, actor, {
        action: 'receivables.receipt.allocate',
        entityType: 'rcv_receipt',
        entityId: id,
        after: view,
        event: { type: 'receipt.allocated', payload: { receiptId: id, partyId: row.party_id } },
      });
      return view;
    },

    async cancel(id, input, actor, tx) {
      const row = assertFound(await findReceipt(tx, id, true), 'receipt');
      const pdc = await findPdcByReceipt(tx, id);
      const reconciled =
        row.cashbook_txn_id !== null &&
        (await cashbook.transactions.get(tx, row.cashbook_txn_id)).reconciledIn !== null;
      assertCancellable({
        status: row.status as ReceiptStatus,
        pdcStatus: pdc?.status,
        reconciled,
        advanceReceived: row.status === 'cleared' && (await service.hasReceivedAdvance(tx, id)),
        reason: input.reason,
      });
      const date = BusinessDate.parse(input.cancelledOn ?? ctx.today()).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_receipt');
      assertVersion(row.version, input.version);
      const ended = await service.end(
        tx,
        row,
        { status: 'cancelled', date, reason: input.reason.trim() },
        actor,
      );
      if (pdc !== undefined) {
        assertUpdated(
          await updatePdc(
            tx,
            pdc.id,
            pdc.version,
            { status: nextPdcStatus('received', 'return') },
            actor.userId,
            clock.now(),
          ),
        );
      }
      return toReceiptDto(tx, ended);
    },

    async get(db, id) {
      return toReceiptDto(db, assertFound(await findReceipt(db, id), 'receipt'));
    },

    async list(db, query) {
      const { rows, total } = await searchReceipts(db, query);
      return {
        items: await Promise.all(rows.map((row) => toReceiptDto(db, row))),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async clear(tx, receipt, accountId, date, actor) {
      const txn = await moveMoney(
        tx,
        {
          id: receipt.id,
          partyId: receipt.party_id,
          amount: receipt.amount,
          method: receipt.method as ReceiptMethod,
          number: receipt.number,
        },
        accountId,
        date,
        actor,
      );
      const row = assertUpdated(
        await updateReceipt(
          tx,
          receipt.id,
          receipt.version,
          { status: 'cleared', cleared_on: date, account_id: accountId, cashbook_txn_id: txn.id },
          actor.userId,
          clock.now(),
        ),
      );
      await markAdvances(tx, receipt.id, date, actor);
      return row;
    },

    async end(tx, receipt, input, actor) {
      assertReversalDate(input.date, receipt.cleared_on);
      let reversal: string | null = null;
      if (receipt.status === 'cleared') {
        const [reversed] = await cashbook.transactions.reverse(
          receipt.cashbook_txn_id as string,
          { reason: input.reason, txnDate: input.date },
          actor,
          tx,
        );
        reversal = (reversed as { id: string }).id;
      }
      const row = assertUpdated(
        await updateReceipt(
          tx,
          receipt.id,
          receipt.version,
          {
            status: input.status,
            cancelled_on: input.date,
            cancel_reason: input.reason,
            reversal_txn_id: reversal,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await ctx.record(tx, actor, {
        action: `receivables.receipt.${input.status === 'cancelled' ? 'cancel' : 'bounce'}`,
        entityType: 'rcv_receipt',
        entityId: receipt.id,
        before: { status: receipt.status },
        after: { status: row.status, reason: input.reason, reversalTxnId: reversal },
        event: {
          type: input.status === 'cancelled' ? 'receipt.cancelled' : 'receipt.bounced',
          payload: { receiptId: receipt.id, partyId: receipt.party_id, amount: receipt.amount },
        },
      });
      return row;
    },

    dto: toReceiptDto,

    async hasReceivedAdvance(db, receiptId) {
      return (await listAllocations(db, receiptId)).some((a) => a.kind === 'advance');
    },

    async allocationsOf(db, receiptId) {
      return (await listAllocations(db, receiptId)).map((a) => ({
        kind: a.kind as AllocationKind,
        invoiceId: a.invoice_id,
        advanceId: a.advance_id ?? undefined,
        amount: a.amount,
      }));
    },
  };
  return service;
}

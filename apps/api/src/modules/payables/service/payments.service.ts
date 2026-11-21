import { BusinessDate, Money } from '@emporium/domain/kernel';
import {
  allocatePayment,
  billStatusAfterPayments,
  chequeIsPostDated,
  groupByVendor,
  type BillOpenFigures,
} from '@emporium/domain/payables';
import {
  cashbookSettingKeys,
  paymentDocType,
  paymentSeries,
  type BillStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@emporium/shared';
import {
  assertAmountMatches,
  assertBillsPayable,
  assertBillTransition,
  assertChequeDetails,
  assertFound,
  assertPayable,
  assertPaymentCancellable,
  assertPaymentDraft,
  assertPaymentTransition,
  assertPositive,
  assertRunBills,
  assertSingleVendor,
  assertUpdated,
  assertVendor,
  assertVersion,
} from '../policy/payables.policy.js';
import {
  findBill,
  findDueCheques,
  findPayment,
  insertAllocation,
  insertPayment,
  insertRun,
  listAllocations,
  listBillFigures,
  listPaymentsByRun,
  searchPayments,
  updateBill,
  updatePayment,
  type OpenBillRow,
  type PaymentRow,
} from '../repo/payables.repo.js';
import type { Actor, Db, PageResult, PaymentDto, PaymentRunDto } from '../types.js';
import { requiredText, textOrNull, type Context } from './context.js';

export interface PaymentAllocationInput {
  billId: string;
  amount: string;
}

export interface PaymentInput {
  vendorPartyId: string;
  paymentDate: string;
  method: PaymentMethod;
  accountId: string;
  chequeNumber?: string | undefined;
  chequeDate?: string | undefined;
  reference?: string | undefined;
  withholdingCertificateNo?: string | undefined;
  /** When given it must equal the allocations less the withholding deducted. */
  amount?: string | undefined;
  allocations: PaymentAllocationInput[];
}

export interface PaymentRunInput {
  billIds: string[];
  paymentDate: string;
  method: PaymentMethod;
  accountId: string;
  /** One cheque number per vendor, in the order the vendors first appear in the selection. */
  chequeNumbers?: string[] | undefined;
  chequeDate?: string | undefined;
  note?: string | undefined;
}

export interface PaymentService {
  create(input: PaymentInput, actor: Actor, tx: Db): Promise<PaymentDto>;
  /** BR-7: asks for approval above the cash book's band; otherwise the payment is approved at once. */
  submit(id: string, version: number, actor: Actor, tx: Db): Promise<PaymentDto>;
  /** BR-7: records the cash book payment (a post-dated cheque waits for its date) and updates the bills. */
  pay(id: string, version: number, actor: Actor, tx: Db): Promise<PaymentDto>;
  cancel(
    id: string,
    input: { reason: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PaymentDto>;
  setCertificate(
    id: string,
    input: { certificateNo: string; version: number },
    actor: Actor,
    tx: Db,
  ): Promise<PaymentDto>;
  /** BR-11: payments grouped by vendor for one approval. */
  createRun(input: PaymentRunInput, actor: Actor, tx: Db): Promise<PaymentRunDto>;
  get(db: Db, id: string): Promise<PaymentDto>;
  list(
    db: Db,
    query: {
      vendorPartyId?: string | undefined;
      status?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<PageResult<PaymentDto>>;
  /** BR-7: the daily job that puts post-dated cheques into the cash book on their date. */
  postDueCheques(tx: Db): Promise<number>;
  onApprovalOutcome(
    outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
    payload: { docId: string },
    tx: Db,
  ): Promise<void>;
}

export function createPaymentService(ctx: Context): PaymentService {
  const { platform, clock, newId, cashbook, approvals, masterData } = ctx;

  async function dtoOf(db: Db, row: PaymentRow): Promise<PaymentDto> {
    return {
      id: row.id,
      number: row.number,
      vendorPartyId: row.vendor_party_id,
      paymentDate: row.payment_date,
      method: row.method as PaymentMethod,
      amount: row.amount,
      withholdingDeducted: row.withholding_deducted,
      accountId: row.account_id,
      chequeNumber: row.cheque_number,
      chequeDate: row.cheque_date,
      status: row.status as PaymentStatus,
      approvalRequestId: row.approval_request_id,
      approvalDocId: row.approval_doc_id,
      runId: row.run_id,
      reference: row.reference,
      withholdingCertificateNo: row.withholding_certificate_no,
      paidOn: row.paid_on,
      cashbookTxnId: row.cashbook_txn_id,
      reversalTxnId: row.reversal_txn_id,
      cancelledOn: row.cancelled_on,
      cancelReason: row.cancel_reason,
      allocations: (await listAllocations(db, row.id)).map((a) => ({
        id: a.id,
        paymentId: a.payment_id,
        billId: a.bill_id,
        amount: a.amount,
        withholding: a.withholding,
      })),
      version: row.version,
    };
  }

  const changed = (row: PaymentRow, change: string) => ({
    type: 'payables.payment.changed',
    payload: { paymentId: row.id, vendorPartyId: row.vendor_party_id, status: row.status, change },
  });

  async function lockedPayment(tx: Db, id: string, version: number): Promise<PaymentRow> {
    const row = assertFound(await findPayment(tx, id, true), 'payment');
    assertVersion(row.version, version);
    return row;
  }

  const openFigures = (row: OpenBillRow): BillOpenFigures => ({
    billId: row.bill_id,
    gross: row.gross,
    withholdingTotal: row.withholding_total,
    // Reserved allocations of drafts and approved payments are not available to a new one.
    allocated: Money.of(row.allocated).add(Money.of(row.reserved)).toString(),
    withheld: Money.of(row.withheld).add(Money.of(row.reserved_withholding)).toString(),
  });

  /** BR-7: the allocation rules for one vendor's bills; writes the draft payment and its allocations. */
  async function createDraft(
    tx: Db,
    actor: Actor,
    input: PaymentInput,
    extra: { runId: string | null },
  ): Promise<PaymentRow> {
    assertVendor(await masterData.getParty(tx, input.vendorPartyId));
    assertChequeDetails(input.method, input.chequeNumber, input.chequeDate);
    await ctx.checkDate(tx, input.paymentDate, actor, 'pay_payment');
    const statuses = new Map<string, string | undefined>();
    const vendors: string[] = [];
    for (const { billId } of input.allocations) {
      const bill = await findBill(tx, billId, true);
      statuses.set(billId, bill?.status);
      if (bill !== undefined) vendors.push(bill.vendor_party_id);
    }
    assertBillsPayable(statuses);
    assertSingleVendor(vendors, input.vendorPartyId);
    const figures = await listBillFigures(tx, {
      asOf: ctx.today(),
      billIds: input.allocations.map((a) => a.billId),
    });
    const result = allocatePayment(input.allocations, figures.map(openFigures));
    assertAmountMatches(input.amount, result.amount);
    assertPositive(result.amount, 'amount');
    const id = newId();
    const row = await insertPayment(
      tx,
      {
        id,
        number: await platform.numbering.next(paymentSeries, tx),
        vendor_party_id: input.vendorPartyId,
        payment_date: BusinessDate.parse(input.paymentDate).toString(),
        method: input.method,
        amount: result.amount,
        withholding_deducted: result.withholdingDeducted,
        account_id: input.accountId,
        cheque_number: textOrNull(input.chequeNumber),
        cheque_date:
          input.chequeDate === undefined ? null : BusinessDate.parse(input.chequeDate).toString(),
        status: 'draft',
        run_id: extra.runId,
        reference: textOrNull(input.reference),
        withholding_certificate_no: textOrNull(input.withholdingCertificateNo),
      },
      actor.userId,
      clock.now(),
    );
    for (const line of result.lines) {
      await insertAllocation(
        tx,
        {
          id: newId(),
          payment_id: id,
          bill_id: line.billId,
          amount: line.amount,
          withholding: line.withholding,
        },
        actor.userId,
        clock.now(),
      );
    }
    await ctx.record(tx, actor, {
      action: 'payables.payment.create',
      entityType: 'pay_payment',
      entityId: id,
      after: { number: row.number, amount: row.amount, withholding: row.withholding_deducted },
      event: changed(row, 'created'),
    });
    return row;
  }

  /** The bills of a payment move between posted, partly paid and paid with what counts today. */
  async function refreshBills(tx: Db, billIds: readonly string[], actor: Actor): Promise<void> {
    const figures = await listBillFigures(tx, { asOf: ctx.today(), billIds });
    for (const figure of figures) {
      const bill = assertFound(await findBill(tx, figure.bill_id, true), 'bill');
      const to: BillStatus = billStatusAfterPayments(figure.gross, figure.allocated);
      assertBillTransition(bill.status as BillStatus, to);
      assertUpdated(
        await updateBill(tx, bill.id, bill.version, { status: to }, actor.userId, clock.now()),
      );
    }
  }

  const approversOf = async (db: Db, row: PaymentRow): Promise<string[]> => {
    const state = await approvals.getApprovalState(
      db,
      paymentDocType,
      row.approval_doc_id ?? row.id,
    );
    return state.status === 'none'
      ? []
      : state.actions.filter((a) => a.action === 'approve').map((a) => a.actorId);
  };

  const cashCommand = (row: PaymentRow, txnDate: string) => ({
    accountId: row.account_id,
    txnDate,
    amount: row.amount,
    method: row.method as PaymentMethod,
    counterpartyPartyId: row.vendor_party_id,
    sourceModule: 'payables',
    sourceDocType: 'payment',
    sourceDocId: row.id,
    reference: row.cheque_number ?? row.number,
    idempotencyKey: `pay:payment:${row.id}`,
    ...(row.approval_doc_id === null ? {} : { approvalDocId: row.approval_doc_id }),
  });

  const service: PaymentService = {
    async create(input, actor, tx) {
      const row = await createDraft(tx, actor, input, { runId: null });
      return dtoOf(tx, row);
    },

    async submit(id, version, actor, tx) {
      const row = await lockedPayment(tx, id, version);
      assertPaymentDraft(row.status as PaymentStatus);
      const threshold = await ctx.setting(tx, cashbookSettingKeys.paymentApprovalThreshold);
      const needsApproval = Money.of(row.amount).compare(Money.of(threshold)) > 0;
      assertPaymentTransition('draft', needsApproval ? 'pending_approval' : 'approved');
      const request = needsApproval
        ? await approvals.requestApproval(
            {
              docType: paymentDocType,
              docId: id,
              amount: row.amount,
              requesterId: actor.userId,
              context: { vendorPartyId: row.vendor_party_id, number: row.number },
              requestId: actor.requestId,
            },
            tx,
          )
        : undefined;
      const next = assertUpdated(
        await updatePayment(
          tx,
          id,
          version,
          {
            status: needsApproval ? 'pending_approval' : 'approved',
            approval_request_id: request?.id ?? null,
            approval_doc_id: request === undefined ? null : id,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await ctx.record(tx, actor, {
        action: 'payables.payment.submit',
        entityType: 'pay_payment',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status },
        event: changed(next, 'submitted'),
      });
      return dtoOf(tx, next);
    },

    async pay(id, version, actor, tx) {
      const row = await lockedPayment(tx, id, version);
      assertPayable({
        status: row.status as PaymentStatus,
        approvers: await approversOf(tx, row),
        actorUserId: actor.userId,
      });
      const today = ctx.today();
      const postDated = chequeIsPostDated(row.method, row.cheque_date, today);
      const txn = postDated
        ? undefined
        : await cashbook.recordPayment(cashCommand(row, today), actor, tx);
      const next = assertUpdated(
        await updatePayment(
          tx,
          id,
          version,
          {
            status: 'paid',
            paid_on: today,
            paid_by: actor.userId,
            cashbook_txn_id: txn?.id ?? null,
          },
          actor.userId,
          clock.now(),
        ),
      );
      const allocations = await listAllocations(tx, id);
      await refreshBills(
        tx,
        allocations.map((a) => a.bill_id),
        actor,
      );
      await ctx.record(tx, actor, {
        action: 'payables.payment.pay',
        entityType: 'pay_payment',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, cashbookTxnId: next.cashbook_txn_id },
        event: {
          type: 'payment.recorded',
          payload: {
            paymentId: id,
            number: next.number,
            vendorPartyId: next.vendor_party_id,
            amount: next.amount,
            withholdingDeducted: next.withholding_deducted,
            method: next.method,
            paidOn: today,
            billIds: allocations.map((a) => a.bill_id),
          },
        },
      });
      return dtoOf(tx, next);
    },

    async cancel(id, input, actor, tx) {
      const row = await lockedPayment(tx, id, input.version);
      const reconciled =
        row.cashbook_txn_id !== null &&
        (await cashbook.transactions.get(tx, row.cashbook_txn_id)).reconciledIn !== null;
      assertPaymentCancellable({
        status: row.status as PaymentStatus,
        reason: input.reason,
        reconciled,
      });
      const reason = input.reason.trim();
      const today = ctx.today();
      let reversal: string | null = null;
      if (row.cashbook_txn_id !== null) {
        const [reversed] = await cashbook.transactions.reverse(
          row.cashbook_txn_id,
          { reason, txnDate: today },
          actor,
          tx,
        );
        reversal = (reversed as { id: string }).id;
      }
      if (row.status === 'pending_approval' && row.approval_doc_id === row.id) {
        await approvals.cancelApproval(
          { docType: paymentDocType, docId: id, reason, actorUserId: actor.userId },
          tx,
        );
      }
      const next = assertUpdated(
        await updatePayment(
          tx,
          id,
          input.version,
          {
            status: 'cancelled',
            cancelled_on: today,
            cancel_reason: reason,
            reversal_txn_id: reversal,
          },
          actor.userId,
          clock.now(),
        ),
      );
      if (row.status === 'paid') {
        await refreshBills(
          tx,
          (await listAllocations(tx, id)).map((a) => a.bill_id),
          actor,
        );
      }
      await ctx.record(tx, actor, {
        action: 'payables.payment.cancel',
        entityType: 'pay_payment',
        entityId: id,
        before: { status: row.status },
        after: { status: next.status, reason, reversalTxnId: reversal },
        event: changed(next, 'cancelled'),
      });
      return dtoOf(tx, next);
    },

    async setCertificate(id, input, actor, tx) {
      const row = await lockedPayment(tx, id, input.version);
      const number = requiredText(input.certificateNo, 'certificate_no');
      const next = assertUpdated(
        await updatePayment(
          tx,
          id,
          input.version,
          { withholding_certificate_no: number },
          actor.userId,
          clock.now(),
        ),
      );
      await ctx.record(tx, actor, {
        action: 'payables.payment.certificate',
        entityType: 'pay_payment',
        entityId: id,
        before: { certificate: row.withholding_certificate_no },
        after: { certificate: number },
        event: changed(next, 'certificate'),
      });
      return dtoOf(tx, next);
    },

    async createRun(input, actor, tx) {
      assertRunBills(input.billIds.length);
      const figures = await listBillFigures(tx, { asOf: ctx.today(), billIds: input.billIds });
      const statuses = new Map<string, string | undefined>();
      for (const billId of input.billIds) {
        statuses.set(billId, (await findBill(tx, billId))?.status);
      }
      assertBillsPayable(statuses);
      const groups = groupByVendor(
        figures.map((f) => ({ ...f, vendorPartyId: f.vendor_party_id })),
      );
      const runId = newId();
      await insertRun(
        tx,
        {
          id: runId,
          run_date: BusinessDate.parse(input.paymentDate).toString(),
          total: '0.00',
          note: textOrNull(input.note),
        },
        actor.userId,
        clock.now(),
      );
      const payments: PaymentRow[] = [];
      for (const [index, group] of groups.entries()) {
        payments.push(
          await createDraft(
            tx,
            actor,
            {
              vendorPartyId: group.vendorPartyId,
              paymentDate: input.paymentDate,
              method: input.method,
              accountId: input.accountId,
              chequeNumber: input.chequeNumbers?.[index],
              chequeDate: input.chequeDate,
              allocations: group.bills.map((b) => ({
                billId: b.bill_id,
                amount: Money.of(b.gross)
                  .sub(Money.of(b.allocated))
                  .sub(Money.of(b.reserved))
                  .toString(),
              })),
            },
            { runId },
          ),
        );
      }
      const total = payments.reduce((s, p) => s.add(Money.of(p.amount)), Money.zero()).toString();
      await tx.query('update pay_payment_runs set total = $2 where id = $1', [runId, total]);
      const request = await approvals.requestApproval(
        {
          docType: paymentDocType,
          docId: runId,
          amount: total,
          requesterId: actor.userId,
          context: { runId, payments: payments.length },
          requestId: actor.requestId,
        },
        tx,
      );
      const moved: PaymentRow[] = [];
      for (const payment of payments) {
        assertPaymentTransition('draft', 'pending_approval');
        moved.push(
          assertUpdated(
            await updatePayment(
              tx,
              payment.id,
              payment.version,
              {
                status: 'pending_approval',
                approval_request_id: request.id,
                approval_doc_id: runId,
              },
              actor.userId,
              clock.now(),
            ),
          ),
        );
      }
      await ctx.record(tx, actor, {
        action: 'payables.payment.run',
        entityType: 'pay_payment_run',
        entityId: runId,
        after: { total, payments: moved.length },
        event: { type: 'payables.payment.changed', payload: { runId, change: 'run' } },
      });
      return {
        id: runId,
        runDate: BusinessDate.parse(input.paymentDate).toString(),
        total,
        payments: await Promise.all(moved.map((row) => dtoOf(tx, row))),
      };
    },

    async get(db, id) {
      return dtoOf(db, assertFound(await findPayment(db, id), 'payment'));
    },

    async list(db, query) {
      const { rows, total } = await searchPayments(db, query);
      return {
        items: await Promise.all(rows.map((row) => dtoOf(db, row))),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async postDueCheques(tx) {
      const today = ctx.today();
      const due = await findDueCheques(tx, today);
      for (const row of due) {
        const txn = await cashbook.recordPayment(
          cashCommand(row, today),
          {
            userId: row.paid_by as string,
            roles: [],
            scopes: [],
            permissions: new Set<string>(),
            requestId: null,
          },
          tx,
        );
        assertUpdated(
          await updatePayment(
            tx,
            row.id,
            row.version,
            { cashbook_txn_id: txn.id },
            row.paid_by,
            clock.now(),
          ),
        );
        await ctx.record(
          tx,
          { userId: row.paid_by, requestId: null },
          {
            action: 'payables.payment.cheque-posted',
            entityType: 'pay_payment',
            entityId: row.id,
            after: { cashbookTxnId: txn.id, chequeDate: row.cheque_date },
            event: changed(row, 'cheque-posted'),
          },
        );
      }
      return due.length;
    },

    async onApprovalOutcome(outcome, payload, tx) {
      const own = await findPayment(tx, payload.docId, true);
      const rows = own === undefined ? await listPaymentsByRun(tx, payload.docId) : [own];
      for (const row of rows.filter((r) => r.status === 'pending_approval')) {
        const to: PaymentStatus = outcome === 'approved' ? 'approved' : 'draft';
        assertPaymentTransition('pending_approval', to);
        const next = assertUpdated(
          await updatePayment(tx, row.id, row.version, { status: to }, null, clock.now()),
        );
        await ctx.record(
          tx,
          { userId: null, requestId: null },
          {
            action: `payables.payment.${outcome}`,
            entityType: 'pay_payment',
            entityId: row.id,
            before: { status: row.status },
            after: { status: next.status },
            event: changed(next, outcome),
          },
        );
      }
    },
  };
  return service;
}

import {
  assertTransition,
  computeCredit,
  type CreditFigures,
  type CreditedInvoice,
  type InvoiceStatus,
} from '@emporium/domain/billing';
import { BusinessDate, Money, type Clock } from '@emporium/domain/kernel';
import { creditNoteDocType, creditNoteSeries, type CreditNoteStatus } from '@emporium/shared';
import type { Approvals } from '../../approvals/index.js';
import type { Platform } from '../../platform/index.js';
import {
  assertAdvanceUnused,
  assertApproved,
  assertDraftCredit,
  assertFiguresUnchanged,
  assertFound,
  assertIssuedInvoice,
  assertProjectReachable,
  assertSubmittable,
  assertUpdated,
} from '../policy/billing.policy.js';
import {
  findAdvanceByInvoice,
  findCreditNote,
  findInvoice,
  insertCreditNote,
  listCreditNotes,
  listLines,
  lockedAdvances,
  priorCredits,
  setStagesStatus,
  updateAdvance,
  updateCreditNote,
  updateInvoice,
  type CreditNoteRow,
  type InvoiceRow,
} from '../repo/billing.repo.js';
import type { Actor, CreditNoteDto, Db } from '../types.js';
import { createRecorder, requiredText } from './support.js';

export interface CreditNoteService {
  /** BR-9: a draft credit note against an issued invoice; no amount credits what is still creditable. */
  create(
    invoiceId: string,
    input: { reason: string; baseAmount?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<CreditNoteDto>;
  /** BR-9: asks the owner to approve the credit note. */
  submit(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CreditNoteDto>;
  /** BR-9: numbers the approved credit note and reverses what it credits. */
  issue(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<CreditNoteDto>;
  /** BR-5: the only way to cancel an issued invoice: a credit note for all of it, sent for approval. */
  cancelByCreditNote(
    invoiceId: string,
    reason: string,
    actor: Actor,
    tx: Db,
  ): Promise<CreditNoteDto>;
  get(db: Db, id: string, actor: Actor): Promise<CreditNoteDto>;
  listForInvoice(db: Db, invoiceId: string, actor: Actor): Promise<CreditNoteDto[]>;
}

interface SnapshotGroup {
  base: string;
  ratePercent: string;
}

const creditedInvoice = (invoice: InvoiceRow): CreditedInvoice => ({
  baseAmount: invoice.base_amount,
  advanceRecovery: invoice.advance_recovery,
  taxTotal: invoice.tax_total,
  taxOnAdvanceAtReceipt: invoice.tax_on_advance_at_receipt,
  // BR-9: tax is reversed with the rates stored on the invoice, never with today's rules.
  taxGroups: (invoice.tax_snapshot as { taxLines: SnapshotGroup[] }).taxLines.map((group) => ({
    base: group.base,
    ratePercent: group.ratePercent,
  })),
});

const figuresOf = (figures: CreditFigures) => ({
  baseAmount: figures.baseAmount,
  advanceRestored: figures.advanceRestored,
  taxTotal: figures.taxTotal,
  grossTotal: figures.grossTotal,
});

export function createCreditNoteService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): CreditNoteService {
  const { platform, clock, newId, approvals } = deps;
  const record = createRecorder(platform);

  async function dtoOf(db: Db, row: CreditNoteRow): Promise<CreditNoteDto> {
    const state = await approvals.getApprovalState(db, creditNoteDocType, row.id);
    return {
      id: row.id,
      number: row.number,
      invoiceId: row.invoice_id,
      reason: row.reason,
      baseAmount: row.base_amount,
      advanceRestored: row.advance_restored,
      taxTotal: row.tax_total,
      grossTotal: row.gross_total,
      issuedOn: row.issued_on,
      status: row.status as CreditNoteStatus,
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
      version: row.version,
    };
  }

  /** The credit note and its invoice, locked, with the caller's reach to the project checked. */
  async function lockCredit(tx: Db, id: string, actor: Actor, expectedVersion: number) {
    const credit = assertFound(await findCreditNote(tx, id, true), 'credit_note');
    const invoice = assertFound(await findInvoice(tx, credit.invoice_id, true), 'invoice');
    assertProjectReachable(actor, invoice.project_id);
    if (credit.version !== expectedVersion) assertUpdated(undefined);
    return { credit, invoice };
  }

  async function create(
    invoiceId: string,
    input: { reason: string; baseAmount?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<CreditNoteRow> {
    const invoice = assertFound(await findInvoice(tx, invoiceId, true), 'invoice');
    assertProjectReachable(actor, invoice.project_id);
    assertIssuedInvoice(invoice.status);
    const reason = requiredText(input.reason, 'reason');
    const advance = await findAdvanceByInvoice(tx, invoiceId);
    if (advance !== undefined) assertAdvanceUnused(advance.applied);
    const prior = await priorCredits(tx, invoiceId, { issuedOnly: false, exceptId: null });
    const base =
      input.baseAmount ?? Money.of(invoice.base_amount).sub(Money.of(prior.base)).toString();
    const figures = computeCredit(
      creditedInvoice(invoice),
      { base: prior.base, advanceRestored: prior.restored, tax: prior.tax },
      base,
    );
    const row = await insertCreditNote(
      tx,
      {
        id: newId(),
        invoice_id: invoiceId,
        reason,
        base_amount: figures.baseAmount,
        advance_restored: figures.advanceRestored,
        tax_total: figures.taxTotal,
        gross_total: figures.grossTotal,
        tax_snapshot: JSON.stringify({
          invoiceNumber: invoice.number,
          authorityCode: invoice.authority_code,
          registrationNumber: invoice.registration_number,
          taxableBase: figures.taxableBase,
          taxLines: creditedInvoice(invoice).taxGroups,
        }),
      },
      actor.userId,
      clock.now(),
    );
    await record(tx, actor, {
      action: 'billing.creditnote.create',
      entityType: 'bil_credit_note',
      entityId: row.id,
      after: { invoiceId, baseAmount: row.base_amount, grossTotal: row.gross_total },
      event: {
        type: 'billing.creditnote.changed',
        payload: { creditNoteId: row.id, invoiceId, status: row.status, change: 'created' },
      },
    });
    return row;
  }

  async function submit(tx: Db, row: CreditNoteRow, invoice: InvoiceRow, actor: Actor) {
    assertDraftCredit(row.status);
    assertSubmittable((await approvals.getApprovalState(tx, creditNoteDocType, row.id)).status);
    await approvals.requestApproval(
      {
        docType: creditNoteDocType,
        docId: row.id,
        amount: row.gross_total,
        requesterId: actor.userId,
        context: {
          invoiceNumber: invoice.number,
          projectId: invoice.project_id,
          baseAmount: row.base_amount,
          grossTotal: row.gross_total,
          reason: row.reason,
        },
        requestId: actor.requestId,
      },
      tx,
    );
    await record(tx, actor, {
      action: 'billing.creditnote.submit',
      entityType: 'bil_credit_note',
      entityId: row.id,
      after: { grossTotal: row.gross_total },
      event: {
        type: 'billing.creditnote.changed',
        payload: {
          creditNoteId: row.id,
          invoiceId: row.invoice_id,
          status: row.status,
          change: 'submitted',
        },
      },
    });
  }

  /** BR-3 reversed: the recovery of the credited part goes back to the newest applied advances. */
  async function restoreAdvance(
    tx: Db,
    projectId: string,
    restored: string,
    actor: Actor,
    at: Date,
  ): Promise<void> {
    let left = Money.of(restored);
    for (const advance of await lockedAdvances(tx, projectId, 'desc')) {
      if (left.isZero()) break;
      const applied = Money.of(advance.applied);
      if (!applied.value.gt(0)) continue;
      const give = left.compare(applied) < 0 ? left : applied;
      await updateAdvance(
        tx,
        advance.id,
        advance.version,
        { applied: applied.sub(give).toString(), status: 'received' },
        actor.userId,
        at,
      );
      left = left.sub(give);
    }
  }

  return {
    async create(invoiceId, input, actor, tx) {
      return dtoOf(tx, await create(invoiceId, input, actor, tx));
    },

    async submit(id, expectedVersion, actor, tx) {
      const { credit, invoice } = await lockCredit(tx, id, actor, expectedVersion);
      await submit(tx, credit, invoice, actor);
      return dtoOf(tx, credit);
    },

    async cancelByCreditNote(invoiceId, reason, actor, tx) {
      const row = await create(invoiceId, { reason }, actor, tx);
      const invoice = assertFound(await findInvoice(tx, invoiceId), 'invoice');
      await submit(tx, row, invoice, actor);
      return dtoOf(tx, row);
    },

    async issue(id, expectedVersion, actor, tx) {
      const { credit, invoice } = await lockCredit(tx, id, actor, expectedVersion);
      assertDraftCredit(credit.status);
      assertApproved((await approvals.getApprovalState(tx, creditNoteDocType, id)).status);
      // Only issued credit notes count now; the figures must still be what the owner approved.
      const prior = await priorCredits(tx, invoice.id, { issuedOnly: true, exceptId: id });
      const figures = computeCredit(
        creditedInvoice(invoice),
        { base: prior.base, advanceRestored: prior.restored, tax: prior.tax },
        credit.base_amount,
      );
      assertFiguresUnchanged(
        {
          baseAmount: credit.base_amount,
          advanceRestored: credit.advance_restored,
          taxTotal: credit.tax_total,
          grossTotal: credit.gross_total,
        },
        figuresOf(figures),
      );
      const at = clock.now();
      if (!(await platform.numbering.list(tx)).some((s) => s.code === creditNoteSeries)) {
        await platform.numbering.save(
          {
            code: creditNoteSeries,
            prefix: 'CN',
            padding: 4,
            resetYearly: true,
            gapless: true,
            startValue: 1,
          },
          { actorUserId: actor.userId, requestId: actor.requestId },
          tx,
        );
      }
      const number = await platform.numbering.next(creditNoteSeries, tx);
      const row = assertUpdated(
        await updateCreditNote(
          tx,
          id,
          expectedVersion,
          {
            status: 'issued',
            number,
            issued_on: BusinessDate.today(clock).toString(),
          },
          actor.userId,
          at,
        ),
      );
      if (!Money.of(row.advance_restored).isZero()) {
        await restoreAdvance(tx, invoice.project_id, row.advance_restored, actor, at);
      }
      const advance = await findAdvanceByInvoice(tx, invoice.id);
      if (figures.complete) {
        const stageIds = (await listLines(tx, invoice.id)).flatMap((line) =>
          line.schedule_id === null ? [] : [line.schedule_id],
        );
        await setStagesStatus(tx, stageIds, 'planned', actor.userId, at);
        assertTransition(invoice.status as InvoiceStatus, 'cancelled');
        await updateInvoice(
          tx,
          invoice.id,
          invoice.version,
          { status: 'cancelled' },
          actor.userId,
          at,
        );
        if (advance !== undefined) {
          await updateAdvance(
            tx,
            advance.id,
            advance.version,
            { status: 'refunded' },
            actor.userId,
            at,
          );
        }
      }
      await record(tx, actor, {
        action: 'billing.creditnote.issue',
        entityType: 'bil_credit_note',
        entityId: id,
        before: { status: credit.status },
        after: { status: row.status, number, grossTotal: row.gross_total },
        event: {
          type: 'creditnote.issued',
          payload: {
            creditNoteId: id,
            number,
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            projectId: invoice.project_id,
            partyId: invoice.party_id,
            baseAmount: row.base_amount,
            taxTotal: row.tax_total,
            grossTotal: row.gross_total,
            invoiceCancelled: figures.complete,
          },
        },
      });
      if (figures.complete) {
        await record(tx, actor, {
          action: 'billing.invoice.cancel-by-credit-note',
          entityType: 'bil_invoice',
          entityId: invoice.id,
          before: { status: invoice.status },
          after: { status: 'cancelled', creditNoteId: id },
          event: {
            type: 'invoice.cancelled',
            payload: {
              invoiceId: invoice.id,
              projectId: invoice.project_id,
              by: 'credit_note',
              creditNoteId: id,
            },
          },
        });
      }
      return dtoOf(tx, row);
    },

    async get(db, id, actor) {
      const row = assertFound(await findCreditNote(db, id), 'credit_note');
      const invoice = assertFound(await findInvoice(db, row.invoice_id), 'invoice');
      assertProjectReachable(actor, invoice.project_id);
      return dtoOf(db, row);
    },

    async listForInvoice(db, invoiceId, actor) {
      const invoice = assertFound(await findInvoice(db, invoiceId), 'invoice');
      assertProjectReachable(actor, invoice.project_id);
      return Promise.all((await listCreditNotes(db, invoiceId)).map((row) => dtoOf(db, row)));
    },
  };
}

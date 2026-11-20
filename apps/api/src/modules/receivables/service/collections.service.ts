import { assertWriteOffAllowed } from '@emporium/domain/receivables';
import { BusinessDate, Money } from '@emporium/domain/kernel';
import { receivablesSettingKeys, writeOffDocType, type FollowupStatus } from '@emporium/shared';
import {
  assertFollowupOpen,
  assertFound,
  assertUpdated,
  assertWriteOffApproved,
} from '../policy/receivables.policy.js';
import {
  findAdjustmentByApproval,
  findFollowup,
  insertAdjustment,
  insertFollowup,
  listAdjustments,
  listFollowups,
  listInvoiceFigures,
  softDeleteFollowup,
  updateFollowup,
  type AdjustmentRow,
  type FollowupRow,
} from '../repo/receivables.repo.js';
import type { Actor, AdjustmentDto, Db, FollowupDto } from '../types.js';
import { requiredText, type Context } from './context.js';
import { openInvoiceDto } from './ledger.service.js';

export interface FollowupInput {
  partyId: string;
  invoiceId?: string | undefined;
  dueDate: string;
  note: string;
  assignedTo?: string | undefined;
}

export interface CollectionsService {
  createFollowup(input: FollowupInput, actor: Actor, tx: Db): Promise<FollowupDto>;
  updateFollowup(
    id: string,
    input: {
      dueDate?: string | undefined;
      note?: string | undefined;
      assignedTo?: string | undefined;
      status?: FollowupStatus | undefined;
      version: number;
    },
    actor: Actor,
    tx: Db,
  ): Promise<FollowupDto>;
  deleteFollowup(id: string, version: number, actor: Actor, tx: Db): Promise<void>;
  listFollowups(
    db: Db,
    query: { partyId?: string | undefined; status?: FollowupStatus | undefined },
  ): Promise<FollowupDto[]>;
  /** BR-11, H-09: asks the owner to approve a small-balance write-off; returns the id to pass later. */
  requestWriteOffApproval(
    input: { invoiceId: string; amount: string; note?: string | undefined },
    actor: Actor,
    tx: Db,
  ): Promise<{ approvalDocId: string }>;
  /** BR-11: the approved write-off closes a small remaining balance of one invoice. */
  createAdjustment(
    input: {
      invoiceId: string;
      amount: string;
      reason: string;
      approvalDocId?: string | undefined;
      adjustmentDate?: string | undefined;
    },
    actor: Actor,
    tx: Db,
  ): Promise<AdjustmentDto>;
  listAdjustments(db: Db, partyId: string): Promise<AdjustmentDto[]>;
}

const followupDto = (row: FollowupRow): FollowupDto => ({
  id: row.id,
  partyId: row.party_id,
  invoiceId: row.invoice_id,
  pdcId: row.pdc_id,
  dueDate: row.due_date,
  note: row.note,
  status: row.status as FollowupStatus,
  assignedTo: row.assigned_to,
  version: row.version,
});

const adjustmentDto = (row: AdjustmentRow): AdjustmentDto => ({
  id: row.id,
  partyId: row.party_id,
  invoiceId: row.invoice_id,
  adjustmentDate: row.adjustment_date,
  amount: row.amount,
  reason: row.reason,
  approvalDocId: row.approval_doc_id,
  approvedBy: row.approved_by,
});

export function createCollectionsService(ctx: Context): CollectionsService {
  const { platform, clock, newId, approvals, masterData } = ctx;

  const followupChanged = (row: FollowupRow, change: string) => ({
    type: 'followup.changed',
    payload: { followupId: row.id, partyId: row.party_id, change },
  });

  return {
    async createFollowup(input, actor, tx) {
      assertFound(await masterData.getParty(tx, input.partyId), 'party');
      const row = await insertFollowup(
        tx,
        {
          id: newId(),
          party_id: input.partyId,
          invoice_id: input.invoiceId ?? null,
          due_date: BusinessDate.parse(input.dueDate).toString(),
          note: requiredText(input.note, 'note'),
          assigned_to: input.assignedTo ?? null,
        },
        actor.userId,
        clock.now(),
      );
      await ctx.record(tx, actor, {
        action: 'receivables.followup.create',
        entityType: 'rcv_followup',
        entityId: row.id,
        after: followupDto(row),
        event: followupChanged(row, 'created'),
      });
      return followupDto(row);
    },

    async updateFollowup(id, input, actor, tx) {
      const before = assertFound(await findFollowup(tx, id, true), 'followup');
      assertFollowupOpen(before.status);
      const values: Record<string, unknown> = {};
      if (input.dueDate !== undefined)
        values.due_date = BusinessDate.parse(input.dueDate).toString();
      if (input.note !== undefined) values.note = requiredText(input.note, 'note');
      if (input.assignedTo !== undefined) values.assigned_to = input.assignedTo;
      if (input.status !== undefined) values.status = input.status;
      const row = assertUpdated(
        await updateFollowup(tx, id, input.version, values, actor.userId, clock.now()),
      );
      await ctx.record(tx, actor, {
        action: 'receivables.followup.update',
        entityType: 'rcv_followup',
        entityId: id,
        before: followupDto(before),
        after: followupDto(row),
        event: followupChanged(row, row.status === 'done' ? 'done' : 'updated'),
      });
      return followupDto(row);
    },

    async deleteFollowup(id, version, actor, tx) {
      const before = assertFound(await findFollowup(tx, id, true), 'followup');
      const row = assertUpdated(
        await softDeleteFollowup(tx, id, version, actor.userId, clock.now()),
      );
      await ctx.record(tx, actor, {
        action: 'receivables.followup.delete',
        entityType: 'rcv_followup',
        entityId: id,
        before: followupDto(before),
        event: followupChanged(row, 'deleted'),
      });
    },

    async listFollowups(db, query) {
      return (await listFollowups(db, query)).map(followupDto);
    },

    async requestWriteOffApproval(input, actor, tx) {
      const approvalDocId = newId();
      await approvals.requestApproval(
        {
          docType: writeOffDocType,
          docId: approvalDocId,
          amount: Money.of(input.amount).toString(),
          requesterId: actor.userId,
          context: { invoiceId: input.invoiceId, note: input.note ?? null },
          requestId: actor.requestId,
        },
        tx,
      );
      return { approvalDocId };
    },

    async createAdjustment(input, actor, tx) {
      const reason = requiredText(input.reason, 'reason');
      const date = BusinessDate.parse(input.adjustmentDate ?? ctx.today()).toString();
      await ctx.checkDate(tx, date, actor, 'rcv_adjustment');
      const figures = await listInvoiceFigures(tx, { asOf: date, invoiceIds: [input.invoiceId] });
      const invoice = openInvoiceDto(assertFound(figures[0], 'invoice'));
      const limit = String(
        (await platform.settings.get(tx, receivablesSettingKeys.smallBalanceLimit)).value,
      );
      assertWriteOffAllowed(invoice.outstanding, input.amount, limit);
      const state =
        input.approvalDocId === undefined
          ? undefined
          : await approvals.getApprovalState(tx, writeOffDocType, input.approvalDocId);
      const known = state === undefined || state.status === 'none' ? undefined : state;
      const approvers = (known?.actions ?? [])
        .filter((a) => a.action === 'approve')
        .map((a) => a.actorId);
      assertWriteOffApproved({
        approvalDocId: input.approvalDocId,
        facts:
          known === undefined
            ? undefined
            : { status: known.status, amount: known.amount, approvers },
        amount: input.amount,
        actorUserId: actor.userId,
        alreadyUsed:
          input.approvalDocId !== undefined &&
          (await findAdjustmentByApproval(tx, input.approvalDocId)) !== undefined,
      });
      const row = await insertAdjustment(
        tx,
        {
          id: newId(),
          party_id: invoice.partyId,
          invoice_id: input.invoiceId,
          adjustment_date: date,
          amount: Money.of(input.amount).toString(),
          reason,
          approval_doc_id: input.approvalDocId,
          // An approved request always has an approver.
          approved_by: approvers[0],
        },
        actor.userId,
        clock.now(),
      );
      await ctx.record(tx, actor, {
        action: 'receivables.adjustment.create',
        entityType: 'rcv_adjustment',
        entityId: row.id,
        after: adjustmentDto(row),
        event: {
          type: 'adjustment.recorded',
          payload: {
            adjustmentId: row.id,
            partyId: row.party_id,
            invoiceId: row.invoice_id,
            amount: row.amount,
          },
        },
      });
      return adjustmentDto(row);
    },

    async listAdjustments(db, partyId) {
      return (await listAdjustments(db, partyId)).map(adjustmentDto);
    },
  };
}

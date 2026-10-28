import {
  assertClaimEditable,
  assertClaimTransition,
  assertDuplicatesAcknowledged,
  assertReceipts,
  claimTotal,
  costKey,
  findDuplicates,
  normalizeClaimLines,
  type CategoryRule,
  type ClaimLine,
  type ClaimLineInput,
} from '@emporium/domain/expenses';
import { BusinessDate } from '@emporium/domain/kernel';
import { expenseClaimDocType, expenseClaimEntityType, expensesPermissions } from '@emporium/shared';
import {
  assertApplied,
  assertCancelable,
  assertCanCancel,
  assertCanReadClaim,
  assertCategoryKnown,
  assertDraftOnly,
  assertFound,
  assertOwnClaim,
  assertProjectActive,
  assertProjectReachable,
  assertReceiptKnown,
  assertReversible,
  assertUpdated,
} from '../policy/expenses.policy.js';
import {
  findClaim,
  insertClaim,
  listCategories,
  listLines,
  listPriorLines,
  replaceLines,
  searchClaims,
  setLineEntry,
  softDeleteClaim,
  updateClaim,
  type ClaimRow,
  type LineRow,
} from '../repo/expenses.repo.js';
import type {
  Actor,
  ClaimDto,
  ClaimHeaderDto,
  ClaimLineDto,
  ClaimStatus,
  Db,
  PageResult,
} from '../types.js';
import type { Context } from './context.js';
import { pageOf, requiredText, textOrNull } from './support.js';

export interface ClaimInput {
  note?: string | undefined;
  lines: ClaimLineInput[];
}

export interface ClaimQuery {
  status?: ClaimStatus | undefined;
  /** Only the caller's own claims (finance and management see all otherwise). */
  mine: boolean;
  limit: number;
  offset: number;
}

export const claimHeaderOf = (row: ClaimRow): ClaimHeaderDto => ({
  id: row.id,
  number: row.number,
  claimantId: row.claimant_id,
  submittedOn: row.submitted_on,
  status: row.status as ClaimStatus,
  total: row.total,
  note: row.note,
  cancelReason: row.cancel_reason,
  version: row.version,
});

const lineOf = (row: LineRow): ClaimLineDto => ({
  id: row.id,
  lineNo: row.line_no,
  expenseDate: row.expense_date,
  category: row.category,
  description: row.description,
  costObjectType: row.cost_object_type as ClaimLineDto['costObjectType'],
  costObjectId: row.cost_object_id,
  costCodeId: row.cost_code_id,
  amount: row.amount,
  receiptFileId: row.receipt_file_id,
});

const toClaimLine = (row: LineRow): ClaimLine => ({ ...lineOf(row) });

export type ClaimService = ReturnType<typeof createClaimService>;

export function createClaimService(ctx: Context) {
  const { clock, approvals, projects, files, newId, record } = ctx;

  const changed = (row: ClaimRow, change: string) => ({
    type: 'expenses.claim.changed',
    payload: {
      claimId: row.id,
      number: row.number,
      claimantId: row.claimant_id,
      status: row.status,
      change,
    },
  });

  /** BR-9: the lines that look like repeats of the claimant's earlier claims. */
  async function duplicatesOf(db: Db, row: ClaimRow, lines: readonly ClaimLine[]) {
    const dates = lines.map((line) => line.expenseDate).sort();
    const from = BusinessDate.parse(dates[0] as string)
      .addDays(-7)
      .toString();
    const to = BusinessDate.parse(dates[dates.length - 1] as string)
      .addDays(7)
      .toString();
    const prior = await listPriorLines(db, row.claimant_id, row.id, from, to);
    return findDuplicates(
      lines,
      prior.map((p) => ({
        claimNumber: p.claim_number,
        lineNo: p.line_no,
        expenseDate: p.expense_date,
        category: p.category,
        amount: p.amount,
      })),
    );
  }

  async function dtoOf(db: Db, row: ClaimRow): Promise<ClaimDto> {
    const lines = await listLines(db, row.id);
    const editable = row.status === 'draft' || row.status === 'returned';
    const state = await approvals.getApprovalState(db, expenseClaimDocType, row.id);
    return {
      ...claimHeaderOf(row),
      lines: lines.map(lineOf),
      duplicates: editable ? await duplicatesOf(db, row, lines.map(toClaimLine)) : [],
      approval:
        state.status === 'none'
          ? { status: 'none', requestId: null, currentRole: null }
          : { status: state.status, requestId: state.id, currentRole: state.currentRole },
    };
  }

  async function categoryRules(db: Db): Promise<Map<string, CategoryRule>> {
    return new Map(
      (await listCategories(db)).map((row) => [
        row.code,
        {
          code: row.code,
          receiptRequired: row.receipt_required,
          maxWithoutReceipt: row.max_without_receipt,
        },
      ]),
    );
  }

  /**
   * BR-2 and BR-3: checks the lines against master data, projects, dates and the claim's own
   * attachments. A claim that does not exist yet has no attachments.
   */
  async function prepare(tx: Db, input: ClaimInput, actor: Actor, claimId: string | null) {
    const lines = normalizeClaimLines(input.lines);
    const categories = await categoryRules(tx);
    const attached = new Set(
      claimId === null
        ? []
        : (await files.list(tx, actor, expenseClaimEntityType, claimId)).map((f) => f.id),
    );
    for (const category of new Set(lines.map((line) => line.category))) {
      assertCategoryKnown(categories.has(category));
    }
    for (const costCodeId of new Set(lines.map((line) => line.costCodeId))) {
      await ctx.checkCostCode(tx, costCodeId);
    }
    for (const line of lines) {
      if (line.costObjectId !== null) {
        assertProjectReachable(actor, line.costObjectId);
        assertProjectActive((await projects.getProject(tx, line.costObjectId)).status);
      }
      if (line.receiptFileId !== null) assertReceiptKnown(attached.has(line.receiptFileId));
    }
    for (const date of new Set(lines.map((line) => line.expenseDate))) {
      await ctx.checkDate(tx, date, actor, 'exp_claim');
    }
    return { lines, categories };
  }

  const lineValues = (lines: readonly ClaimLine[]) =>
    lines.map((line) => ({ ...line, id: newId() }));

  async function locked(tx: Db, id: string, actor: Actor, expectedVersion?: number) {
    const row = assertFound(await findClaim(tx, id, true), 'claim');
    assertCanReadClaim(actor, row.claimant_id);
    if (expectedVersion !== undefined && expectedVersion !== row.version) assertUpdated(undefined);
    return row;
  }

  /** One status change with its audit row and event. */
  async function moveTo(
    tx: Db,
    existing: ClaimRow,
    to: ClaimStatus,
    values: Record<string, unknown>,
    action: string,
    actor: { userId: string | null; requestId: string | null },
    event?: { type: string; payload: Record<string, unknown> },
  ): Promise<ClaimRow> {
    assertClaimTransition(existing.status as ClaimStatus, to);
    const row = assertUpdated(
      await updateClaim(
        tx,
        existing.id,
        existing.version,
        { status: to, ...values },
        actor.userId,
        clock.now(),
      ),
    );
    await record(tx, actor, {
      action: `expenses.claim.${action}`,
      entityType: 'exp_claim',
      entityId: row.id,
      before: { status: existing.status },
      after: { status: row.status, total: row.total },
      event: event ?? changed(row, action),
    });
    return row;
  }

  /** BR-7: each line's live cost entry is reversed; the chain keeps its history. */
  async function reverseEntries(tx: Db, claim: ClaimRow, reason: string, actor: Actor) {
    for (const line of await listLines(tx, claim.id)) {
      const entry = await projects.reverseCost(
        line.cost_entry_id as string,
        `Claim ${claim.number}: ${reason}`,
        tx,
        actor.userId,
      );
      await setLineEntry(tx, line.id, entry.id);
    }
  }

  return {
    async list(db: Db, query: ClaimQuery, actor: Actor): Promise<PageResult<ClaimHeaderDto>> {
      const all = actor.permissions.has(expensesPermissions.claimReadAll) && !query.mine;
      const { rows, total } = await searchClaims(db, {
        claimantId: all ? undefined : actor.userId,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
      return pageOf(rows.map(claimHeaderOf), total, query);
    },

    async get(db: Db, id: string, actor: Actor): Promise<ClaimDto> {
      const row = assertFound(await findClaim(db, id), 'claim');
      assertCanReadClaim(actor, row.claimant_id);
      return dtoOf(db, row);
    },

    /** The claimant of a claim, for the receipt access rule. */
    async claimantOf(db: Db, id: string): Promise<string | undefined> {
      return (await findClaim(db, id))?.claimant_id;
    },

    async create(input: ClaimInput, actor: Actor, tx: Db): Promise<ClaimDto> {
      const { lines } = await prepare(tx, input, actor, null);
      const row = await insertClaim(
        tx,
        {
          id: newId(),
          number: await ctx.platform.numbering.next('expense_claim', tx),
          claimant_id: actor.userId,
          total: claimTotal(lines),
          note: textOrNull(input.note) ?? '',
        },
        actor.userId,
        clock.now(),
      );
      await replaceLines(tx, row.id, lineValues(lines));
      await record(tx, actor, {
        action: 'expenses.claim.create',
        entityType: 'exp_claim',
        entityId: row.id,
        after: { number: row.number, total: row.total, lines: lines.length },
        event: changed(row, 'created'),
      });
      return dtoOf(tx, row);
    },

    async update(id: string, input: ClaimInput, expectedVersion: number, actor: Actor, tx: Db) {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertOwnClaim(actor, existing.claimant_id);
      assertClaimEditable(existing.status as ClaimStatus);
      const { lines } = await prepare(tx, input, actor, id);
      const row = assertUpdated(
        await updateClaim(
          tx,
          id,
          expectedVersion,
          { total: claimTotal(lines), note: textOrNull(input.note) ?? '' },
          actor.userId,
          clock.now(),
        ),
      );
      await replaceLines(tx, id, lineValues(lines));
      await record(tx, actor, {
        action: 'expenses.claim.update',
        entityType: 'exp_claim',
        entityId: id,
        before: { total: existing.total },
        after: { total: row.total, lines: lines.length },
        event: changed(row, 'updated'),
      });
      return dtoOf(tx, row);
    },

    async remove(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<void> {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertOwnClaim(actor, existing.claimant_id);
      assertDraftOnly(existing.status);
      assertApplied(await softDeleteClaim(tx, id, expectedVersion, actor.userId, clock.now()));
      await record(tx, actor, {
        action: 'expenses.claim.delete',
        entityType: 'exp_claim',
        entityId: id,
        before: { number: existing.number, total: existing.total },
        event: changed(existing, 'deleted'),
      });
    },

    /** BR-3, BR-4, BR-9: checks the lines again, then asks the approval engine. */
    async submit(
      id: string,
      input: { acknowledgeDuplicates: boolean },
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<ClaimDto> {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertOwnClaim(actor, existing.claimant_id);
      assertClaimTransition(existing.status as ClaimStatus, 'submitted');
      const stored = (await listLines(tx, id)).map(toClaimLine);
      const { lines, categories } = await prepare(
        tx,
        { lines: stored.map((line) => ({ ...line })) },
        actor,
        id,
      );
      assertReceipts(lines, categories);
      assertDuplicatesAcknowledged(
        await duplicatesOf(tx, existing, lines),
        input.acknowledgeDuplicates,
      );
      await approvals.requestApproval(
        {
          docType: expenseClaimDocType,
          docId: id,
          amount: existing.total,
          requesterId: actor.userId,
          context: {
            number: existing.number,
            claimantId: existing.claimant_id,
            total: existing.total,
          },
          requestId: actor.requestId,
        },
        tx,
      );
      const row = await moveTo(
        tx,
        existing,
        'submitted',
        { submitted_on: ctx.today() },
        'submit',
        actor,
      );
      return dtoOf(tx, row);
    },

    /**
     * BR-5: the approval engine decided. Approval books one `approved` cost entry per line, keyed
     * `exp:<line id>`; a replayed event finds the claim already moved and does nothing.
     */
    async onApprovalOutcome(
      outcome: 'approved' | 'rejected' | 'returned' | 'cancelled',
      payload: { docId: string },
      tx: Db,
    ): Promise<void> {
      const existing = await findClaim(tx, payload.docId, true);
      if (existing?.status !== 'submitted') return;
      const system = { userId: null, requestId: null };
      if (outcome !== 'approved') {
        // A rejected claim ends; a returned one, or one whose request was withdrawn, can be corrected.
        const to = outcome === 'rejected' ? 'rejected' : 'returned';
        await moveTo(tx, existing, to, {}, outcome, system);
        return;
      }
      for (const line of await listLines(tx, existing.id)) {
        const entry = await projects.postCost(
          {
            costObject: {
              type: line.cost_object_type as 'project' | 'overhead',
              id: line.cost_object_id,
            },
            costCodeId: line.cost_code_id,
            amount: line.amount,
            status: 'approved',
            sourceModule: 'expenses',
            sourceDocType: expenseClaimDocType,
            sourceDocId: existing.id,
            sourceLineId: line.id,
            entryDate: line.expense_date,
            description: `${existing.number}: ${line.description}`,
            idempotencyKey: costKey(line.id),
          },
          tx,
        );
        await setLineEntry(tx, line.id, entry.id);
      }
      await moveTo(tx, existing, 'approved', {}, 'approve', system, {
        type: 'expense.approved',
        payload: {
          claimId: existing.id,
          number: existing.number,
          claimantId: existing.claimant_id,
          total: existing.total,
        },
      });
      await ctx.settleIfZero(tx, existing.claimant_id);
    },

    /** BR-6: the accountant confirms the cost; each entry becomes `posted`, once. */
    async post(id: string, expectedVersion: number, actor: Actor, tx: Db): Promise<ClaimDto> {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertClaimTransition(existing.status as ClaimStatus, 'posted');
      for (const line of await listLines(tx, id)) {
        const entry = await projects.transitionCost(
          line.cost_entry_id as string,
          'posted',
          tx,
          actor.userId,
        );
        await setLineEntry(tx, line.id, entry.id);
      }
      const row = await moveTo(tx, existing, 'posted', {}, 'post', actor, {
        type: 'expense.posted',
        payload: {
          claimId: id,
          number: existing.number,
          claimantId: existing.claimant_id,
          total: existing.total,
        },
      });
      return dtoOf(tx, row);
    },

    /**
     * BR-7: cancels a claim that is not posted. A submitted claim also withdraws its approval request;
     * an approved one reverses its cost entries.
     */
    async cancel(
      id: string,
      input: { reason?: string | undefined },
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<ClaimDto> {
      const existing = await locked(tx, id, actor, expectedVersion);
      assertCanCancel(actor, existing.claimant_id);
      assertCancelable(existing.status);
      assertClaimTransition(existing.status as ClaimStatus, 'cancelled');
      const reason = textOrNull(input.reason);
      if (existing.status === 'submitted') {
        await approvals.cancelApproval(
          {
            docType: expenseClaimDocType,
            docId: id,
            reason: 'The expense claim was cancelled',
            actorUserId: actor.userId,
            requestId: actor.requestId,
          },
          tx,
        );
      }
      if (existing.status === 'approved') {
        await reverseEntries(tx, existing, reason ?? 'cancelled', actor);
      }
      const row = await moveTo(
        tx,
        existing,
        'cancelled',
        { cancel_reason: reason },
        'cancel',
        actor,
      );
      return dtoOf(tx, row);
    },

    /** BR-7: only the accountant reverses a posted claim, and always with a reason. */
    async reverse(
      id: string,
      reason: string,
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<ClaimDto> {
      const existing = await locked(tx, id, actor, expectedVersion);
      const text = requiredText(reason, 'reason');
      assertReversible(existing.status);
      await reverseEntries(tx, existing, text, actor);
      const row = await moveTo(
        tx,
        existing,
        'cancelled',
        { cancel_reason: text },
        'reverse',
        actor,
      );
      return dtoOf(tx, row);
    },
  };
}

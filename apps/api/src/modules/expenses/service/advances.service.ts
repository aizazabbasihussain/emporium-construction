import {
  assertAdvanceIssued,
  positiveAmount,
  settlementNote,
  nonNegativeAmount,
} from '@emporium/domain/expenses';
import {
  assertCanReadBalance,
  assertCustodianUsable,
  assertFound,
  assertUpdated,
  canSeeAllCustodians,
} from '../policy/expenses.policy.js';
import {
  findAdvance,
  findCustodian,
  insertAdvance,
  listCustodians,
  searchAdvances,
  updateAdvance,
  upsertCustodian,
  type AdvanceRow,
  type CustodianRow,
} from '../repo/expenses.repo.js';
import type {
  Actor,
  AdvanceDto,
  AdvanceStatus,
  CandidateDto,
  CustodianDto,
  Db,
  PageResult,
} from '../types.js';
import type { Context } from './context.js';
import { pageOf, requiredText } from './support.js';

export interface AdvanceInput {
  custodianId: string;
  amount: string;
  issuedOn: string;
  purpose: string;
}

export interface AdvanceQuery {
  custodianId?: string | undefined;
  status?: AdvanceStatus | undefined;
  limit: number;
  offset: number;
}

export interface CustodianInput {
  floatLimit: string;
  active: boolean;
  version?: number | undefined;
}

const advanceOf = (row: AdvanceRow): AdvanceDto => ({
  id: row.id,
  number: row.number,
  custodianId: row.custodian_id,
  amount: row.amount,
  issuedOn: row.issued_on,
  issuedBy: row.issued_by,
  purpose: row.purpose,
  status: row.status as AdvanceStatus,
  settledOn: row.settled_on,
  settlementNote: row.settlement_note,
  version: row.version,
});

export type AdvanceService = ReturnType<typeof createAdvanceService>;

export function createAdvanceService(ctx: Context) {
  const { clock, record, newId } = ctx;

  const custodianOf = (row: CustodianRow, balance: string): CustodianDto => ({
    userId: row.user_id,
    floatLimit: row.float_limit,
    active: row.active,
    balance,
    version: row.version,
  });

  return {
    async list(db: Db, query: AdvanceQuery, actor: Actor): Promise<PageResult<AdvanceDto>> {
      // A claimant sees only the advances given to them.
      const custodianId = canSeeAllCustodians(actor) ? query.custodianId : actor.userId;
      const { rows, total } = await searchAdvances(db, { ...query, custodianId });
      return pageOf(rows.map(advanceOf), total, query);
    },

    /** BR-8: records custodian, amount and purpose; an `advance.issued` event follows. */
    async issue(input: AdvanceInput, actor: Actor, tx: Db): Promise<AdvanceDto> {
      assertCustodianUsable(await findCustodian(tx, input.custodianId, true));
      const amount = positiveAmount(input.amount, 'amount');
      await ctx.checkDate(tx, input.issuedOn, actor, 'exp_advance');
      const row = await insertAdvance(
        tx,
        {
          id: newId(),
          number: await ctx.platform.numbering.next('expense_advance', tx),
          custodian_id: input.custodianId,
          amount,
          issued_on: input.issuedOn,
          issued_by: actor.userId,
          purpose: requiredText(input.purpose, 'purpose'),
        },
        actor.userId,
        clock.now(),
      );
      await record(tx, actor, {
        action: 'expenses.advance.issue',
        entityType: 'exp_advance',
        entityId: row.id,
        after: { number: row.number, custodianId: row.custodian_id, amount: row.amount },
        event: {
          type: 'advance.issued',
          payload: {
            advanceId: row.id,
            number: row.number,
            custodianId: row.custodian_id,
            amount: row.amount,
            issuedOn: row.issued_on,
          },
        },
      });
      return advanceOf(row);
    },

    /** BR-8: the accountant settles by hand; unless the balance is zero a note says why. */
    async settle(
      id: string,
      input: { note?: string | undefined },
      expectedVersion: number,
      actor: Actor,
      tx: Db,
    ): Promise<AdvanceDto> {
      const existing = assertFound(await findAdvance(tx, id, true), 'advance');
      if (existing.version !== expectedVersion) assertUpdated(undefined);
      assertAdvanceIssued(existing.status as AdvanceStatus);
      const note = settlementNote(await ctx.balanceOf(tx, existing.custodian_id), input.note);
      const row = assertUpdated(
        await updateAdvance(
          tx,
          id,
          expectedVersion,
          { status: 'settled', settled_on: ctx.today(), settlement_note: note },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'expenses.advance.settle',
        entityType: 'exp_advance',
        entityId: id,
        before: { status: existing.status },
        after: { status: row.status, note },
        event: {
          type: 'expenses.advance.changed',
          payload: { advanceId: id, custodianId: row.custodian_id, status: row.status },
        },
      });
      return advanceOf(row);
    },

    /** Module interface `getCustodianBalance(userId)` (spec section 2, BR-1). */
    balance: (db: Db, userId: string): Promise<string> => ctx.balanceOf(db, userId),

    /** One custodian with their balance. */
    async getCustodian(db: Db, userId: string, actor: Actor): Promise<CustodianDto> {
      assertCanReadBalance(actor, userId);
      const row = assertFound(await findCustodian(db, userId), 'custodian');
      return custodianOf(row, await ctx.balanceOf(db, userId));
    },

    /** The custodian balances screen: finance and management only. */
    async listCustodians(db: Db): Promise<CustodianDto[]> {
      const rows = await listCustodians(db);
      return Promise.all(
        rows.map(async (row) => custodianOf(row, await ctx.balanceOf(db, row.user_id))),
      );
    },

    /** The people an advance can go to: active users, for the custodian picker. */
    async candidates(db: Db): Promise<CandidateDto[]> {
      return (await ctx.identity.users.list(db))
        .filter((user) => user.status === 'active')
        .map((user) => ({ id: user.id, fullName: user.fullName, email: user.email }));
    },

    /** Registers a custodian or changes their limit and status. */
    async saveCustodian(
      userId: string,
      input: CustodianInput,
      actor: Actor,
      tx: Db,
    ): Promise<CustodianDto> {
      await ctx.checkUser(tx, userId);
      const before = await findCustodian(tx, userId);
      // A stale version finds no row to update, which is a version conflict.
      const row = assertUpdated(
        await upsertCustodian(
          tx,
          {
            userId,
            floatLimit: nonNegativeAmount(input.floatLimit, 'float_limit'),
            active: input.active,
            expectedVersion: input.version,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await record(tx, actor, {
        action: 'expenses.custodian.save',
        entityType: 'exp_custodian',
        entityId: userId,
        before:
          before === undefined
            ? undefined
            : { floatLimit: before.float_limit, active: before.active },
        after: { floatLimit: row.float_limit, active: row.active },
        event: {
          type: 'expenses.custodian.changed',
          payload: { custodianId: userId, active: row.active },
        },
      });
      return custodianOf(row, await ctx.balanceOf(tx, userId));
    },
  };
}

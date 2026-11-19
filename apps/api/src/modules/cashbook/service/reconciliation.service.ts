import {
  assertCanComplete,
  assertReconciliationTransition,
  balanceOn,
  lineAmount,
  lineDirection,
  parseStatementCsv,
  reconciliationFigures,
  suggestMatches,
  type Direction,
  type ReconciliationStatus,
} from '@emporium/domain/cashbook';
import { BusinessDate, Money } from '@emporium/domain/kernel';
import {
  assertAccountActive,
  assertDraft,
  assertFound,
  assertLinesInPeriod,
  assertMatchable,
  assertPeriod,
  assertUpdated,
} from '../policy/cashbook.policy.js';
import {
  addItem,
  clearReconciled,
  clearStatement,
  findAccount,
  findLine,
  findRecon,
  flagReconciled,
  insertLine,
  insertRecon,
  listEntries,
  listLines,
  listRecons,
  matchableTxn,
  matchedTxnIds,
  removeItem,
  setLineMatch,
  unreconciledBook,
  updateRecon,
  type LineRow,
  type ReconRow,
} from '../repo/cashbook.repo.js';
import type {
  Actor,
  Db,
  ReconciliationDetailDto,
  ReconciliationDto,
  StatementLineDto,
} from '../types.js';
import type { Context } from './context.js';
import { transactionDto } from './transactions.service.js';

/** BR-8: a statement line is suggested against entries dated this many days apart at most. */
export const suggestionToleranceDays = 3;

export interface ReconciliationService {
  create(
    input: {
      accountId: string;
      statementFrom: string;
      statementTo: string;
      statementClosingBalance: string;
    },
    actor: Actor,
    tx: Db,
  ): Promise<ReconciliationDto>;
  list(db: Db, accountId: string | undefined): Promise<ReconciliationDto[]>;
  get(db: Db, id: string): Promise<ReconciliationDetailDto>;
  /** BR-8: replaces the statement lines of a draft with the lines of the CSV. */
  importStatement(id: string, csv: string, actor: Actor, tx: Db): Promise<ReconciliationDetailDto>;
  /** BR-8: the accountant confirms matches (a null transaction clears one). */
  match(
    id: string,
    matches: { lineId: string; transactionId: string | null }[],
    actor: Actor,
    tx: Db,
  ): Promise<ReconciliationDetailDto>;
  /** BR-8: completes only at a zero difference; matched transactions become reconciled. */
  complete(id: string, version: number, actor: Actor, tx: Db): Promise<ReconciliationDetailDto>;
  /** BR-8: un-reconciles so a transaction of the statement can be reversed. */
  reopen(id: string, actor: Actor, tx: Db): Promise<ReconciliationDetailDto>;
}

const reconDto = (row: ReconRow): ReconciliationDto => ({
  id: row.id,
  accountId: row.account_id,
  statementFrom: row.statement_from,
  statementTo: row.statement_to,
  statementClosingBalance: row.statement_closing_balance,
  bookBalanceAtEnd: row.book_balance_at_end,
  difference: row.difference,
  status: row.status as ReconciliationStatus,
  completedAt: row.completed_at,
  version: row.version,
});

const lineDto = (row: LineRow): StatementLineDto => ({
  id: row.id,
  lineNo: row.line_no,
  lineDate: row.line_date,
  description: row.description,
  debit: row.debit,
  credit: row.credit,
  matchedTransactionId: row.matched_transaction_id,
});

export function createReconciliationService(ctx: Context): ReconciliationService {
  const { newId, clock, record } = ctx;

  /** The workspace: lines, open book entries, suggestions and the figures of BR-8. */
  async function detail(db: Db, row: ReconRow): Promise<ReconciliationDetailDto> {
    const account = assertFound(await findAccount(db, row.account_id), 'account');
    const lines = await listLines(db, row.id);
    const open = await unreconciledBook(db, row.account_id, row.statement_to, row.id);
    const unmatchedLines = lines.filter((line) => line.matched_transaction_id === null);
    const entries = await listEntries(db, row.account_id);
    const bookBalance = balanceOn(account.opening_balance, entries, row.statement_to).toString();
    const figures = reconciliationFigures({
      statementClosingBalance: row.statement_closing_balance,
      bookBalance,
      unreconciledBook: open.map((txn) => ({
        direction: txn.direction as Direction,
        amount: txn.amount,
      })),
      unreconciledStatement: unmatchedLines,
    });
    return {
      ...reconDto(row),
      lines: lines.map(lineDto),
      candidates: open.map(transactionDto),
      suggestions: suggestMatches(
        unmatchedLines.map((line) => ({
          id: line.id,
          lineDate: line.line_date,
          debit: line.debit,
          credit: line.credit,
        })),
        open.map((txn) => ({
          id: txn.id,
          txnDate: txn.txn_date,
          direction: txn.direction as Direction,
          amount: txn.amount,
        })),
        suggestionToleranceDays,
      ),
      figures: { bookBalance, ...figures },
    };
  }

  async function load(db: Db, id: string, lock = false): Promise<ReconRow> {
    return assertFound(await findRecon(db, id, lock), 'reconciliation');
  }

  async function audit(tx: Db, actor: Actor, action: string, row: ReconRow, before?: ReconRow) {
    await record(tx, actor, {
      action: `cashbook.reconciliation.${action}`,
      entityType: 'cbk_reconciliation',
      entityId: row.id,
      before: before === undefined ? undefined : reconDto(before),
      after: reconDto(row),
      event: { type: 'cashbook.reconciliation.changed', payload: { reconciliationId: row.id } },
    });
  }

  return {
    async create(input, actor, tx) {
      const account = assertFound(await findAccount(tx, input.accountId), 'account');
      assertAccountActive(account.active);
      const from = BusinessDate.parse(input.statementFrom).toString();
      const to = BusinessDate.parse(input.statementTo).toString();
      assertPeriod(from, to);
      const row = await insertRecon(
        tx,
        {
          id: newId(),
          account_id: input.accountId,
          statement_from: from,
          statement_to: to,
          statement_closing_balance: Money.of(input.statementClosingBalance).toString(),
        },
        actor.userId,
        clock.now(),
      );
      await audit(tx, actor, 'create', row);
      return reconDto(row);
    },

    async list(db, accountId) {
      return (await listRecons(db, accountId)).map(reconDto);
    },

    async get(db, id) {
      return detail(db, await load(db, id));
    },

    async importStatement(id, csv, actor, tx) {
      const row = await load(tx, id, true);
      assertDraft(row.status);
      const lines = parseStatementCsv(csv);
      assertLinesInPeriod(lines, row.statement_from, row.statement_to);
      await clearStatement(tx, id);
      let lineNo = 0;
      for (const line of lines) {
        lineNo += 1;
        await insertLine(tx, { id: newId(), reconciliationId: id, lineNo, ...line });
      }
      await audit(tx, actor, 'import', row, row);
      return detail(tx, row);
    },

    async match(id, matches, actor, tx) {
      const row = await load(tx, id, true);
      assertDraft(row.status);
      for (const { lineId, transactionId } of matches) {
        const line = assertFound(await findLine(tx, id, lineId), 'statement_line');
        if (line.matched_transaction_id !== null) {
          await removeItem(tx, id, line.matched_transaction_id);
          await setLineMatch(tx, lineId, null);
        }
        if (transactionId !== null) {
          const txn = assertFound(
            await matchableTxn(tx, row.account_id, row.statement_to, transactionId),
            'transaction',
          );
          assertMatchable(
            { direction: lineDirection(line), amount: lineAmount(line) },
            { direction: txn.direction, amount: txn.amount },
          );
          await addItem(tx, id, transactionId, `line ${line.line_no}`);
          await setLineMatch(tx, lineId, transactionId);
        }
      }
      await audit(tx, actor, 'match', row, row);
      return detail(tx, row);
    },

    async complete(id, version, actor, tx) {
      const before = await load(tx, id, true);
      assertReconciliationTransition(before.status as ReconciliationStatus, 'completed');
      const figures = (await detail(tx, before)).figures;
      assertCanComplete(figures);
      const row = assertUpdated(
        await updateRecon(
          tx,
          id,
          version,
          {
            status: 'completed',
            book_balance_at_end: figures.bookBalance,
            difference: figures.difference,
            completed_by: actor.userId,
            completed_at: clock.now().toISOString(),
          },
          actor.userId,
          clock.now(),
        ),
      );
      await flagReconciled(tx, id, await matchedTxnIds(tx, id));
      await audit(tx, actor, 'complete', row, before);
      return detail(tx, row);
    },

    async reopen(id, actor, tx) {
      const before = await load(tx, id, true);
      assertReconciliationTransition(before.status as ReconciliationStatus, 'draft');
      await clearReconciled(tx, id);
      const row = assertUpdated(
        await updateRecon(
          tx,
          id,
          before.version,
          {
            status: 'draft',
            book_balance_at_end: null,
            difference: null,
            completed_by: null,
            completed_at: null,
          },
          actor.userId,
          clock.now(),
        ),
      );
      await audit(tx, actor, 'reopen', row, before);
      return detail(tx, row);
    },
  };
}

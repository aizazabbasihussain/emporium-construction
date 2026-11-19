import { DomainError } from '@emporium/domain';
import {
  cashbookSettingKeys,
  type CashDirection,
  type PendingSourceStatus,
} from '@emporium/shared';
import { assertFound, assertPending } from '../policy/cashbook.policy.js';
import {
  findPending,
  insertPending,
  listPending,
  markPending,
  type PendingRow,
} from '../repo/cashbook.repo.js';
import type { Actor, Db, PendingDto } from '../types.js';
import type { Context } from './context.js';
import type { TransactionService } from './transactions.service.js';

/** Source document type of an advance to a custodian (module expenses). */
export const advanceDocType = 'expense_advance';

interface AdvanceIssued {
  advanceId: string;
  number: string;
  custodianId: string;
  amount: string;
  issuedOn: string;
}

export interface SourceService {
  /**
   * BR-6: `advance.issued` becomes an outflow to the custodian. The configured advance account
   * takes it at once when it can; otherwise it waits for the accountant. A replay changes nothing.
   */
  onAdvanceIssued(payload: AdvanceIssued, tx: Db): Promise<void>;
  list(db: Db, status: PendingSourceStatus | undefined): Promise<PendingDto[]>;
  /** The accountant chooses the cash account of a waiting movement. */
  record(id: string, accountId: string, actor: Actor, tx: Db): Promise<PendingDto>;
}

const pendingDto = (row: PendingRow): PendingDto => ({
  id: row.id,
  sourceModule: row.source_module,
  sourceDocType: row.source_doc_type,
  sourceDocId: row.source_doc_id,
  direction: row.direction as CashDirection,
  amount: row.amount,
  txnDate: row.txn_date,
  description: row.description,
  status: row.status as PendingSourceStatus,
  note: row.note,
  transactionId: row.transaction_id,
});

const SYSTEM = { userId: null, requestId: null } as const;

export function createSourceService(
  ctx: Context,
  transactions: Pick<TransactionService, 'recordSourceOutflow' | 'checkOutflow'>,
): SourceService {
  const { platform, clock, newId } = ctx;

  async function settle(tx: Db, row: PendingRow, accountId: string, who: Actor | typeof SYSTEM) {
    const txn = await transactions.recordSourceOutflow(
      {
        accountId,
        txnDate: row.txn_date,
        amount: row.amount,
        sourceModule: row.source_module,
        sourceDocType: row.source_doc_type,
        sourceDocId: row.source_doc_id,
        description: row.description,
        idempotencyKey: `source:${row.source_doc_type}:${row.source_doc_id}`,
      },
      who,
      tx,
    );
    return markPending(tx, row.id, 'recorded', null, txn.id);
  }

  return {
    async onAdvanceIssued(payload, tx) {
      const row = await insertPending(tx, {
        id: newId(),
        source_module: 'expenses',
        source_doc_type: advanceDocType,
        source_doc_id: payload.advanceId,
        direction: 'out',
        amount: payload.amount,
        txn_date: payload.issuedOn,
        description: `Advance ${payload.number} to custodian`,
        counterparty_user_id: payload.custodianId,
        created_at: clock.now().toISOString(),
      });
      if (row === undefined) return;
      const accountId = (await platform.settings.get(tx, cashbookSettingKeys.advanceAccountId))
        .value as string;
      if (accountId === '') return;
      try {
        await transactions.checkOutflow(tx, {
          accountId,
          txnDate: row.txn_date,
          amount: row.amount,
        });
      } catch (error) {
        // A refusal (not enough cash, inactive account) must not fail the event: the accountant decides.
        if (!(error instanceof DomainError)) throw error;
        await markPending(tx, row.id, 'pending', error.message, null);
        return;
      }
      await settle(tx, row, accountId, SYSTEM);
    },

    async list(db, status) {
      return (await listPending(db, status)).map(pendingDto);
    },

    async record(id, accountId, actor, tx) {
      const row = assertFound(await findPending(tx, id, true), 'pending_source');
      assertPending(row.status);
      return pendingDto(await settle(tx, row, accountId, actor));
    },
  };
}

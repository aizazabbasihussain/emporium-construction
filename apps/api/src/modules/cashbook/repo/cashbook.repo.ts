import type { LedgerEntry } from '@emporium/domain/cashbook';
import type { Db } from '../types.js';
import { findRow, insertRow, updateRow, type Values } from './crud.js';

const DATE = (column: string, alias = column) => `to_char(${column}, 'YYYY-MM-DD') as ${alias}`;
const MONEY = (column: string) => `${column}::text as ${column}`;

/* ------------------------------------------------------------------ accounts */

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  bank_name: string | null;
  account_number_masked: string | null;
  account_code_tag: string | null;
  opening_balance: string;
  opening_date: string;
  allow_overdraft: boolean;
  active: boolean;
  version: number;
}

const ACCOUNT_COLUMNS = `id, code, name, kind, bank_name, account_number_masked, account_code_tag,
  ${MONEY('opening_balance')}, ${DATE('opening_date')}, allow_overdraft, active, version`;

export const insertAccount = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<AccountRow>(db, 'cbk_accounts', ACCOUNT_COLUMNS, values, by, at);

export const updateAccount = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<AccountRow>(db, 'cbk_accounts', ACCOUNT_COLUMNS, id, version, values, by, at);

export const findAccount = (db: Db, id: string, lock = false) =>
  findRow<AccountRow>(db, 'cbk_accounts', ACCOUNT_COLUMNS, id, lock);

export const listAccounts = (db: Db, includeInactive: boolean) =>
  db.query<AccountRow>(
    `select ${ACCOUNT_COLUMNS} from cbk_accounts
      where deleted_at is null ${includeInactive ? '' : 'and active'} order by code`,
  );

export const findAccountByCode = (db: Db, code: string) =>
  db
    .query<{ id: string }>(
      'select id from cbk_accounts where lower(code) = lower($1) and deleted_at is null',
      [code],
    )
    .then((rows) => rows[0]);

export const countAccountTransactions = (db: Db, accountId: string) =>
  db
    .query<{ n: string }>('select count(*) as n from cbk_transactions where account_id = $1', [
      accountId,
    ])
    .then((rows) => Number(rows[0]?.n ?? 0));

export const softDeleteAccount = (
  db: Db,
  id: string,
  version: number,
  by: string,
  at: Date,
): Promise<AccountRow | undefined> =>
  updateRow<AccountRow>(
    db,
    'cbk_accounts',
    ACCOUNT_COLUMNS,
    id,
    version,
    { deleted_at: at.toISOString(), active: false },
    by,
    at,
  );

/* -------------------------------------------------------------- transactions */

export interface TxnRow {
  id: string;
  number: string;
  account_id: string;
  txn_date: string;
  direction: string;
  amount: string;
  txn_type: string;
  counterparty_party_id: string | null;
  source_module: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  method: string;
  reference: string | null;
  description: string | null;
  account_tag: string | null;
  reconciled_in: string | null;
  reverses_id: string | null;
  transfer_pair_id: string | null;
  approval_doc_id: string | null;
  reversed_by_id: string | null;
  running_balance?: string;
}

const TXN_COLUMNS = `t.id, t.number, t.account_id, ${DATE('t.txn_date', 'txn_date')}, t.direction,
  t.amount::text as amount, t.txn_type, t.counterparty_party_id, t.source_module, t.source_doc_type,
  t.source_doc_id, t.method, t.reference, t.description, t.account_tag, t.reconciled_in, t.reverses_id,
  t.transfer_pair_id, t.approval_doc_id,
  (select r.id from cbk_transactions r where r.reverses_id = t.id) as reversed_by_id`;

export interface NewTxn {
  id: string;
  number: string;
  account_id: string;
  txn_date: string;
  direction: string;
  amount: string;
  txn_type: string;
  counterparty_party_id: string | null;
  source_module: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  method: string;
  reference: string | null;
  description: string | null;
  account_tag: string | null;
  reverses_id: string | null;
  reversal_reason: string | null;
  transfer_pair_id: string | null;
  approval_doc_id: string | null;
  idempotency_key: string;
  posted_at: string;
  posted_by: string | null;
}

export async function insertTxn(db: Db, values: NewTxn): Promise<TxnRow> {
  const names = Object.keys(values);
  await db.query(
    `insert into cbk_transactions (${names.join(', ')})
     values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    names.map((name) => values[name as keyof NewTxn]),
  );
  return (await findTxn(db, values.id)) as TxnRow;
}

export const findTxn = (db: Db, id: string, lock = false) =>
  db
    .query<TxnRow>(
      `select ${TXN_COLUMNS} from cbk_transactions t where t.id = $1 ${lock ? 'for update of t' : ''}`,
      [id],
    )
    .then((rows) => rows[0]);

export const findTxnByKey = (db: Db, key: string) =>
  db
    .query<TxnRow>(`select ${TXN_COLUMNS} from cbk_transactions t where t.idempotency_key = $1`, [
      key,
    ])
    .then((rows) => rows[0]);

export const findTxnsByPair = (db: Db, pairId: string) =>
  db.query<TxnRow>(
    `select ${TXN_COLUMNS} from cbk_transactions t where t.transfer_pair_id = $1
      order by t.direction desc for update of t`,
    [pairId],
  );

/** Every entry of an account, for balances and the overdraft check. */
export const listEntries = (db: Db, accountId: string): Promise<LedgerEntry[]> =>
  db
    .query<{ direction: 'in' | 'out'; amount: string; txn_date: string }>(
      `select direction, amount::text as amount, ${DATE('txn_date')} from cbk_transactions
        where account_id = $1`,
      [accountId],
    )
    .then((rows) =>
      rows.map((r) => ({ direction: r.direction, amount: r.amount, txnDate: r.txn_date })),
    );

/** BR-5: how much of an approved payment request is already paid. */
export const paidAgainstApproval = (db: Db, approvalDocId: string) =>
  db
    .query<{ total: string }>(
      `select coalesce(sum(amount), 0)::text as total from cbk_transactions t
        where approval_doc_id = $1
          and not exists (select 1 from cbk_transactions r where r.reverses_id = t.id)`,
      [approvalDocId],
    )
    .then((rows) => rows[0]?.total ?? '0');

export interface TxnQuery {
  accountId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  needsTag: boolean | undefined;
  limit: number;
  offset: number;
}

/**
 * The cash book (BR-1): the running balance is computed over the whole account before any filter or
 * page, so a filtered page still shows the true balance after each line.
 */
export async function searchTxns(
  db: Db,
  query: TxnQuery,
): Promise<{ rows: TxnRow[]; total: number }> {
  const params: unknown[] = [query.accountId ?? null, query.from ?? null, query.to ?? null];
  const outer = `($2::date is null or txn_date::date >= $2::date) and ($3::date is null or txn_date::date <= $3::date)
    ${query.needsTag ? "and account_tag is null and txn_type <> 'transfer_in' and txn_type <> 'transfer_out'" : ''}`;
  const inner = `select ${TXN_COLUMNS},
      (a.opening_balance + sum(case when t.direction = 'in' then t.amount else -t.amount end)
         over (partition by t.account_id order by t.txn_date, t.id
               rows between unbounded preceding and current row))::text as running_balance
    from cbk_transactions t join cbk_accounts a on a.id = t.account_id
   where ($1::uuid is null or t.account_id = $1::uuid)`;
  const total = await db
    .query<{ n: string }>(`select count(*) as n from (${inner}) x where ${outer}`, params)
    .then((rows) => Number(rows[0]?.n ?? 0));
  const rows = await db.query<TxnRow>(
    `select * from (${inner}) x where ${outer}
      order by txn_date desc, id desc limit $4 offset $5`,
    [...params, query.limit, query.offset],
  );
  return { rows, total };
}

export const setTxnTag = (db: Db, id: string, tag: string | null) =>
  db.query('update cbk_transactions set account_tag = $1 where id = $2', [tag, id]);

/* -------------------------------------------------------------- reconciliation */

export interface ReconRow {
  id: string;
  account_id: string;
  statement_from: string;
  statement_to: string;
  statement_closing_balance: string;
  book_balance_at_end: string | null;
  difference: string | null;
  status: string;
  completed_at: string | null;
  version: number;
}

const RECON_COLUMNS = `id, account_id, ${DATE('statement_from')}, ${DATE('statement_to')},
  ${MONEY('statement_closing_balance')}, book_balance_at_end::text as book_balance_at_end,
  difference::text as difference, status, completed_at::text as completed_at, version`;

export const insertRecon = (db: Db, values: Values, by: string | null, at: Date) =>
  insertRow<ReconRow>(db, 'cbk_reconciliations', RECON_COLUMNS, values, by, at);

export const updateRecon = (
  db: Db,
  id: string,
  version: number,
  values: Values,
  by: string | null,
  at: Date,
) => updateRow<ReconRow>(db, 'cbk_reconciliations', RECON_COLUMNS, id, version, values, by, at);

export const findRecon = (db: Db, id: string, lock = false) =>
  findRow<ReconRow>(db, 'cbk_reconciliations', RECON_COLUMNS, id, lock);

export const listRecons = (db: Db, accountId: string | undefined) =>
  db.query<ReconRow>(
    `select ${RECON_COLUMNS} from cbk_reconciliations
      where deleted_at is null and ($1::uuid is null or account_id = $1::uuid)
      order by statement_to desc, id desc`,
    [accountId ?? null],
  );

export interface LineRow {
  id: string;
  line_no: number;
  line_date: string;
  description: string;
  debit: string;
  credit: string;
  matched_transaction_id: string | null;
}

const LINE_COLUMNS = `id, line_no, ${DATE('line_date')}, description, ${MONEY('debit')},
  ${MONEY('credit')}, matched_transaction_id`;

export const listLines = (db: Db, reconId: string) =>
  db.query<LineRow>(
    `select ${LINE_COLUMNS} from cbk_statement_lines where reconciliation_id = $1 order by line_no`,
    [reconId],
  );

export const findLine = (db: Db, reconId: string, lineId: string) =>
  db
    .query<LineRow>(
      `select ${LINE_COLUMNS} from cbk_statement_lines
        where reconciliation_id = $1 and id = $2 for update`,
      [reconId, lineId],
    )
    .then((rows) => rows[0]);

export const insertLine = (
  db: Db,
  line: {
    id: string;
    reconciliationId: string;
    lineNo: number;
    lineDate: string;
    description: string;
    debit: string;
    credit: string;
  },
) =>
  db.query(
    `insert into cbk_statement_lines
       (id, reconciliation_id, line_no, line_date, description, debit, credit)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      line.id,
      line.reconciliationId,
      line.lineNo,
      line.lineDate,
      line.description,
      line.debit,
      line.credit,
    ],
  );

/** A new import replaces the lines (and so the matches) of a draft. */
export async function clearStatement(db: Db, reconId: string): Promise<void> {
  await db.query('delete from cbk_reconciliation_items where reconciliation_id = $1', [reconId]);
  await db.query('delete from cbk_statement_lines where reconciliation_id = $1', [reconId]);
}

export const setLineMatch = (db: Db, lineId: string, transactionId: string | null) =>
  db.query('update cbk_statement_lines set matched_transaction_id = $1 where id = $2', [
    transactionId,
    lineId,
  ]);

export const addItem = (db: Db, reconId: string, transactionId: string, ref: string) =>
  db.query(
    `insert into cbk_reconciliation_items (reconciliation_id, transaction_id, matched_statement_ref)
     values ($1, $2, $3)`,
    [reconId, transactionId, ref],
  );

export const removeItem = (db: Db, reconId: string, transactionId: string) =>
  db.query(
    'delete from cbk_reconciliation_items where reconciliation_id = $1 and transaction_id = $2',
    [reconId, transactionId],
  );

/** A transaction a statement line may be matched to: unreconciled, in this account, not yet matched elsewhere. */
export const matchableTxn = (db: Db, accountId: string, to: string, transactionId: string) =>
  db
    .query<TxnRow>(
      `select ${TXN_COLUMNS} from cbk_transactions t
        where t.id = $1 and t.account_id = $2 and t.txn_date <= $3::date
          and t.reconciled_in is null
          and not exists (select 1 from cbk_reconciliation_items i where i.transaction_id = t.id)
        for update of t`,
      [transactionId, accountId, to],
    )
    .then((rows) => rows[0]);

/** Book transactions up to the statement end that are not reconciled and not matched in this draft. */
export const unreconciledBook = (db: Db, accountId: string, to: string, reconId: string) =>
  db.query<TxnRow>(
    `select ${TXN_COLUMNS} from cbk_transactions t
      where t.account_id = $1 and t.txn_date <= $2::date and t.reconciled_in is null
        and not exists (select 1 from cbk_reconciliation_items i
                         where i.transaction_id = t.id and i.reconciliation_id = $3)
      order by t.txn_date, t.id`,
    [accountId, to, reconId],
  );

export const matchedTxnIds = (db: Db, reconId: string) =>
  db
    .query<{ transaction_id: string }>(
      'select transaction_id from cbk_reconciliation_items where reconciliation_id = $1',
      [reconId],
    )
    .then((rows) => rows.map((r) => r.transaction_id));

export const flagReconciled = (db: Db, reconId: string, transactionIds: readonly string[]) =>
  db.query('update cbk_transactions set reconciled_in = $1 where id = any($2::uuid[])', [
    reconId,
    transactionIds,
  ]);

export const clearReconciled = (db: Db, reconId: string) =>
  db.query('update cbk_transactions set reconciled_in = null where reconciled_in = $1', [reconId]);

/* ----------------------------------------------------------- pending sources */

export interface PendingRow {
  id: string;
  source_module: string;
  source_doc_type: string;
  source_doc_id: string;
  direction: string;
  amount: string;
  txn_date: string;
  description: string | null;
  counterparty_user_id: string | null;
  status: string;
  note: string | null;
  transaction_id: string | null;
}

const PENDING_COLUMNS = `id, source_module, source_doc_type, source_doc_id, direction,
  ${MONEY('amount')}, ${DATE('txn_date')}, description, counterparty_user_id, status, note,
  transaction_id`;

/** Undefined when the source was already announced (a replayed event). */
export const insertPending = (
  db: Db,
  values: {
    id: string;
    source_module: string;
    source_doc_type: string;
    source_doc_id: string;
    direction: string;
    amount: string;
    txn_date: string;
    description: string | null;
    counterparty_user_id: string | null;
    created_at: string;
  },
) => {
  const names = Object.keys(values);
  return db
    .query<PendingRow>(
      `insert into cbk_pending_sources (${names.join(', ')})
       values (${names.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (source_doc_type, source_doc_id) do nothing
       returning ${PENDING_COLUMNS}`,
      names.map((name) => values[name as keyof typeof values]),
    )
    .then((rows) => rows[0]);
};

export const findPending = (db: Db, id: string, lock = false) =>
  db
    .query<PendingRow>(
      `select ${PENDING_COLUMNS} from cbk_pending_sources where id = $1 ${lock ? 'for update' : ''}`,
      [id],
    )
    .then((rows) => rows[0]);

export const listPending = (db: Db, status: string | undefined) =>
  db.query<PendingRow>(
    `select ${PENDING_COLUMNS} from cbk_pending_sources
      where ($1::text is null or status = $1::text) order by created_at, id`,
    [status ?? null],
  );

export const markPending = (
  db: Db,
  id: string,
  status: string,
  note: string | null,
  txnId: string | null,
) =>
  db
    .query<PendingRow>(
      `update cbk_pending_sources set status = $2, note = $3, transaction_id = $4
        where id = $1 returning ${PENDING_COLUMNS}`,
      [id, status, note, txnId],
    )
    .then((rows) => rows[0] as PendingRow);

import type {
  CashAccountKind,
  CashDirection,
  CashMethod,
  CashTxnType,
  PendingSourceStatus,
  ReconciliationStatusValue,
} from '@emporium/shared';
import { request } from '../admin/api';

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  kind: CashAccountKind;
  bankName: string | null;
  accountNumberMasked: string | null;
  accountCodeTag: string | null;
  openingBalance: string;
  openingDate: string;
  allowOverdraft: boolean;
  active: boolean;
  version: number;
  balance?: string;
}

export interface Txn {
  id: string;
  number: string;
  accountId: string;
  txnDate: string;
  direction: CashDirection;
  amount: string;
  txnType: CashTxnType;
  method: CashMethod;
  reference: string | null;
  description: string | null;
  accountTag: string | null;
  reconciledIn: string | null;
  reversesId: string | null;
  reversed: boolean;
  transferPairId: string | null;
  runningBalance?: string;
}

export interface Position {
  date: string;
  accounts: {
    accountId: string;
    code: string;
    name: string;
    kind: CashAccountKind;
    balance: string;
    movementIn: string;
    movementOut: string;
  }[];
  totalCash: string;
  totalBank: string;
  total: string;
  movementIn: string;
  movementOut: string;
}

export interface Pending {
  id: string;
  sourceDocId: string;
  amount: string;
  txnDate: string;
  description: string | null;
  status: PendingSourceStatus;
  note: string | null;
}

export interface StatementLine {
  id: string;
  lineNo: number;
  lineDate: string;
  description: string;
  debit: string;
  credit: string;
  matchedTransactionId: string | null;
}

export interface Reconciliation {
  id: string;
  accountId: string;
  statementFrom: string;
  statementTo: string;
  statementClosingBalance: string;
  bookBalanceAtEnd: string | null;
  difference: string | null;
  status: ReconciliationStatusValue;
  version: number;
}

export interface ReconciliationDetail extends Reconciliation {
  lines: StatementLine[];
  candidates: Txn[];
  suggestions: { lineId: string; transactionId: string; dayDifference: number }[];
  figures: {
    bookBalance: string;
    bookUnreconciled: string;
    statementUnreconciled: string;
    expectedClosing: string;
    difference: string;
  };
}

export interface AccountBody {
  code: string;
  name: string;
  kind: CashAccountKind;
  openingBalance: string;
  openingDate: string;
  bankName?: string;
  accountNumberMasked?: string;
  accountCodeTag?: string;
  allowOverdraft?: boolean;
}

export interface EntryBody {
  accountId: string;
  txnDate: string;
  amount: string;
  method: CashMethod;
  reference?: string;
  description?: string;
  accountTag?: string;
  approvalDocId?: string;
}

export interface TransferBody {
  fromAccountId: string;
  toAccountId: string;
  txnDate: string;
  amount: string;
  reference?: string;
  description?: string;
}

export const cashbookApi = {
  accounts: (includeInactive = false) =>
    request<Account[]>('GET', `/cashbook/accounts?includeInactive=${includeInactive}`),
  createAccount: (body: AccountBody) => request<Account>('POST', '/cashbook/accounts', body),
  setActive: (account: Account, active: boolean) =>
    request<Account>('PUT', `/cashbook/accounts/${account.id}`, {
      name: account.name,
      active,
      version: account.version,
    }),
  transactions: (query: {
    accountId?: string;
    from?: string;
    to?: string;
    needsTag?: boolean;
    offset?: number;
  }) => {
    const params = new URLSearchParams({ limit: '100' });
    if (query.accountId) params.set('accountId', query.accountId);
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.needsTag) params.set('needsTag', 'true');
    if (query.offset) params.set('offset', String(query.offset));
    return request<Page<Txn>>('GET', `/cashbook/transactions?${params.toString()}`);
  },
  receipt: (body: EntryBody) => request<Txn>('POST', '/cashbook/receipts', body),
  payment: (body: EntryBody) => request<Txn>('POST', '/cashbook/payments', body),
  transfer: (body: TransferBody) =>
    request<{ out: Txn; in: Txn }>('POST', '/cashbook/transfers', body),
  requestApproval: (body: { docType: 'payment'; amount: string; accountId: string }) =>
    request<{ approvalDocId: string }>('POST', '/cashbook/approval-requests', body),
  reverse: (id: string, reason: string) =>
    request<Txn[]>('POST', `/cashbook/transactions/${id}/reverse`, { reason }),
  setTag: (id: string, accountTag: string | null) =>
    request<Txn>('PUT', `/cashbook/transactions/${id}/tag`, { accountTag }),
  position: (date: string) => request<Position>('GET', `/cashbook/position?date=${date}`),
  pending: () => request<Pending[]>('GET', '/cashbook/pending?status=pending'),
  recordPending: (id: string, accountId: string) =>
    request<Pending>('POST', `/cashbook/pending/${id}/record`, { accountId }),
  reconciliations: () => request<Reconciliation[]>('GET', '/cashbook/reconciliations'),
  createReconciliation: (body: {
    accountId: string;
    statementFrom: string;
    statementTo: string;
    statementClosingBalance: string;
  }) => request<Reconciliation>('POST', '/cashbook/reconciliations', body),
  reconciliation: (id: string) =>
    request<ReconciliationDetail>('GET', `/cashbook/reconciliations/${id}`),
  importStatement: (id: string, csv: string) =>
    request<ReconciliationDetail>('POST', `/cashbook/reconciliations/${id}/import`, { csv }),
  match: (id: string, matches: { lineId: string; transactionId: string | null }[]) =>
    request<ReconciliationDetail>('POST', `/cashbook/reconciliations/${id}/match`, { matches }),
  complete: (id: string, version: number) =>
    request<ReconciliationDetail>('POST', `/cashbook/reconciliations/${id}/complete`, { version }),
  reopen: (id: string) =>
    request<ReconciliationDetail>('POST', `/cashbook/reconciliations/${id}/reopen`),
};

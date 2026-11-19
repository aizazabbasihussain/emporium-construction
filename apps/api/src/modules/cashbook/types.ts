import type { ScopeGrant } from '@emporium/domain/identity';
import type {
  CashAccountKind,
  CashDirection,
  CashMethod,
  CashTxnType,
  PendingSourceStatus,
  ReconciliationStatusValue,
} from '@emporium/shared';
import type { Db } from '../platform/index.js';

export type { Db };

export interface Actor {
  userId: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
  permissions: ReadonlySet<string>;
  requestId: string | null;
}

/** The system acts on events: no user, no permissions, no date check. */
export interface SystemActor {
  userId: null;
  requestId: null;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AccountDto {
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
  /** Present on the detail and the list: the balance today. */
  balance?: string;
}

export interface TransactionDto {
  id: string;
  number: string;
  accountId: string;
  txnDate: string;
  direction: CashDirection;
  amount: string;
  txnType: CashTxnType;
  counterpartyPartyId: string | null;
  sourceModule: string | null;
  sourceDocType: string | null;
  sourceDocId: string | null;
  method: CashMethod;
  reference: string | null;
  description: string | null;
  accountTag: string | null;
  reconciledIn: string | null;
  reversesId: string | null;
  reversed: boolean;
  transferPairId: string | null;
  /** Running balance of the account after this transaction (cash book view only). */
  runningBalance?: string;
}

export interface PositionDto {
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

export interface PendingDto {
  id: string;
  sourceModule: string;
  sourceDocType: string;
  sourceDocId: string;
  direction: CashDirection;
  amount: string;
  txnDate: string;
  description: string | null;
  status: PendingSourceStatus;
  note: string | null;
  transactionId: string | null;
}

export interface StatementLineDto {
  id: string;
  lineNo: number;
  lineDate: string;
  description: string;
  debit: string;
  credit: string;
  matchedTransactionId: string | null;
}

export interface ReconciliationDto {
  id: string;
  accountId: string;
  statementFrom: string;
  statementTo: string;
  statementClosingBalance: string;
  bookBalanceAtEnd: string | null;
  difference: string | null;
  status: ReconciliationStatusValue;
  completedAt: string | null;
  version: number;
}

export interface ReconciliationDetailDto extends ReconciliationDto {
  lines: StatementLineDto[];
  /** Book transactions not yet matched, which a statement line may be matched to. */
  candidates: TransactionDto[];
  suggestions: { lineId: string; transactionId: string; dayDifference: number }[];
  figures: {
    bookBalance: string;
    bookUnreconciled: string;
    statementUnreconciled: string;
    expectedClosing: string;
    difference: string;
  };
}

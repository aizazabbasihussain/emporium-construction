// The only public entry point of the cashbook module.
import type { Clock } from '@emporium/domain/kernel';
import type { Approvals } from '../approvals/index.js';
import type { Platform } from '../platform/index.js';
import { createAccountService, type AccountService } from './service/accounts.service.js';
import { createContext } from './service/context.js';
import {
  createReconciliationService,
  type ReconciliationService,
} from './service/reconciliation.service.js';
import { createSourceService, type SourceService } from './service/sources.service.js';
import {
  createTransactionService,
  type TransactionService,
} from './service/transactions.service.js';

export interface Cashbook {
  accounts: AccountService;
  transactions: TransactionService;
  reconciliation: ReconciliationService;
  sources: SourceService;
  /** Module-to-module API (spec P2-03 section 2); call it inside the owning module's transaction. */
  recordReceipt: TransactionService['recordReceipt'];
  recordPayment: TransactionService['recordPayment'];
  recordTransfer: TransactionService['recordTransfer'];
  getAccountBalance: AccountService['getBalance'];
  getCashPosition: TransactionService['getCashPosition'];
}

/**
 * Wires the cash book on top of the kernel and approvals. It allocates no receipt to an invoice
 * and no payment to a bill: receivables and payables call it for the money movement.
 */
export function createCashbook(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  approvals: Pick<Approvals, 'requestApproval' | 'getApprovalState'>;
}): Cashbook {
  const ctx = createContext(deps);
  const accounts = createAccountService(ctx);
  const transactions = createTransactionService(ctx);
  const reconciliation = createReconciliationService(ctx);
  const sources = createSourceService(ctx, transactions);
  // BR-6: an advance is cash leaving for the custodian. `expense.posted` moves no cash, so it has no handler.
  deps.platform.events.subscribe(
    'advance.issued',
    async (event, tx) => {
      await sources.onAdvanceIssued(
        event.payload as Parameters<SourceService['onAdvanceIssued']>[0],
        tx,
      );
    },
    'cashbook.advance.issued',
  );
  return {
    accounts,
    transactions,
    reconciliation,
    sources,
    recordReceipt: (cmd, actor, tx) => transactions.recordReceipt(cmd, actor, tx),
    recordPayment: (cmd, actor, tx) => transactions.recordPayment(cmd, actor, tx),
    recordTransfer: (cmd, actor, tx) => transactions.recordTransfer(cmd, actor, tx),
    getAccountBalance: (db, accountId, date) => accounts.getBalance(db, accountId, date),
    getCashPosition: (db, date) => transactions.getCashPosition(db, date),
  };
}

export { registerCashbookRoutes, type CashbookRouteDeps } from './routes/cashbook.routes.js';
export type {
  AccountDto,
  PendingDto,
  PositionDto,
  ReconciliationDetailDto,
  ReconciliationDto,
  StatementLineDto,
  TransactionDto,
} from './types.js';

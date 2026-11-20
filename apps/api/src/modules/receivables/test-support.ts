import { cashbookPermissions, receivablesPermissions } from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import {
  ACCOUNTANT,
  ADMIN,
  MANAGEMENT,
  NOBODY,
  createBillingKit,
  uid,
  type BillingKit,
} from './billing-kit.js';
import { createCashbook, type Cashbook } from '../cashbook/index.js';
import { createNotifications, type Notifications } from '../notifications/index.js';
import { createReceivables, type Receivables } from './index.js';
import type { AllocationCommand, ChequeInput } from './service/receipts.service.js';
import type { Actor, PdcDto, ReceiptDto } from './types.js';

export { ACCOUNTANT, ADMIN, MANAGEMENT, NOBODY, uid };

/** "Today" of every kit: the billing kit's clock is fixed here. */
export const TODAY = '2026-11-18';

export interface ReceivablesKit extends BillingKit {
  cashbook: Cashbook;
  notifications: Notifications;
  receivables: Receivables;
  rapp: FastifyInstance;
  /** The accountant, who holds every receivables and cash book permission. */
  ractor: Actor;
  /** The client party of every project the kit creates. */
  partyId(): Promise<string>;
  /** A bank account of the cash book. */
  bank(): Promise<string>;
  /** An issued invoice of a new project; `gross` is its gross total. */
  invoice(
    stageNos?: number[],
  ): Promise<{ id: string; gross: string; dueDate: string; projectId: string }>;
  /** A receipt by bank transfer into the account, allocated to the invoices when given. */
  receipt(
    partyId: string,
    accountId: string,
    amount: string,
    allocations?: AllocationCommand[],
    over?: Partial<Parameters<Receivables['receipts']['create']>[0]>,
  ): Promise<ReceiptDto>;
  /** A cheque receipt (pending clearing) with its register entry. */
  cheque(
    partyId: string,
    amount: string,
    allocations?: AllocationCommand[],
    cheque?: Partial<ChequeInput>,
  ): Promise<{ receipt: ReceiptDto; pdc: PdcDto }>;
  /** The cheque deposited into the account and cleared. */
  clearedCheque(
    partyId: string,
    accountId: string,
    amount: string,
    allocations?: AllocationCommand[],
  ): Promise<{ receipt: ReceiptDto; pdc: PdcDto }>;
  /** An advance invoice of the project issued and waiting for the money. */
  advance(
    projectId: string,
    amount: string,
  ): Promise<{ advanceId: string; invoiceId: string; gross: string }>;
  /** A credit note of the invoice, approved and issued. */
  creditNote(invoiceId: string, baseAmount: string): Promise<string>;
  balance(partyId: string, date?: string): Promise<string>;
  run<T>(fn: (tx: Parameters<Parameters<BillingKit['tx']>[0]>[0]) => Promise<T>): Promise<T>;
  racc(userId: string): Promise<{ authorization: string }>;
}

export async function createReceivablesKit(): Promise<ReceivablesKit> {
  const base = await createBillingKit();
  const { db, platform, identity, approvals, billing, masterData, projects } = base;
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  identity.registerPermissions('receivables', Object.values(receivablesPermissions));
  const clock = { now: () => new Date(base.now.current) };
  let counter = 50_000;
  const newId = () => `018f7c7c-7777-7000-8000-${String(++counter).padStart(12, '0')}`;
  const cashbook = createCashbook({ platform, clock, newId, approvals });
  const notifications = createNotifications({
    platform,
    clock,
    newId,
    directory: {
      async usersWithRole(tx, roleCode) {
        return (await identity.users.list(tx))
          .filter((user) => user.status === 'active' && user.roles.includes(roleCode))
          .map((user) => ({ id: user.id, roles: user.roles, scopes: user.scopes }));
      },
    },
    getApprovalState: approvals.getApprovalState,
  });
  const receivables = createReceivables({
    platform,
    clock,
    newId,
    cashbook,
    billing,
    approvals,
    notifications,
    masterData,
    projects,
  });
  const rapp = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => base.now.current,
    identity: { db, identity },
    receivables: { db, receivables, platform },
  });
  await rapp.ready();

  const permissions = new Set<string>([
    ...Object.values(receivablesPermissions),
    ...Object.values(cashbookPermissions),
  ]);
  const ractor: Actor = {
    userId: ACCOUNTANT,
    roles: ['accountant'],
    scopes: [],
    permissions,
    requestId: null,
  };
  let accountCounter = 0;
  let party: string | undefined;

  const kit: ReceivablesKit = {
    ...base,
    cashbook,
    notifications,
    receivables,
    rapp,
    ractor,
    run: (fn) => base.tx(fn),

    async partyId() {
      if (party === undefined) {
        const project = await base.project();
        party = (await projects.service.get(db, project.id, base.actor)).partyId;
      }
      return party;
    },

    async bank() {
      const account = await base.tx((tx) =>
        cashbook.accounts.create(
          {
            code: `RCV-BANK-${++accountCounter}`,
            name: `Receipts bank ${accountCounter}`,
            kind: 'bank',
            openingBalance: '0',
            openingDate: '2026-01-01',
          },
          ractor,
          tx,
        ),
      );
      return account.id;
    },

    async invoice(stageNos = [1]) {
      const project = await base.project();
      const issued = await base.issued(project.id, stageNos);
      return {
        id: issued.id,
        gross: issued.grossTotal,
        dueDate: issued.dueDate,
        projectId: project.id,
      };
    },

    receipt: (partyId, accountId, amount, allocations, over = {}) =>
      base.tx((tx) =>
        receivables.receipts.create(
          {
            partyId,
            receiptDate: TODAY,
            method: 'bank_transfer',
            amount,
            accountId,
            ...(allocations === undefined ? {} : { allocations }),
            ...over,
          },
          ractor,
          tx,
        ),
      ),

    async cheque(partyId, amount, allocations = [], cheque = {}) {
      const receipt = await base.tx((tx) =>
        receivables.receipts.create(
          {
            partyId,
            receiptDate: TODAY,
            method: 'pdc',
            amount,
            cheque: {
              chequeNumber: 'CH-001',
              bankName: 'Synthetic Bank',
              chequeDate: TODAY,
              ...cheque,
            },
            allocations,
          },
          ractor,
          tx,
        ),
      );
      const register = await receivables.pdcs.register(db, {});
      const pdc = register.items.find((item) => item.receiptId === receipt.id) as PdcDto;
      return { receipt, pdc };
    },

    async clearedCheque(partyId, accountId, amount, allocations = []) {
      const { receipt, pdc } = await kit.cheque(partyId, amount, allocations);
      const deposited = await base.tx((tx) =>
        receivables.pdcs.deposit(pdc.id, { accountId, version: pdc.version }, ractor, tx),
      );
      const cleared = await base.tx((tx) =>
        receivables.pdcs.clear(pdc.id, { version: deposited.version }, ractor, tx),
      );
      return { receipt: await receivables.receipts.get(db, receipt.id), pdc: cleared };
    },

    async advance(projectId, amount) {
      const { advance: row, invoice } = await base.tx((tx) =>
        billing.advances.request({ projectId, amount, invoiceDate: TODAY }, base.actor, tx),
      );
      await base.tx((tx) => billing.invoices.submit(invoice.id, invoice.version, base.actor, tx));
      await base.decide('invoice', invoice.id, 'approve');
      const approved = await base.get(invoice.id);
      const issued = await base.tx((tx) =>
        billing.invoices.issue(approved.id, approved.version, base.actor, tx),
      );
      return { advanceId: row.id, invoiceId: issued.id, gross: issued.grossTotal };
    },

    async creditNote(invoiceId, baseAmount) {
      const draft = await base.tx((tx) =>
        billing.creditNotes.create(
          invoiceId,
          { reason: 'Scope reduced', baseAmount },
          base.actor,
          tx,
        ),
      );
      await base.tx((tx) => billing.creditNotes.submit(draft.id, draft.version, base.actor, tx));
      await base.decide('credit_note', draft.id, 'approve');
      const approved = await billing.creditNotes.get(db, draft.id, base.actor);
      const issued = await base.tx((tx) =>
        billing.creditNotes.issue(draft.id, approved.version, base.actor, tx),
      );
      return issued.grossTotal;
    },

    async balance(partyId, date = TODAY) {
      return (await receivables.getCustomerBalance(db, partyId, date)).balance;
    },

    async racc(userId) {
      return base.auth(userId);
    },

    async close() {
      await rapp.close();
      await base.close();
    },
  };
  return kit;
}

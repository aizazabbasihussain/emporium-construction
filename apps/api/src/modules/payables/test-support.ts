import {
  cashbookPermissions,
  inventoryPermissions,
  notificationsPermissions,
  payablesPermissions,
  taxPermissions,
  valuationPermissions,
} from '@emporium/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { createLogger } from '../../logger.js';
import { createCashbook, type Cashbook } from '../cashbook/index.js';
import { createInventory, type Inventory } from '../inventory/index.js';
import { createNotifications } from '../notifications/index.js';
import {
  ACCOUNTANT,
  ADMIN,
  MANAGEMENT,
  NOBODY,
  PM,
  PROCUREMENT,
  STOREKEEPER,
  createProcurementKit,
  uid,
  type ProcurementKit,
} from './procurement-kit.js';
import { createTax, type Tax } from '../tax/index.js';
import { createValuation } from '../valuation/index.js';
import { createPayables, type Payables } from './index.js';
import type { BillInput } from './service/bills.service.js';
import type { PaymentInput } from './service/payments.service.js';
import type { Actor, BillDto, PaymentDto } from './types.js';

export { ACCOUNTANT, ADMIN, MANAGEMENT, NOBODY, PM, PROCUREMENT, STOREKEEPER, uid };

/** The date of every kit: the procurement kit's clock. */
export const TODAY = '2026-10-25';
export const FROM = '2026-01-01';
/** Synthetic rates, meaningful only in tests: sales tax 10% on goods, withholding 2% of the base. */
export const SALES_RATE = '10';
export const WITHHOLDING_RATE = '2';

export interface PayablesKit extends ProcurementKit {
  tax: Tax;
  cashbook: Cashbook;
  inventory: Inventory;
  payables: Payables;
  papp: FastifyInstance;
  /** The accountant: holds every payables, cash book and procurement permission. */
  pactor: Actor;
  islamabadId: string;
  /** A bank account of the cash book with money in it. */
  bank(opening?: string): Promise<string>;
  /** A warehouse store of the inventory module. */
  warehouse(): Promise<string>;
  /** An approved order for a project and its received goods; lines are quantity and rate. */
  receipt(input?: {
    projectId?: string | null;
    vendorId?: string;
    storeId?: string;
    lines?: { quantity: string; rate: string }[];
    receivedQty?: string[];
  }): Promise<{
    poId: string;
    grnId: string;
    vendorId: string;
    projectId: string | null;
    grnLineIds: string[];
    poLineIds: string[];
  }>;
  /** Bill input for received goods: every receipt line at the given quantity and rate. */
  billInput(
    received: Awaited<ReturnType<PayablesKit['receipt']>>,
    over?: Partial<BillInput> & { quantities?: string[]; rates?: string[] },
  ): BillInput;
  /** A bill created by the accountant, matched (no variance), submitted and approved by the owner. */
  approvedBill(input: BillInput, creator?: Actor): Promise<BillDto>;
  postedBill(input: BillInput): Promise<BillDto>;
  bill(id: string): Promise<BillDto>;
  payment(input: PaymentInput): Promise<PaymentDto>;
  /** Draft payment submitted and approved by the owner, ready to pay. */
  approvedPayment(input: PaymentInput): Promise<PaymentDto>;
  run<T>(
    fn: (tx: Parameters<Parameters<ProcurementKit['db']['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T>;
  /** Approves the rule (sales and withholding rules need the owner). */
  withholdingRule(over?: { ratePercent?: string; nature?: string }): Promise<void>;
  paidTotal(accountId: string): Promise<string>;
  /** Committed, approved and posted totals of a cost object (the cost ledger summary). */
  totals(object: {
    type: 'project' | 'overhead';
    id: string | null;
  }): Promise<{ committed: string; approved: string; posted: string }>;
  /** Sets a setting, reading its current version first. */
  put(key: string, value: string | boolean): Promise<void>;
  setThreshold(value: string): Promise<void>;
}

export async function createPayablesKit(): Promise<PayablesKit> {
  const late: { payables?: Payables } = {};
  const base = await createProcurementKit({
    isBilled: async (db, grnId) => (await late.payables?.isGrnBilled(db, grnId)) === true,
  });
  const { db, platform, identity, approvals, masterData, projects, procurement } = base;
  identity.registerPermissions('notifications', Object.values(notificationsPermissions));
  identity.registerPermissions('valuation', Object.values(valuationPermissions));
  identity.registerPermissions('inventory', Object.values(inventoryPermissions));
  identity.registerPermissions('tax', Object.values(taxPermissions));
  identity.registerPermissions('cashbook', Object.values(cashbookPermissions));
  identity.registerPermissions('payables', Object.values(payablesPermissions));
  const clock = { now: () => new Date(base.now.current) };
  let counter = 70_000;
  const newId = () => `018f7c7c-9999-7000-8000-${String(++counter).padStart(12, '0')}`;

  const tax = createTax({ platform, clock, newId, masterData, approvals });
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
  const valuation = createValuation({ platform, clock, newId, masterData, approvals });
  const inventory = createInventory({
    platform,
    clock,
    newId,
    valuation,
    projects,
    masterData,
    approvals,
    notifications,
  });
  const payables = createPayables({
    platform,
    clock,
    newId,
    procurement,
    inventory,
    projects,
    tax,
    cashbook,
    approvals,
    masterData,
  });
  late.payables = payables;

  const admin = { userId: ADMIN, requestId: null };
  const islamabad = await db.transaction((tx) =>
    masterData.company.createLocation(
      { name: 'Site Islamabad', region: 'islamabad', city: 'Islamabad' },
      admin,
      tx,
    ),
  );
  await db.transaction((tx) =>
    masterData.company.createRegistration(
      {
        authority: 'FBR',
        registrationType: 'strn',
        number: 'TEST-FBR-0001',
        validFrom: '2020-01-01',
      },
      admin,
      tx,
    ),
  );
  const accountant = { userId: ACCOUNTANT, requestId: null };
  const approveRule = async (request: () => Promise<{ id: string }>) => {
    const rule = await request();
    await base.decide('tax_rule', rule.id, 'approve');
  };
  for (const supplyKind of ['goods', 'services'] as const) {
    await approveRule(() =>
      db.transaction((tx) =>
        tax.rules.requestRegionEntry(
          { region: 'islamabad', supplyKind, authorityCode: 'FBR', effectiveFrom: FROM },
          accountant,
          tx,
        ),
      ),
    );
    await approveRule(() =>
      db.transaction((tx) =>
        tax.rules.requestSalesRule(
          {
            authorityCode: 'FBR',
            supplyKind,
            ratePercent: SALES_RATE,
            taxCode: `TEST-${supplyKind}`,
            effectiveFrom: FROM,
          },
          accountant,
          tx,
        ),
      ),
    );
  }

  const permissions = new Set<string>([
    ...Object.values(payablesPermissions),
    ...Object.values(cashbookPermissions),
    ...Object.values(inventoryPermissions),
  ]);
  const pactor: Actor = {
    userId: ACCOUNTANT,
    roles: ['accountant'],
    scopes: [],
    permissions,
    requestId: null,
  };

  const papp = await buildApp({
    config: { corsOrigins: [] },
    logger: createLogger('silent'),
    clock: () => base.now.current,
    identity: { db, identity },
    payables: { db, payables, platform },
  });
  await papp.ready();

  let accountSeq = 0;
  let storeSeq = 0;
  let invoiceSeq = 0;
  const tx = <T>(fn: Parameters<typeof db.transaction<T>>[0]) => db.transaction(fn);
  const kit: PayablesKit = {
    ...base,
    tax,
    cashbook,
    inventory,
    payables,
    papp,
    pactor,
    islamabadId: islamabad.id,
    run: tx,

    async bank(opening = '10000000') {
      const account = await tx((t) =>
        cashbook.accounts.create(
          {
            code: `PAY-BANK-${++accountSeq}`,
            name: `Payables bank ${accountSeq}`,
            kind: 'bank',
            openingBalance: opening,
            openingDate: '2026-01-01',
          },
          pactor,
          t,
        ),
      );
      return account.id;
    },

    async warehouse() {
      storeSeq += 1;
      const store = await tx((t) =>
        inventory.service.stores.create(
          {
            code: `PAY-ST-${storeSeq}`,
            name: `Store ${storeSeq}`,
            kind: 'warehouse',
            projectId: null,
          },
          { ...kit.actorFor(STOREKEEPER), permissions },
          t,
        ),
      );
      return store.id;
    },

    async receipt(input = {}) {
      const projectId = input.projectId === undefined ? (await kit.project()).id : input.projectId;
      const lines = input.lines ?? [{ quantity: '100', rate: '50' }];
      const vendorId = input.vendorId ?? (await kit.vendor());
      const storeId = projectId === null ? (input.storeId ?? (await kit.warehouse())) : undefined;
      const items = await Promise.all(lines.map(() => kit.item()));
      const poId = await kit.approvedPo(projectId, {
        vendorId,
        ...(projectId === null ? { storeId } : { projectId }),
        lines: lines.map((l, i) => ({
          itemId: items[i] as string,
          quantity: l.quantity,
          rate: l.rate,
          costCodeId: kit.codes['100'] as string,
        })),
      });
      const quantities = Object.fromEntries(
        lines.map((l, i) => [i + 1, input.receivedQty?.[i] ?? l.quantity]),
      );
      const grnId = await kit.receive(poId, quantities, { receivedOn: TODAY });
      await platform.events.dispatchDue(db);
      const po = await procurement.getPurchaseOrder(db, poId);
      const grn = await procurement.getGrn(db, grnId);
      return {
        poId,
        grnId,
        vendorId,
        projectId,
        poLineIds: po.lines.map((l) => l.id),
        grnLineIds: grn.lines.map((l) => l.id),
      };
    },

    billInput(received, over = {}) {
      const { quantities, rates, ...rest } = over;
      return {
        vendorPartyId: received.vendorId,
        vendorInvoiceNo: `VINV-${++invoiceSeq}`,
        billDate: TODAY,
        dueDate: '2026-11-25',
        sourceType: 'purchase',
        locationId: islamabad.id,
        lines: received.grnLineIds.map((grnLineId, i) => ({
          grnId: received.grnId,
          grnLineId,
          quantity: quantities?.[i] ?? '100',
          rate: rates?.[i] ?? '50',
        })),
        ...rest,
      };
    },

    async approvedBill(input, creator = pactor) {
      const created = await tx((t) => payables.bills.create(input, creator, t));
      const matched = await tx((t) =>
        payables.bills.match(
          created.id,
          { version: created.version, overrideReason: 'Accepted in tests' },
          creator,
          t,
        ),
      );
      const submitted = await tx((t) =>
        payables.bills.submit(created.id, matched.version, creator, t),
      );
      await kit.decide('vendor_bill', submitted.id, 'approve');
      return payables.bills.get(db, created.id);
    },

    async postedBill(input) {
      const approved = await kit.approvedBill(input);
      return tx((t) => payables.bills.post(approved.id, approved.version, pactor, t));
    },

    bill: (id) => payables.bills.get(db, id),

    payment: (input) => tx((t) => payables.payments.create(input, pactor, t)),

    async approvedPayment(input) {
      const draft = await kit.payment(input);
      const submitted = await tx((t) =>
        payables.payments.submit(draft.id, draft.version, pactor, t),
      );
      if (submitted.status === 'pending_approval') {
        await kit.decide('payment', submitted.approvalDocId as string, 'approve');
      }
      return payables.payments.get(db, draft.id);
    },

    async withholdingRule(over = {}) {
      await approveRule(() =>
        tx((t) =>
          tax.rules.requestWithholdingRule(
            {
              authorityCode: 'FBR',
              direction: 'we_withhold',
              partyType: 'vendor',
              nature: over.nature ?? 'works',
              ratePercent: over.ratePercent ?? WITHHOLDING_RATE,
              base: 'on_base',
              effectiveFrom: FROM,
            },
            accountant,
            t,
          ),
        ),
      );
    },

    async totals(object) {
      return (await projects.costing.getCostSummary(db, object)).totals;
    },

    async put(key, value) {
      const current = await db.query<{ version: number }>(
        'select version from sys_settings where key = $1',
        [key],
      );
      await base.setting(key, value, current[0]?.version ?? 0);
    },

    async paidTotal(accountId) {
      return cashbook.getAccountBalance(db, accountId, TODAY);
    },

    async setThreshold(value) {
      await kit.put('cashbook.payment_approval_threshold', value);
    },

    async close() {
      await papp.close();
      await base.close();
    },
  };
  void PM;
  void PROCUREMENT;
  void NOBODY;
  void MANAGEMENT;
  return kit;
}

import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  cashAccountKinds,
  cashDirections,
  cashMethods,
  cashbookPermissions as perm,
  pendingSourceStatuses,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Cashbook } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface CashbookRouteDeps {
  db: Db;
  cashbook: Cashbook;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const versionBody = z.object({ version });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const signedMoney = z.string().regex(/^-?\d{1,14}(\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const accountFields = {
  name: z.string().min(1).max(200),
  bankName: text(200).optional(),
  accountNumberMasked: text(40).optional(),
  accountCodeTag: text(40).optional(),
  allowOverdraft: z.boolean().optional(),
};
const createAccountBody = z.object({
  code: z.string().min(1).max(40),
  kind: z.enum(cashAccountKinds),
  openingBalance: signedMoney,
  openingDate: date,
  ...accountFields,
});
const updateAccountBody = z.object({ ...accountFields, active: z.boolean().optional(), version });

const sourceFields = {
  accountId: z.uuid(),
  txnDate: date,
  amount: money,
  method: z.enum(cashMethods),
  counterpartyPartyId: z.uuid().optional(),
  sourceModule: text(60).optional(),
  sourceDocType: text(60).optional(),
  sourceDocId: z.uuid().optional(),
  reference: text(200).optional(),
  description: text(1000).optional(),
  accountTag: text(40).optional(),
};
const receiptBody = z.object(sourceFields);
const paymentBody = z.object({
  ...sourceFields,
  txnType: z.enum(['payment', 'bank_charge']).optional(),
  approvalDocId: z.uuid().optional(),
});
const transferBody = z.object({
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  txnDate: date,
  amount: money,
  method: z.enum(cashMethods).optional(),
  reference: text(200).optional(),
  description: text(1000).optional(),
});
const adjustmentBody = z.object({
  accountId: z.uuid(),
  txnDate: date,
  direction: z.enum(cashDirections),
  amount: money,
  reason: z.string().min(1).max(1000),
  approvalDocId: z.uuid().optional(),
});
const approvalRequestBody = z.object({
  docType: z.enum(['payment', 'cash_adjustment']),
  amount: money,
  accountId: z.uuid().optional(),
  note: text(1000).optional(),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The cash book endpoints (spec P2-03 section 5). */
export function registerCashbookRoutes(app: FastifyInstance, deps: CashbookRouteDeps): void {
  const { db, cashbook, platform } = deps;

  const actorOf = (request: FastifyRequest): Actor => {
    const user = currentUser(request);
    return {
      userId: user.userId,
      roles: user.roles,
      scopes: user.scopes,
      permissions: user.permissions,
      requestId: request.id,
    };
  };

  /** One transaction per command; with an Idempotency-Key header a retry replays the first response. */
  const command = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (tx: Db) => Promise<CommandResult>,
  ) => {
    const key = request.headers['idempotency-key'];
    if (Array.isArray(key) || key === '') {
      throw new ValidationError(
        'invalid_idempotency_key',
        'Idempotency-Key must be a single value',
      );
    }
    const result =
      key === undefined
        ? await db.transaction(run)
        : await platform.idempotency.execute(
            db,
            {
              key,
              userId: currentUser(request).userId,
              requestHash: hashRequest(request.method, request.url, request.body),
            },
            run,
          );
    return reply.status(result.statusCode).send(result.body);
  };

  const created = (body: unknown): CommandResult => ({ statusCode: 201, body });
  const ok = (body: unknown): CommandResult => ({ statusCode: 200, body });

  /* ---------------------------------------------------------------- accounts */

  app.get('/cashbook/accounts', { preHandler: requirePermission(perm.txnRead) }, (request) =>
    cashbook.accounts.list(
      db,
      z.object({ includeInactive: z.stringbool().default(false) }).parse(request.query)
        .includeInactive,
    ),
  );

  app.post(
    '/cashbook/accounts',
    { preHandler: requirePermission(perm.accountManage) },
    (request, reply) => {
      const input = createAccountBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.accounts.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/cashbook/accounts/:id', { preHandler: requirePermission(perm.txnRead) }, (request) =>
    cashbook.accounts.get(db, idParams.parse(request.params).id),
  );

  app.put(
    '/cashbook/accounts/:id',
    { preHandler: requirePermission(perm.accountManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = updateAccountBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.accounts.update(id, input, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/cashbook/accounts/:id',
    { preHandler: requirePermission(perm.accountManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await cashbook.accounts.remove(id, expected, actorOf(request), tx);
        return ok({ id });
      });
    },
  );

  app.get(
    '/cashbook/accounts/:id/balance',
    { preHandler: requirePermission(perm.txnRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { date: on } = z.object({ date }).parse(request.query);
      return { accountId: id, date: on, balance: await cashbook.getAccountBalance(db, id, on) };
    },
  );

  /* ------------------------------------------------------------ transactions */

  app.post(
    '/cashbook/receipts',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const input = receiptBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.recordReceipt(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/payments',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const input = paymentBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.recordPayment(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/transfers',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const input = transferBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.recordTransfer(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/adjustments',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const input = adjustmentBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.transactions.recordAdjustment(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/approval-requests',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const input = approvalRequestBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.transactions.requestApproval(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/cashbook/transactions', { preHandler: requirePermission(perm.txnRead) }, (request) => {
    const query = z
      .object({
        accountId: z.uuid().optional(),
        from: date.optional(),
        to: date.optional(),
        needsTag: z.stringbool().optional(),
        ...pageFields,
      })
      .parse(request.query);
    return cashbook.transactions.list(db, query);
  });

  app.get(
    '/cashbook/transactions/:id',
    { preHandler: requirePermission(perm.txnRead) },
    (request) => cashbook.transactions.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/cashbook/transactions/:id/reverse',
    { preHandler: requirePermission(perm.txnReverse) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ reason: z.string().min(1).max(1000), txnDate: date.optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.transactions.reverse(id, input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/cashbook/transactions/:id/tag',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { accountTag } = z.object({ accountTag: text(40).nullable() }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.transactions.setTag(id, accountTag, actorOf(request), tx)),
      );
    },
  );

  app.get('/cashbook/position', { preHandler: requirePermission(perm.txnRead) }, (request) =>
    cashbook.getCashPosition(db, z.object({ date }).parse(request.query).date),
  );

  /* ---------------------------------------------------------- pending sources */

  app.get('/cashbook/pending', { preHandler: requirePermission(perm.txnRead) }, (request) =>
    cashbook.sources.list(
      db,
      z.object({ status: z.enum(pendingSourceStatuses).optional() }).parse(request.query).status,
    ),
  );

  app.post(
    '/cashbook/pending/:id/record',
    { preHandler: requirePermission(perm.txnCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { accountId } = z.object({ accountId: z.uuid() }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.sources.record(id, accountId, actorOf(request), tx)),
      );
    },
  );

  /* ---------------------------------------------------------- reconciliation */

  app.get('/cashbook/reconciliations', { preHandler: requirePermission(perm.txnRead) }, (request) =>
    cashbook.reconciliation.list(
      db,
      z.object({ accountId: z.uuid().optional() }).parse(request.query).accountId,
    ),
  );

  app.post(
    '/cashbook/reconciliations',
    { preHandler: requirePermission(perm.reconcile) },
    (request, reply) => {
      const input = z
        .object({
          accountId: z.uuid(),
          statementFrom: date,
          statementTo: date,
          statementClosingBalance: signedMoney,
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await cashbook.reconciliation.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/cashbook/reconciliations/:id',
    { preHandler: requirePermission(perm.txnRead) },
    (request) => cashbook.reconciliation.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/cashbook/reconciliations/:id/import',
    { preHandler: requirePermission(perm.reconcile) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { csv } = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.reconciliation.importStatement(id, csv, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/reconciliations/:id/match',
    { preHandler: requirePermission(perm.reconcile) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { matches } = z
        .object({
          matches: z
            .array(z.object({ lineId: z.uuid(), transactionId: z.uuid().nullable() }))
            .min(1)
            .max(500),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.reconciliation.match(id, matches, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/reconciliations/:id/complete',
    { preHandler: requirePermission(perm.reconcile) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await cashbook.reconciliation.complete(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/cashbook/reconciliations/:id/reopen',
    { preHandler: requirePermission(perm.reconcile) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      return command(request, reply, async (tx) =>
        ok(await cashbook.reconciliation.reopen(id, actorOf(request), tx)),
      );
    },
  );
}

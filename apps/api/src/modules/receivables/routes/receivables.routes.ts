import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  allocationKinds,
  followupStatuses,
  pdcStatuses,
  receiptMethods,
  receivablesPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Receivables } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ReceivablesRouteDeps {
  db: Db;
  receivables: Receivables;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max);

const allocationBody = z.object({
  kind: z.enum(allocationKinds),
  invoiceId: z.uuid(),
  advanceId: z.uuid().optional(),
  amount: money,
});
const chequeBody = z.object({
  chequeNumber: z.string().min(1).max(60),
  bankName: z.string().min(1).max(120),
  drawer: text(200).optional(),
  chequeDate: date,
});
const receiptBody = z.object({
  partyId: z.uuid(),
  receiptDate: date,
  method: z.enum(receiptMethods),
  amount: money,
  accountId: z.uuid().optional(),
  reference: text(200).optional(),
  withheldAmount: money.optional(),
  withholdingCertificateRef: text(120).optional(),
  cheque: chequeBody.optional(),
  allocations: z.array(allocationBody).max(200).optional(),
});
const followupFields = {
  dueDate: date,
  note: z.string().min(1).max(1000),
  assignedTo: z.uuid().optional(),
};

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The receivables endpoints (spec P2-04 section 5). */
export function registerReceivablesRoutes(app: FastifyInstance, deps: ReceivablesRouteDeps): void {
  const { db, receivables, platform } = deps;
  const { receipts, pdcs, ledger, collections } = receivables;

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

  /* ----------------------------------------------------------------- receipts */

  app.post(
    '/receivables/receipts',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request, reply) => {
      const input = receiptBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await receipts.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/receivables/receipts', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    receipts.list(
      db,
      z
        .object({
          partyId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query),
    ),
  );

  app.get(
    '/receivables/receipts/:id',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) => receipts.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/receivables/receipts/:id/allocate',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { allocations } = z
        .object({ allocations: z.array(allocationBody).min(1).max(200) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await receipts.allocate(id, allocations, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/receipts/:id/cancel',
    { preHandler: requirePermission(perm.receiptCancel) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ reason: z.string().min(1).max(1000), cancelledOn: date.optional(), version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await receipts.cancel(id, input, actorOf(request), tx)),
      );
    },
  );

  /* ---------------------------------------------------------------- customers */

  app.get(
    '/receivables/customers/:id/ledger',
    { preHandler: requirePermission(perm.ledgerRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { date: asOf } = z.object({ date: date.optional() }).parse(request.query);
      return {
        ...(await ledger.overview(db, id, asOf)),
        receipts: await receipts.list(db, { partyId: id, limit: 50, offset: 0 }),
      };
    },
  );

  app.get(
    '/receivables/customers/:id/statement',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) => {
      const { id } = idParams.parse(request.params);
      const { from, to } = z.object({ from: date, to: date }).parse(request.query);
      return ledger.statement(db, id, from, to);
    },
  );

  app.get(
    '/receivables/customers/:id/open-invoices',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) => ledger.getOpenInvoices(db, idParams.parse(request.params).id),
  );

  app.get(
    '/receivables/customers/:id/suggest-allocation',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request) => {
      const { id } = idParams.parse(request.params);
      const { amount } = z.object({ amount: money }).parse(request.query);
      return ledger.suggest(db, id, amount);
    },
  );

  app.get('/receivables/aging', { preHandler: requirePermission(perm.ledgerRead) }, (request) => {
    const query = z
      .object({
        asOf: date,
        groupBy: z.enum(['customer', 'project']).default('customer'),
      })
      .parse(request.query);
    return ledger.aging(db, query.asOf, query.groupBy);
  });

  /* -------------------------------------------------------------------- pdcs */

  app.get('/receivables/pdcs', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    pdcs.register(
      db,
      z
        .object({
          status: z.enum(pdcStatuses).optional(),
          from: date.optional(),
          to: date.optional(),
        })
        .parse(request.query),
    ),
  );

  app.get('/receivables/pdcs/:id', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    pdcs.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/receivables/pdcs/:id/deposit',
    { preHandler: requirePermission(perm.pdcManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({
          accountId: z.uuid(),
          depositedOn: date.optional(),
          overrideReason: text(1000).optional(),
          version,
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await pdcs.deposit(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/pdcs/:id/clear',
    { preHandler: requirePermission(perm.pdcManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ clearedOn: date.optional(), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await pdcs.clear(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/pdcs/:id/bounce',
    { preHandler: requirePermission(perm.pdcManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ reason: z.string().min(1).max(1000), bouncedOn: date.optional(), version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await pdcs.bounce(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/pdcs/:id/return',
    { preHandler: requirePermission(perm.pdcManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ reason: text(1000).optional(), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await pdcs.giveBack(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/pdcs/:id/replace',
    { preHandler: requirePermission(perm.pdcManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ cheque: chequeBody, version }).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await pdcs.replace(id, input, actorOf(request), tx)),
      );
    },
  );

  /* --------------------------------------------------------------- follow-ups */

  app.get('/receivables/followups', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    collections.listFollowups(
      db,
      z
        .object({ partyId: z.uuid().optional(), status: z.enum(followupStatuses).optional() })
        .parse(request.query),
    ),
  );

  app.post(
    '/receivables/followups',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request, reply) => {
      const input = z
        .object({ partyId: z.uuid(), invoiceId: z.uuid().optional(), ...followupFields })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await collections.createFollowup(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/receivables/followups/:id',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({
          dueDate: followupFields.dueDate.optional(),
          note: followupFields.note.optional(),
          assignedTo: followupFields.assignedTo,
          status: z.enum(followupStatuses).optional(),
          version,
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await collections.updateFollowup(id, input, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/receivables/followups/:id',
    { preHandler: requirePermission(perm.receiptCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await collections.deleteFollowup(id, expected, actorOf(request), tx);
        return ok({ id });
      });
    },
  );

  /* -------------------------------------------------------------- adjustments */

  app.get(
    '/receivables/adjustments',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) =>
      collections.listAdjustments(db, z.object({ partyId: z.uuid() }).parse(request.query).partyId),
  );

  app.post(
    '/receivables/adjustments/approval-requests',
    { preHandler: requirePermission(perm.adjustmentCreate) },
    (request, reply) => {
      const input = z
        .object({ invoiceId: z.uuid(), amount: money, note: text(1000).optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await collections.requestWriteOffApproval(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/receivables/adjustments',
    { preHandler: requirePermission(perm.adjustmentCreate) },
    (request, reply) => {
      const input = z
        .object({
          invoiceId: z.uuid(),
          amount: money,
          reason: z.string().min(1).max(1000),
          approvalDocId: z.uuid().optional(),
          adjustmentDate: date.optional(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await collections.createAdjustment(input, actorOf(request), tx)),
      );
    },
  );
}

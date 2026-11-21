import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  billSourceTypes,
  billStatuses,
  paymentMethods,
  paymentStatuses,
  payablesPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Payables } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface PayablesRouteDeps {
  db: Db;
  payables: Payables;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const quantity = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const text = (max: number) => z.string().max(max);
const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const billLine = z.object({
  grnId: z.uuid().optional(),
  grnLineId: z.uuid().optional(),
  description: text(500).optional(),
  quantity,
  rate: quantity,
  costObjectType: z.enum(['project', 'work_order', 'overhead']).optional(),
  costObjectId: z.uuid().optional(),
  costCodeId: z.uuid().optional(),
});
const billBody = z.object({
  vendorPartyId: z.uuid(),
  vendorInvoiceNo: z.string().min(1).max(100),
  billDate: date,
  dueDate: date,
  sourceType: z.enum(billSourceTypes.filter((t) => t !== 'opening') as ['purchase']),
  supplyKind: z.enum(['goods', 'services']).optional(),
  nature: text(100).optional(),
  locationId: z.uuid().optional(),
  notes: text(1000).optional(),
  lines: z.array(billLine).min(1).max(200),
});
const paymentBody = z.object({
  vendorPartyId: z.uuid(),
  paymentDate: date,
  method: z.enum(paymentMethods),
  accountId: z.uuid(),
  chequeNumber: text(60).optional(),
  chequeDate: date.optional(),
  reference: text(200).optional(),
  withholdingCertificateNo: text(120).optional(),
  amount: money.optional(),
  allocations: z
    .array(z.object({ billId: z.uuid(), amount: money }))
    .min(1)
    .max(200),
});
const runBody = z.object({
  billIds: z.array(z.uuid()).min(1).max(200),
  paymentDate: date,
  method: z.enum(paymentMethods),
  accountId: z.uuid(),
  chequeNumbers: z.array(text(60)).max(200).optional(),
  chequeDate: date.optional(),
  note: text(500).optional(),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The payables endpoints (spec P2-05 section 5). */
export function registerPayablesRoutes(app: FastifyInstance, deps: PayablesRouteDeps): void {
  const { db, payables, platform } = deps;
  const { bills, payments, ledger } = payables;

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

  /* --------------------------------------------------------------------- bills */

  app.get('/payables/bills', { preHandler: requirePermission(perm.billRead) }, (request) =>
    bills.list(
      db,
      z
        .object({
          vendorPartyId: z.uuid().optional(),
          status: z.enum(billStatuses).optional(),
          ...paging,
        })
        .parse(request.query),
    ),
  );

  app.post(
    '/payables/bills',
    { preHandler: requirePermission(perm.billCreate) },
    (request, reply) => {
      const input = billBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await bills.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/payables/bills/:id', { preHandler: requirePermission(perm.billRead) }, (request) =>
    bills.get(db, idParams.parse(request.params).id),
  );

  app.put(
    '/payables/bills/:id',
    { preHandler: requirePermission(perm.billCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = billBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await bills.update(id, expected, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/bills/:id/match',
    { preHandler: requirePermission(perm.billCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ version, overrideReason: text(1000).optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await bills.match(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/bills/:id/submit',
    { preHandler: requirePermission(perm.billCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await bills.submit(id, body.version, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/bills/:id/post',
    { preHandler: requirePermission(perm.billPost) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await bills.post(id, body.version, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/bills/:id/cancel',
    { preHandler: requirePermission(perm.billPost) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ reason: z.string().min(1).max(1000), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await bills.cancel(id, input, actorOf(request), tx)),
      );
    },
  );

  /* ------------------------------------------------------------------ payments */

  app.get('/payables/payments', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    payments.list(
      db,
      z
        .object({
          vendorPartyId: z.uuid().optional(),
          status: z.enum(paymentStatuses).optional(),
          ...paging,
        })
        .parse(request.query),
    ),
  );

  app.post(
    '/payables/payments',
    { preHandler: requirePermission(perm.paymentCreate) },
    (request, reply) => {
      const input = paymentBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await payments.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/payables/payments/:id', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    payments.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/payables/payments/:id/submit',
    { preHandler: requirePermission(perm.paymentCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await payments.submit(id, body.version, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/payments/:id/pay',
    { preHandler: requirePermission(perm.paymentPay) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await payments.pay(id, body.version, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/payments/:id/cancel',
    { preHandler: requirePermission(perm.paymentPay) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ reason: z.string().min(1).max(1000), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await payments.cancel(id, input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/payables/payments/:id/certificate',
    { preHandler: requirePermission(perm.paymentPay) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ certificateNo: z.string().min(1).max(120), version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await payments.setCertificate(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payables/payment-runs',
    { preHandler: requirePermission(perm.paymentCreate) },
    (request, reply) => {
      const input = runBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await payments.createRun(input, actorOf(request), tx)),
      );
    },
  );

  /* ------------------------------------------------------------ vendors, reports */

  app.get(
    '/payables/vendors/:id/ledger',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) => {
      const { id } = idParams.parse(request.params);
      const { date: asOf } = z.object({ date: date.optional() }).parse(request.query);
      return ledger.overview(db, id, asOf);
    },
  );

  app.get(
    '/payables/vendors/:id/open-bills',
    { preHandler: requirePermission(perm.billRead) },
    (request) => ledger.getOpenBills(db, idParams.parse(request.params).id),
  );

  app.get('/payables/aging', { preHandler: requirePermission(perm.ledgerRead) }, (request) =>
    ledger.aging(db, z.object({ asOf: date.optional() }).parse(request.query).asOf),
  );

  app.get(
    '/payables/withholding-report',
    { preHandler: requirePermission(perm.ledgerRead) },
    (request) =>
      ledger.withholdingReport(
        db,
        z.object({ month, authorityCode: text(20).optional() }).parse(request.query),
      ),
  );
}

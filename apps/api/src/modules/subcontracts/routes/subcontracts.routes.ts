import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  certificateBases,
  subcontractsPermissions as perm,
  workOrderStatuses,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Subcontracts } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface SubcontractsRouteDeps {
  db: Db;
  subcontracts: Subcontracts;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const money = z.string().regex(/^-?\d{1,14}(\.\d{1,2})?$/);
const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const orderFields = {
  projectId: z.uuid(),
  partyId: z.uuid(),
  title: z.string().min(1).max(500),
  scopeText: z.string().max(5000).optional(),
  contractAmount: money,
  costCodeId: z.uuid(),
  startDate: date.optional(),
  endDate: date.optional(),
  // BR-8: accepted by the schema so that the rule, not a type error, explains the refusal.
  retentionPercent: z.string().max(20).optional(),
};
const createOrderBody = z.object(orderFields);
const updateOrderBody = z.object({ ...orderFields, version });

const variationFields = { amount: money, reason: z.string().min(1).max(1000) };

const certificateFields = {
  certificateDate: date,
  basis: z.enum(certificateBases),
  cumulativePercent: percent.optional(),
  cumulativeAmount: money.optional(),
  notes: z.string().max(2000).optional(),
};

const chargeFields = {
  description: z.string().min(1).max(500),
  amount: money,
  recoversCost: z.boolean().optional(),
  costCodeId: z.uuid().optional(),
  certificateId: z.uuid().nullable().optional(),
};

const billBody = z.object({
  vendorInvoiceNo: z.string().min(1).max(100),
  billDate: date,
  dueDate: date,
  notes: z.string().max(2000).optional(),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The subcontracts endpoints (spec P2-06 section 5). */
export function registerSubcontractsRoutes(
  app: FastifyInstance,
  deps: SubcontractsRouteDeps,
): void {
  const { db, subcontracts, platform } = deps;
  const { orders, certificates, ledger } = subcontracts;

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
  const noContent: CommandResult = { statusCode: 204, body: null };
  const versionBody = z.object({ version });

  /* ----------------------------------------------------------------- work orders */

  app.get(
    '/subcontracts/work-orders',
    { preHandler: requirePermission(perm.orderRead) },
    (request) =>
      orders.list(
        db,
        z
          .object({
            projectId: z.uuid().optional(),
            partyId: z.uuid().optional(),
            status: z.enum(workOrderStatuses).optional(),
            ...pageFields,
          })
          .parse(request.query),
        actorOf(request),
      ),
  );

  app.post(
    '/subcontracts/work-orders',
    { preHandler: requirePermission(perm.orderCreate) },
    (request, reply) => {
      const input = createOrderBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await orders.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/subcontracts/work-orders/:id',
    { preHandler: requirePermission(perm.orderRead) },
    (request) => orders.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/subcontracts/work-orders/:id',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = updateOrderBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/subcontracts/work-orders/:id',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await orders.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/subcontracts/work-orders/:id/submit',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.submit(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/subcontracts/work-orders/:id/close',
    { preHandler: requirePermission(perm.orderClose) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ version, reason: z.string().max(1000).optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.close(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/subcontracts/work-orders/:id/cancel',
    { preHandler: requirePermission(perm.orderClose) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.cancel(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/subcontracts/work-orders/:id/ledger',
    { preHandler: requirePermission(perm.amountRead) },
    (request) => ledger.workOrderLedger(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.get(
    '/subcontracts/subcontractors/:id/statement',
    { preHandler: requirePermission(perm.amountRead) },
    (request) => ledger.statement(db, idParams.parse(request.params).id, actorOf(request)),
  );

  /* ------------------------------------------------------------------ variations */

  app.post(
    '/subcontracts/work-orders/:id/variations',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object(variationFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await orders.addVariation(id, input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/subcontracts/variations/:id',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ ...variationFields, version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.updateVariation(id, input, actorOf(request), tx)),
      );
    },
  );

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(
      `/subcontracts/variations/:id/${path}`,
      { preHandler: requirePermission(perm.variationApprove) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const input = z
          .object({ version, note: z.string().max(1000).optional() })
          .parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await orders.decideVariation(id, { decision, ...input }, actorOf(request), tx)),
        );
      },
    );
  }

  /* ---------------------------------------------------------------- certificates */

  app.get(
    '/subcontracts/work-orders/:id/certificates',
    { preHandler: requirePermission(perm.orderRead) },
    (request) => certificates.list(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/subcontracts/work-orders/:id/certificates',
    { preHandler: requirePermission(perm.certificateCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object(certificateFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await certificates.create(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/subcontracts/certificates/:id',
    { preHandler: requirePermission(perm.orderRead) },
    (request) => certificates.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/subcontracts/certificates/:id',
    { preHandler: requirePermission(perm.certificateCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ ...certificateFields, version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await certificates.update(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/subcontracts/certificates/:id/submit',
    { preHandler: requirePermission(perm.certificateSubmit) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await certificates.submit(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/subcontracts/certificates/:id/cancel',
    { preHandler: requirePermission(perm.certificateCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await certificates.cancel(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/subcontracts/certificates/:id/bill',
    { preHandler: requirePermission(perm.certificateBill) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = billBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await certificates.bill(id, input, actorOf(request), tx)),
      );
    },
  );

  /* ---------------------------------------------------------------- back-charges */

  app.get(
    '/subcontracts/work-orders/:id/back-charges',
    { preHandler: requirePermission(perm.orderRead) },
    (request) =>
      certificates.listBackCharges(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/subcontracts/work-orders/:id/back-charges',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object(chargeFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await certificates.addBackCharge(id, input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/subcontracts/back-charges/:id',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z.object({ ...chargeFields, version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await certificates.updateBackCharge(id, input, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/subcontracts/back-charges/:id',
    { preHandler: requirePermission(perm.orderUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await certificates.removeBackCharge(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );
}

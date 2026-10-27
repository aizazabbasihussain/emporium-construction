import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  grnStatuses,
  procurementPermissions as perm,
  purchaseOrderStatuses,
  requisitionStatuses,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Procurement } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ProcurementRouteDeps {
  db: Db;
  procurement: Procurement;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().min(1).max(40);
const text = z.string().max(2000);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const requisitionLine = z.object({
  itemId: z.uuid(),
  description: z.string().max(500).optional(),
  quantity: decimal,
  unitCode: z.string().min(1).max(20).optional(),
  costCodeId: z.uuid(),
  estimatedRate: decimal.nullable().optional(),
});

const requisitionFields = {
  projectId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  requiredBy: date.optional(),
  note: text.optional(),
  lines: z.array(requisitionLine).min(1).max(200),
};

const poLine = z.object({
  lineId: z.uuid().optional(),
  itemId: z.uuid(),
  description: z.string().max(500).optional(),
  quantity: decimal,
  unitCode: z.string().min(1).max(20).optional(),
  rate: decimal,
  costCodeId: z.uuid(),
});

const poFields = {
  vendorId: z.uuid(),
  projectId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  orderDate: date,
  expectedDate: date.optional(),
  terms: text.optional(),
  lines: z.array(poLine).min(1).max(200),
};

const quoteLine = z.object({ requisitionLineId: z.uuid(), rate: decimal });

const quoteFields = {
  validUntil: date.optional(),
  deliveryDays: z.number().int().min(0).max(3650).optional(),
  terms: text.optional(),
  lines: z.array(quoteLine).min(1).max(200),
};

const receiptLine = z.object({
  poLineId: z.uuid(),
  acceptedQty: decimal,
  rejectedQty: decimal.optional(),
  note: z.string().max(500).optional(),
});

const photo = z.object({
  fileName: z.string().min(1).max(200),
  contentBase64: z.string().min(1).max(15_000_000),
});

/** A challan photo is up to 10 MB; in base64 it is a third larger. */
const RECEIPT_BODY_LIMIT = 16 * 1024 * 1024;

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The procurement endpoints (spec P1-11 section 5). */
export function registerProcurementRoutes(app: FastifyInstance, deps: ProcurementRouteDeps): void {
  const { db, procurement, platform } = deps;
  const { requisitions, rfqs, orders, receipts } = procurement.service;

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
  const versionBody = z.object({ version });

  /* -------------------------------------------------------- requisitions */

  app.get(
    '/procurement/requisitions',
    { preHandler: requirePermission(perm.requisitionRead) },
    (request) =>
      requisitions.list(
        db,
        z
          .object({
            status: z.enum(requisitionStatuses).optional(),
            projectId: z.uuid().optional(),
            storeId: z.uuid().optional(),
            ...pageFields,
          })
          .parse(request.query),
        actorOf(request),
      ),
  );

  app.get(
    '/procurement/requisitions/:id',
    { preHandler: requirePermission(perm.requisitionRead) },
    (request) => requisitions.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/procurement/requisitions',
    { preHandler: requirePermission(perm.requisitionCreate) },
    (request, reply) => {
      const input = z.object(requisitionFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await requisitions.create(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/procurement/requisitions/:id',
    { preHandler: requirePermission(perm.requisitionCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ ...requisitionFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await requisitions.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  for (const action of ['submit', 'cancel'] as const) {
    app.post(
      `/procurement/requisitions/:id/${action}`,
      { preHandler: requirePermission(perm.requisitionCreate) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const { version: expected } = versionBody.parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await requisitions[action](id, expected, actorOf(request), tx)),
        );
      },
    );
  }

  /* ---------------------------------------------------------------- RFQs */

  app.get('/procurement/rfqs', { preHandler: requirePermission(perm.rfqManage) }, (request) =>
    rfqs.list(
      db,
      z.object({ requisitionId: z.uuid().optional(), ...pageFields }).parse(request.query),
      actorOf(request),
    ),
  );

  app.get('/procurement/rfqs/:id', { preHandler: requirePermission(perm.rfqManage) }, (request) =>
    rfqs.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/procurement/rfqs',
    { preHandler: requirePermission(perm.rfqManage) },
    (request, reply) => {
      const input = z
        .object({ requisitionId: z.uuid(), vendorIds: z.array(z.uuid()).min(1).max(50) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await rfqs.create(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/procurement/rfqs/:id/close',
    { preHandler: requirePermission(perm.rfqManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await rfqs.close(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/procurement/rfqs/:id/select-vendor',
    { preHandler: requirePermission(perm.rfqManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({
          requisitionLineId: z.uuid(),
          quoteId: z.uuid(),
          reason: z.string().max(1000).optional(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await rfqs.selectVendor(id, input, actorOf(request), tx)),
      );
    },
  );

  /* -------------------------------------------------------------- quotes */

  app.get('/procurement/quotes/:id', { preHandler: requirePermission(perm.rfqManage) }, (request) =>
    rfqs.getQuote(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/procurement/quotes',
    { preHandler: requirePermission(perm.rfqManage) },
    (request, reply) => {
      const input = z
        .object({ rfqId: z.uuid(), vendorId: z.uuid(), ...quoteFields })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await rfqs.createQuote(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/procurement/quotes/:id',
    { preHandler: requirePermission(perm.rfqManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ ...quoteFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await rfqs.updateQuote(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  /* ----------------------------------------------------- purchase orders */

  app.get(
    '/procurement/purchase-orders',
    { preHandler: requirePermission(perm.poRead) },
    (request) =>
      orders.list(
        db,
        z
          .object({
            status: z.enum(purchaseOrderStatuses).optional(),
            vendorId: z.uuid().optional(),
            projectId: z.uuid().optional(),
            ...pageFields,
          })
          .parse(request.query),
      ),
  );

  app.get('/procurement/open-po-lines', { preHandler: requirePermission(perm.poRead) }, (request) =>
    procurement.listOpenPoLines(
      db,
      z
        .object({
          vendorId: z.uuid().optional(),
          projectId: z.uuid().optional(),
          storeId: z.uuid().optional(),
        })
        .parse(request.query),
    ),
  );

  app.get(
    '/procurement/purchase-orders/:id',
    { preHandler: requirePermission(perm.poRead) },
    (request) => procurement.getPurchaseOrder(db, idParams.parse(request.params).id),
  );

  app.get(
    '/procurement/po/:id/print-model',
    { preHandler: requirePermission(perm.poRead) },
    (request) => orders.printModel(db, idParams.parse(request.params).id),
  );

  app.post(
    '/procurement/purchase-orders',
    { preHandler: requirePermission(perm.poCreate) },
    (request, reply) => {
      const input = z.object(poFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await orders.create(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/procurement/purchase-orders/from-rfq',
    { preHandler: requirePermission(perm.poCreate) },
    (request, reply) => {
      const input = z
        .object({
          rfqId: z.uuid(),
          vendorId: z.uuid(),
          orderDate: date,
          expectedDate: date.optional(),
          terms: text.optional(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await orders.createFromRfq(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/procurement/purchase-orders/:id',
    { preHandler: requirePermission(perm.poCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ ...poFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/procurement/purchase-orders/:id/amend',
    { preHandler: requirePermission(perm.poAmend) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ ...poFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await orders.amend(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  for (const [action, permission] of [
    ['submit', perm.poCreate],
    ['close', perm.poClose],
    ['cancel', perm.poClose],
  ] as const) {
    app.post(
      `/procurement/purchase-orders/:id/${action}`,
      { preHandler: requirePermission(permission) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const { version: expected } = versionBody.parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await orders[action](id, expected, actorOf(request), tx)),
        );
      },
    );
  }

  /* ------------------------------------------------------------- receipts */

  app.get('/procurement/grns', { preHandler: requirePermission(perm.grnRead) }, (request) =>
    receipts.list(
      db,
      z
        .object({
          poId: z.uuid().optional(),
          status: z.enum(grnStatuses).optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.get('/procurement/grns/:id', { preHandler: requirePermission(perm.grnRead) }, (request) =>
    receipts.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/procurement/grns',
    { preHandler: requirePermission(perm.grnCreate), bodyLimit: RECEIPT_BODY_LIMIT },
    (request, reply) => {
      const { photos, ...input } = z
        .object({
          poId: z.uuid(),
          receivedOn: date,
          deliveryNoteRef: z.string().max(100).optional(),
          lines: z.array(receiptLine).min(1).max(200),
          photos: z.array(photo).max(10).optional(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await receipts.create(
            {
              ...input,
              photos: photos?.map((p) => ({
                fileName: p.fileName,
                bytes: Uint8Array.from(Buffer.from(p.contentBase64, 'base64')),
              })),
            },
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );

  app.post(
    '/procurement/grns/:id/cancel',
    { preHandler: requirePermission(perm.grnCancel) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, reason } = z
        .object({ version, reason: z.string().min(1).max(1000) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await receipts.cancel(id, reason, expected, actorOf(request), tx)),
      );
    },
  );
}

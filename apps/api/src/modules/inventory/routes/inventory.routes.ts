import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  countStatuses,
  inventoryMovementTypes,
  inventoryPermissions as perm,
  ownerships,
  storeKinds,
  transferStatuses,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Inventory } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface InventoryRouteDeps {
  db: Db;
  inventory: Inventory;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const projectParams = z.object({ projectId: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const text = z.string().max(2000);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const commandFields = {
  businessDate: date,
  backdateReason: z.string().max(500).optional(),
  note: text.optional(),
};

const costObject = z.object({
  type: z.enum(['project', 'work_order', 'overhead']),
  id: z.uuid().nullable(),
});

const issueBody = z.object({
  storeId: z.uuid(),
  itemId: z.uuid(),
  quantity: decimal,
  ownership: z.enum(ownerships).optional(),
  ownerPartyId: z.uuid().nullish(),
  costObject,
  costCodeId: z.uuid().optional(),
  ...commandFields,
});

const returnBody = z.object({ issueId: z.uuid(), quantity: decimal, ...commandFields });

const clientBody = z.object({
  storeId: z.uuid(),
  itemId: z.uuid(),
  quantity: decimal,
  ownerPartyId: z.uuid(),
  projectId: z.uuid(),
  ...commandFields,
});

const salvageBody = z.object({
  storeId: z.uuid(),
  itemId: z.uuid(),
  quantity: decimal,
  projectId: z.uuid().optional(),
  costCodeId: z.uuid().optional(),
  unitValue: decimal.optional(),
  ...commandFields,
});

const transferBody = z.object({
  fromStoreId: z.uuid(),
  toStoreId: z.uuid(),
  businessDate: date,
  backdateReason: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: decimal,
        ownership: z.enum(ownerships).optional(),
        ownerPartyId: z.uuid().nullish(),
        projectId: z.uuid().nullish(),
      }),
    )
    .min(1)
    .max(200),
});

const countBody = z.object({
  storeId: z.uuid(),
  countedOn: date,
  backdateReason: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        countedQty: decimal,
        ownership: z.enum(ownerships).optional(),
        ownerPartyId: z.uuid().nullish(),
      }),
    )
    .min(1)
    .max(500),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The inventory endpoints (spec P1-12 section 5). */
export function registerInventoryRoutes(app: FastifyInstance, deps: InventoryRouteDeps): void {
  const { db, inventory, platform } = deps;
  const { stock, transfers, counts, stores } = inventory.service;

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

  const keyOf = (request: FastifyRequest): string | undefined => {
    const key = request.headers['idempotency-key'];
    if (Array.isArray(key) || key === '') {
      throw new ValidationError(
        'invalid_idempotency_key',
        'Idempotency-Key must be a single value',
      );
    }
    return key;
  };

  /** One transaction per command; with an Idempotency-Key header a retry replays the first response. */
  const command = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (tx: Db) => Promise<CommandResult>,
  ) => {
    const key = keyOf(request);
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

  /* -------------------------------------------------------------- stores */

  app.get('/inventory/stores', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    stores.list(
      db,
      z
        .object({
          active: z
            .enum(['true', 'false'])
            .transform((value) => value === 'true')
            .optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/inventory/stores',
    { preHandler: requirePermission(perm.storeManage) },
    (request, reply) => {
      const input = z
        .object({
          code: z.string().min(1).max(40),
          name: z.string().min(1).max(200),
          kind: z.enum(storeKinds),
          projectId: z.uuid().nullish(),
          custodianUserId: z.uuid().nullish(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await stores.create(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/inventory/reorder-levels',
    { preHandler: requirePermission(perm.storeManage) },
    (request, reply) => {
      const input = z
        .object({ storeId: z.uuid(), itemId: z.uuid(), level: decimal })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await stores.setReorderLevel(input, actorOf(request), tx)),
      );
    },
  );

  /* ------------------------------------------------------- stock, ledger */

  app.get('/inventory/stock', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    stock.listStock(
      db,
      z
        .object({
          storeId: z.uuid().optional(),
          itemId: z.uuid().optional(),
          ownership: z.enum(ownerships).optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.get('/inventory/ledger', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    stock.listLedger(
      db,
      z
        .object({
          storeId: z.uuid().optional(),
          itemId: z.uuid().optional(),
          ownership: z.enum(ownerships).optional(),
          movementType: z.enum(inventoryMovementTypes).optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.get(
    '/inventory/client-material/:projectId',
    { preHandler: requirePermission(perm.stockRead) },
    (request) => stock.clientMaterial(db, projectParams.parse(request.params).projectId),
  );

  app.get('/inventory/integrity', { preHandler: requirePermission(perm.storeManage) }, () =>
    stock.integrity(db),
  );

  /* ----------------------------------------------------------- movements */

  // A supervisor holds only the read permission; the service lets them issue when the setting
  // `supervisor_can_issue` is on and the store is one of their project stores.
  app.post(
    '/inventory/issues',
    { preHandler: requirePermission(perm.stockRead) },
    (request, reply) => {
      const input = issueBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await stock.issue({ ...input, idempotencyKey: keyOf(request) }, actorOf(request), tx),
        ),
      );
    },
  );

  app.post(
    '/inventory/returns',
    { preHandler: requirePermission(perm.stockReturn) },
    (request, reply) => {
      const input = returnBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await stock.returnToStore(
            { ...input, idempotencyKey: keyOf(request) },
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );

  app.post(
    '/inventory/client-receipts',
    { preHandler: requirePermission(perm.stockReturn) },
    (request, reply) => {
      const input = clientBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await stock.receiveClientMaterial(
            { ...input, idempotencyKey: keyOf(request) },
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );

  app.post(
    '/inventory/client-returns',
    { preHandler: requirePermission(perm.stockIssue) },
    (request, reply) => {
      const input = clientBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await stock.returnClientMaterial(
            { ...input, idempotencyKey: keyOf(request) },
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );

  app.post(
    '/inventory/salvage',
    { preHandler: requirePermission(perm.stockReturn) },
    (request, reply) => {
      const input = salvageBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(
          await stock.salvage({ ...input, idempotencyKey: keyOf(request) }, actorOf(request), tx),
        ),
      );
    },
  );

  /* ----------------------------------------------------------- transfers */

  app.get('/inventory/transfers', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    transfers.list(
      db,
      z.object({ status: z.enum(transferStatuses).optional(), ...pageFields }).parse(request.query),
    ),
  );

  app.get(
    '/inventory/transfers/:id',
    { preHandler: requirePermission(perm.stockRead) },
    (request) => transfers.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/inventory/transfers',
    { preHandler: requirePermission(perm.stockTransfer) },
    (request, reply) => {
      const input = transferBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await transfers.create(input, actorOf(request), tx)),
      );
    },
  );

  for (const [path, action] of [
    ['send', 'send'],
    ['receive', 'receive'],
    ['cancel', 'cancel'],
  ] as const) {
    app.post(
      `/inventory/transfers/:id/${path}`,
      { preHandler: requirePermission(perm.stockTransfer) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const { version: expected } = versionBody.parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await transfers[action](id, expected, actorOf(request), tx)),
        );
      },
    );
  }

  /* -------------------------------------------------------------- counts */

  app.get('/inventory/counts', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    counts.list(
      db,
      z.object({ status: z.enum(countStatuses).optional(), ...pageFields }).parse(request.query),
    ),
  );

  app.get('/inventory/counts/:id', { preHandler: requirePermission(perm.stockRead) }, (request) =>
    counts.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/inventory/counts',
    { preHandler: requirePermission(perm.stockCount) },
    (request, reply) => {
      const input = countBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await counts.create(input, actorOf(request), tx)),
      );
    },
  );

  for (const action of ['submit', 'cancel'] as const) {
    app.post(
      `/inventory/counts/:id/${action}`,
      { preHandler: requirePermission(perm.stockCount) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const { version: expected } = versionBody.parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await counts[action](id, expected, actorOf(request), tx)),
        );
      },
    );
  }
}

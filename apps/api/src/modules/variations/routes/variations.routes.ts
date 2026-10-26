import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { variationStatuses, variationsPermissions as perm } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Variations } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface VariationsRouteDeps {
  db: Db;
  variations: Variations;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const money = z.string().regex(/^-?\d{1,14}(\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const line = z.object({
  description: z.string().min(1).max(500),
  costCodeId: z.uuid(),
  costAmount: money,
  priceAmount: money,
});

const fields = {
  title: z.string().min(1).max(500),
  reason: z.string().max(5000).optional(),
  discoveredOn: date,
  lines: z.array(line).min(1).max(200),
};

const createBody = z.object(fields);
const updateBody = z.object({ ...fields, version });

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The variations endpoints (spec P1-10 section 5). */
export function registerVariationsRoutes(app: FastifyInstance, deps: VariationsRouteDeps): void {
  const { db, variations, platform } = deps;
  const { service } = variations;

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

  app.get('/projects/:id/variations', { preHandler: requirePermission(perm.read) }, (request) =>
    service.list(
      db,
      idParams.parse(request.params).id,
      z
        .object({ status: z.enum(variationStatuses).optional(), ...pageFields })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.get(
    '/projects/:id/contract-value',
    { preHandler: requirePermission(perm.read) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      // Reaching the project is checked by listing nothing for it first.
      await service.list(db, id, { limit: 1, offset: 0 }, actorOf(request));
      return service.contractValue(db, id);
    },
  );

  app.post(
    '/projects/:id/variations',
    { preHandler: requirePermission(perm.create) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = createBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await service.create(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get('/variations/:id', { preHandler: requirePermission(perm.read) }, (request) =>
    service.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put('/variations/:id', { preHandler: requirePermission(perm.update) }, (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { version: expected, ...input } = updateBody.parse(request.body);
    return command(request, reply, async (tx) =>
      ok(await service.update(id, input, expected, actorOf(request), tx)),
    );
  });

  app.delete(
    '/variations/:id',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await service.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/variations/:id/submit-internal',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.submitInternal(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/variations/:id/send-to-client',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.sendToClient(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/variations/:id/client-approve',
    { preHandler: requirePermission(perm.clientApprove) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ version, reference: z.string().min(1).max(200), approvedOn: date })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.clientApprove(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/variations/:id/client-reject',
    { preHandler: requirePermission(perm.clientApprove) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, reason } = z
        .object({ version, reason: z.string().min(1).max(1000) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.clientReject(id, reason, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/variations/:id/cancel',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.cancel(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/variations/:id/copy',
    { preHandler: requirePermission(perm.create) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      return command(request, reply, async (tx) =>
        created(await service.copy(id, actorOf(request), tx)),
      );
    },
  );
}

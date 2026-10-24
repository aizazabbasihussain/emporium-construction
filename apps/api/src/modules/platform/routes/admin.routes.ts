import { ValidationError } from '@emporium/domain';
import { platformPermissions, type PlatformPermission } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../policy/platform.policy.js';
import { hashRequest, type CommandResult } from '../service/idempotency.service.js';
import type { Platform } from '../index.js';
import type { Db, Principal } from '../types.js';

export interface PlatformRouteDeps {
  db: Db;
  platform: Platform;
  /** Resolves the caller (P1-02 supplies the JWT-backed implementation). */
  resolvePrincipal: (request: FastifyRequest) => Principal | null | Promise<Principal | null>;
}

const auditQuery = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actorUserId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const eventParams = z.object({ id: z.uuid() });
const settingParams = z.object({ key: z.string().min(1).max(100) });
const settingBody = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  version: z.number().int().min(0),
});
const seriesBody = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(50),
  prefix: z.string().min(1).max(20),
  padding: z.number().int().min(1).max(12),
  resetYearly: z.boolean(),
  gapless: z.boolean(),
  startValue: z.number().int().min(0),
  nextValue: z.number().int().min(0).optional(),
  version: z.number().int().min(1).optional(),
});

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { db, platform } = deps;

  const authorize = async (request: FastifyRequest, permission: PlatformPermission) =>
    requirePermission(await deps.resolvePrincipal(request), permission);

  /** Runs a mutation in one transaction; with an Idempotency-Key header a retry replays the first response. */
  const command = async (
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
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
              userId: principal.userId,
              requestHash: hashRequest(request.method, request.url, request.body),
            },
            run,
          );
    return reply.status(result.statusCode).send(result.body);
  };

  app.get('/admin/audit', async (request) => {
    await authorize(request, platformPermissions.auditRead);
    const filter = auditQuery.parse(request.query);
    return { items: await platform.audit.search(db, filter) };
  });

  app.get('/admin/outbox/failed', async (request) => {
    await authorize(request, platformPermissions.outboxManage);
    return { items: await platform.events.listFailed(db) };
  });

  app.post('/admin/outbox/:id/retry', async (request, reply) => {
    const principal = await authorize(request, platformPermissions.outboxManage);
    const { id } = eventParams.parse(request.params);
    return command(request, reply, principal, async (tx) => {
      const event = await platform.events.retryFailed(id, tx);
      await platform.audit.record(
        {
          actorUserId: principal.userId,
          action: 'outbox.retry',
          entityType: 'outbox_event',
          entityId: id,
          requestId: request.id,
        },
        tx,
      );
      return { statusCode: 200, body: event };
    });
  });

  app.get('/admin/settings/:key', async (request) => {
    await authorize(request, platformPermissions.settingsManage);
    const { key } = settingParams.parse(request.params);
    return platform.settings.get(db, key);
  });

  app.put('/admin/settings/:key', async (request, reply) => {
    const principal = await authorize(request, platformPermissions.settingsManage);
    const { key } = settingParams.parse(request.params);
    const body = settingBody.parse(request.body);
    return command(request, reply, principal, async (tx) => ({
      statusCode: 200,
      body: await platform.settings.set(
        { key, value: body.value, expectedVersion: body.version },
        { actorUserId: principal.userId, requestId: request.id },
        tx,
      ),
    }));
  });

  app.get('/admin/number-series', async (request) => {
    await authorize(request, platformPermissions.seriesManage);
    return { items: await platform.numbering.list(db) };
  });

  app.post('/admin/number-series', async (request, reply) => {
    const principal = await authorize(request, platformPermissions.seriesManage);
    const body = seriesBody.parse(request.body);
    return command(request, reply, principal, async (tx) => ({
      statusCode: body.version === undefined ? 201 : 200,
      body: await platform.numbering.save(
        body,
        { actorUserId: principal.userId, requestId: request.id },
        tx,
      ),
    }));
  });
}

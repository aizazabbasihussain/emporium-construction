import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { notificationsPermissions } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Notifications } from '../index.js';
import type { Db } from '../types.js';

export interface NotificationsRouteDeps {
  db: Db;
  notifications: Notifications;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({ unread: z.enum(['true', 'false']).default('false') });

interface CommandResult {
  statusCode: number;
  body: unknown;
}

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

/** The notification endpoints (spec P1-04 section 5). Users only ever see their own. */
export function registerNotificationsRoutes(
  app: FastifyInstance,
  deps: NotificationsRouteDeps,
): void {
  const { db, notifications, platform } = deps;
  const guard = { preHandler: requirePermission(notificationsPermissions.readOwn) };

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

  app.get('/notifications', guard, async (request) => {
    const query = listQuery.parse(request.query);
    return notifications.service.list(db, currentUser(request).userId, {
      unreadOnly: query.unread === 'true',
    });
  });

  // Registered before `/:id/read` so the literal path is never taken for an id.
  app.post('/notifications/read-all', guard, (request, reply) =>
    command(request, reply, async (tx) => ({
      statusCode: 200,
      body: {
        updated: await notifications.service.markAllRead(
          currentUser(request).userId,
          request.id,
          tx,
        ),
      },
    })),
  );

  app.post('/notifications/:id/read', guard, (request, reply) => {
    const { id } = idParams.parse(request.params);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await notifications.service.markRead(id, currentUser(request).userId, request.id, tx),
    }));
  });
}

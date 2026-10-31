import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { workerportalPermissions as perm } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAdminRole, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { WorkerPortal } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface WorkerPortalRouteDeps {
  db: Db;
  workerPortal: WorkerPortal;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const monthQuery = z.object({ month: z.string() });

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/**
 * The worker portal endpoints (spec P1-22 section 5). No `/me/worker` route takes a worker id: the
 * worker comes from the link of the authenticated user (BR-2, AC-2).
 */
export function registerWorkerPortalRoutes(
  app: FastifyInstance,
  deps: WorkerPortalRouteDeps,
): void {
  const { db, workerPortal, platform } = deps;
  const { accounts, self } = workerPortal;

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

  const own = { preHandler: requirePermission(perm.selfRead) };
  app.get('/me/worker/attendance', own, (request) =>
    self.attendance(db, actorOf(request), monthQuery.parse(request.query).month),
  );
  app.get('/me/worker/advances', own, (request) => self.advances(db, actorOf(request)));
  app.get('/me/worker/wages', own, (request) =>
    self.wages(db, actorOf(request), monthQuery.parse(request.query).month),
  );

  // BR-1: only an admin links or unlinks.
  const manage = { preHandler: [requirePermission(perm.accountManage), requireAdminRole()] };
  app.get('/admin/workers/:id/account', manage, async (request) => ({
    account: await accounts.get(db, idParams.parse(request.params).id, actorOf(request)),
  }));
  app.put('/admin/workers/:id/account', manage, (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ userId: z.uuid(), confirmOtherRoles: z.boolean().default(false) })
      .parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await accounts.link(id, body, actorOf(request), tx),
    }));
  });
  app.delete('/admin/workers/:id/account', manage, (request, reply) => {
    const { id } = idParams.parse(request.params);
    return command(request, reply, async (tx) => {
      await accounts.unlink(id, actorOf(request), tx);
      return { statusCode: 204, body: undefined };
    });
  });
}

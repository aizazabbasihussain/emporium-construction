import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  adjustmentKinds,
  periodStatuses,
  wageAdvanceStatuses,
  wagesPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Wages } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface WagesRouteDeps {
  db: Db;
  wages: Wages;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The wages endpoints (spec P1-18 section 5). */
export function registerWagesRoutes(app: FastifyInstance, deps: WagesRouteDeps): void {
  const { db, wages, platform } = deps;
  const { periods, advances } = wages;

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

  const ok = (body: unknown): CommandResult => ({ statusCode: 200, body });

  app.get('/wages/periods', { preHandler: requirePermission(perm.periodRead) }, (request) =>
    periods.list(
      db,
      z
        .object({
          year: z.coerce.number().int().optional(),
          status: z.enum(periodStatuses).optional(),
          ...page,
        })
        .parse(request.query),
    ),
  );

  app.post(
    '/wages/periods',
    { preHandler: requirePermission(perm.periodCalculate) },
    (request, reply) => {
      const body = z
        .object({ year: z.number().int(), month: z.number().int() })
        .parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await periods.create(body, actorOf(request), tx),
      }));
    },
  );

  app.get('/wages/periods/:id', { preHandler: requirePermission(perm.periodRead) }, (request) =>
    periods.get(db, idParams.parse(request.params).id),
  );

  app.get(
    '/wages/periods/:id/lines',
    { preHandler: requirePermission(perm.periodRead) },
    (request) => periods.lines(db, idParams.parse(request.params).id),
  );

  app.get(
    '/wages/periods/:id/reconciliation',
    { preHandler: requirePermission(perm.periodRead) },
    (request) => periods.reconciliation(db, idParams.parse(request.params).id),
  );

  app.post(
    '/wages/periods/:id/calculate',
    { preHandler: requirePermission(perm.periodCalculate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      return command(request, reply, async (tx) =>
        ok(await periods.calculate(id, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/wages/periods/:id/submit',
    { preHandler: requirePermission(perm.periodSubmit) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z
        .object({ version, acknowledgeWarnings: z.boolean().default(false) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await periods.submit(id, body, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/wages/periods/:id/reopen',
    { preHandler: requirePermission(perm.periodReopen) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ reason: z.string().max(500), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await periods.reopen(id, body, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/wages/lines/:id/adjustments',
    { preHandler: requirePermission(perm.adjustmentManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z
        .object({
          kind: z.enum(adjustmentKinds),
          amount: z.string().min(1).max(30),
          reason: z.string().max(500),
        })
        .parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await periods.addAdjustment(id, body, actorOf(request), tx),
      }));
    },
  );

  app.get('/wages/advances', { preHandler: requirePermission(perm.periodRead) }, (request) =>
    advances.list(
      db,
      z
        .object({
          worker: z.uuid().optional(),
          status: z.enum(wageAdvanceStatuses).optional(),
          ...page,
        })
        .transform(({ worker, ...rest }) => ({ ...rest, workerId: worker }))
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/wages/advances',
    { preHandler: requirePermission(perm.advanceManage) },
    (request, reply) => {
      const body = z
        .object({
          workerId: z.uuid(),
          amount: z.string().min(1).max(30),
          issuedOn: date,
          monthlyRecovery: z.string().min(1).max(30),
          note: z.string().max(500).nullish(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await advances.create(body, actorOf(request), tx),
      }));
    },
  );
}

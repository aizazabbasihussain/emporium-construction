import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { dprPermissions as perm, dprStatuses, dprWeathers } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import { assertAny } from '../policy/dpr.policy.js';
import type { Dpr } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface DprRouteDeps {
  db: Db;
  dpr: Dpr;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const manpower = z.object({
  trade: z.string().min(1).max(100),
  count: z.number().int().min(0).max(100000),
});

const taskUpdate = z.object({
  taskId: z.uuid(),
  percentComplete: z.number().int().min(0).max(100),
  note: z.string().max(1000).nullish(),
});

const materialNote = z.object({
  description: z.string().min(1).max(300),
  quantity: z
    .string()
    .regex(/^\d{1,14}(\.\d{1,4})?$/)
    .nullish(),
  unitCode: z.string().max(20).nullish(),
});

const reportFields = {
  weather: z.enum(dprWeathers).optional(),
  workDone: z.string().max(5000).optional(),
  issues: z.string().max(5000).optional(),
  safetyNotes: z.string().max(5000).optional(),
  manpowerManual: z.array(manpower).max(50).optional(),
  taskUpdates: z.array(taskUpdate).max(200).optional(),
  materialNotes: z.array(materialNote).max(100).optional(),
};

const decision = z.object({ version, note: z.string().max(2000).optional() });

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The daily progress report endpoints (spec P1-15 section 5). */
export function registerDprRoutes(app: FastifyInstance, deps: DprRouteDeps): void {
  const { db, dpr, platform } = deps;

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

  app.get(
    '/dpr/reports',
    { preHandler: async (request) => assertAny(currentUser(request), [perm.reportRead]) },
    (request) =>
      dpr.reports.list(
        db,
        z
          .object({
            projectId: z.uuid().optional(),
            from: date.optional(),
            to: date.optional(),
            status: z.enum(dprStatuses).optional(),
            mine: z
              .enum(['true', 'false'])
              .default('false')
              .transform((v) => v === 'true'),
            limit: z.coerce.number().int().min(1).max(200).default(50),
            offset: z.coerce.number().int().min(0).default(0),
          })
          .parse(request.query),
        actorOf(request),
      ),
  );

  app.get('/dpr/missing', { preHandler: requirePermission(perm.reportReview) }, (request) =>
    dpr.getMissingDprs(db, z.object({ date }).parse(request.query).date),
  );

  app.post(
    '/dpr/reports',
    { preHandler: requirePermission(perm.reportCreate) },
    (request, reply) => {
      const input = z
        .object({ projectId: z.uuid(), reportDate: date, ...reportFields })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await dpr.reports.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/dpr/reports/:id',
    { preHandler: async (request) => assertAny(currentUser(request), [perm.reportRead]) },
    (request) => dpr.getDpr(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.patch(
    '/dpr/reports/:id',
    { preHandler: requirePermission(perm.reportUpdateOwn) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...patch } = z
        .object({ ...reportFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await dpr.reports.update(id, patch, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/dpr/reports/:id/submit',
    { preHandler: requirePermission(perm.reportUpdateOwn) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await dpr.reports.submit(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/dpr/reports/:id/review',
    { preHandler: requirePermission(perm.reportReview) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, note } = decision.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await dpr.reports.review(id, note, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/dpr/reports/:id/reopen',
    { preHandler: requirePermission(perm.reportReview) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, note } = decision.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await dpr.reports.reopen(id, note, expected, actorOf(request), tx)),
      );
    },
  );
}

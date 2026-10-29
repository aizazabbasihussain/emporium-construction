import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { attendancePermissions as perm, entryStatuses, sheetStatuses } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Attendance } from '../index.js';
import { assertAny } from '../policy/attendance.policy.js';
import type { Actor, Db } from '../types.js';

export interface AttendanceRouteDeps {
  db: Db;
  attendance: Attendance;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const allocation = z.object({
  projectId: z.uuid(),
  fraction: z.string().min(1).max(10),
  costCodeId: z.uuid().nullish(),
});

const entry = z.object({
  workerId: z.uuid(),
  status: z.enum(entryStatuses),
  overtimeHours: z.string().max(10).nullish(),
  overtimeProjectId: z.uuid().nullish(),
  remarks: z.string().max(500).nullish(),
  allocations: z.array(allocation).max(10).optional(),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The attendance endpoints (spec P1-17 section 5). */
export function registerAttendanceRoutes(app: FastifyInstance, deps: AttendanceRouteDeps): void {
  const { db, attendance, platform } = deps;
  const { sheets, queries } = attendance;

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

  app.get('/attendance/sheets', { preHandler: requirePermission(perm.sheetRead) }, (request) =>
    sheets.list(
      db,
      z
        .object({
          team: z.uuid().optional(),
          date: date.optional(),
          from: date.optional(),
          to: date.optional(),
          status: z.enum(sheetStatuses).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .transform(({ team, ...rest }) => ({ ...rest, teamId: team }))
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.get('/attendance/grid', { preHandler: requirePermission(perm.sheetRead) }, (request) => {
    const query = z.object({ team: z.uuid(), date }).parse(request.query);
    return sheets.grid(db, query.team, query.date, actorOf(request));
  });

  app.get('/attendance/missing', { preHandler: requirePermission(perm.sheetRead) }, (request) => {
    const query = z.object({ from: date, to: date }).parse(request.query);
    return queries.listMissing(db, query.from, query.to, actorOf(request));
  });

  app.get('/attendance/sheets/:id', { preHandler: requirePermission(perm.sheetRead) }, (request) =>
    sheets.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/attendance/sheets/:team/:date',
    {
      preHandler: async (request: FastifyRequest) =>
        assertAny(currentUser(request), [perm.sheetCreate, perm.sheetUpdate]),
    },
    (request, reply) => {
      const params = z.object({ team: z.uuid(), date }).parse(request.params);
      const body = z
        .object({ version: version.optional(), entries: z.array(entry).max(200) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await sheets.save(params.team, params.date, body, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/attendance/sheets/:id/submit',
    { preHandler: requirePermission(perm.sheetUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await sheets.submit(id, body.version, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/attendance/sheets/:id/unlock',
    { preHandler: requirePermission(perm.sheetUnlock) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ reason: z.string().max(500), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await sheets.unlock(id, { reason: body.reason }, body.version, actorOf(request), tx)),
      );
    },
  );
}

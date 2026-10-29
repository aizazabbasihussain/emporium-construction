import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  employmentTypes,
  payBases,
  workerStatuses,
  workforcePermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Workforce } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface WorkforceRouteDeps {
  db: Db;
  workforce: Workforce;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const codeParams = z.object({ code: z.string().min(1).max(40) });
const version = z.number().int().min(1);
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max);

const workerFields = {
  fullName: z.string().min(1).max(200),
  fatherName: text(200).nullish(),
  cnic: text(20).nullish(),
  phone: text(30).nullish(),
  tradeCode: z.string().min(1).max(40),
  employmentType: z.enum(employmentTypes),
  contractorPartyId: z.uuid().nullish(),
  joinedOn: date,
  bankOrWalletInfo: text(500).nullish(),
};

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The workforce endpoints (spec P1-16 section 5). */
export function registerWorkforceRoutes(app: FastifyInstance, deps: WorkforceRouteDeps): void {
  const { db, workforce, platform } = deps;
  const { workers, teams } = workforce;

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
  const gone = (): CommandResult => ({ statusCode: 204, body: undefined });

  // ---- trades ----

  app.get('/workforce/trades', { preHandler: requirePermission(perm.workerRead) }, () =>
    workers.listTrades(db),
  );

  app.post(
    '/workforce/trades',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const input = z
        .object({ code: z.string().min(1).max(40), name: z.string().min(1).max(100) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await workers.createTrade(input, actorOf(request), tx)),
      );
    },
  );

  app.patch(
    '/workforce/trades/:code',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const body = z.object({ name: z.string().min(1).max(100), version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(
          await workers.updateTrade(code, { name: body.name }, body.version, actorOf(request), tx),
        ),
      );
    },
  );

  app.delete(
    '/workforce/trades/:code',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await workers.removeTrade(code, expected, actorOf(request), tx);
        return gone();
      });
    },
  );

  // ---- workers ----

  app.get('/workforce/workers', { preHandler: requirePermission(perm.workerRead) }, (request) =>
    workers.list(
      db,
      z
        .object({
          teamId: z.uuid().optional(),
          tradeCode: z.string().max(40).optional(),
          status: z.enum(workerStatuses).optional(),
          text: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/workforce/workers',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const input = z
        .object({ code: z.string().min(1).max(40).optional(), ...workerFields })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await workers.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/workforce/workers/:id', { preHandler: requirePermission(perm.workerRead) }, (request) =>
    workers.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.patch(
    '/workforce/workers/:id',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...patch } = z
        .object(workerFields)
        .partial()
        .extend({ version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await workers.update(id, patch, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/workforce/workers/:id/deactivate',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z.object({ leftOn: date, version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(
          await workers.deactivate(id, { leftOn: body.leftOn }, body.version, actorOf(request), tx),
        ),
      );
    },
  );

  app.delete(
    '/workforce/workers/:id',
    { preHandler: requirePermission(perm.workerManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await workers.remove(id, expected, actorOf(request), tx);
        return gone();
      });
    },
  );

  // ---- pay rates (BR-7: only for the holders of the rate permissions) ----

  app.get(
    '/workforce/workers/:id/rates',
    { preHandler: requirePermission(perm.rateRead) },
    (request) => workers.listRates(db, idParams.parse(request.params).id),
  );

  app.post(
    '/workforce/workers/:id/rates',
    { preHandler: requirePermission(perm.rateManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({
          payBasis: z.enum(payBases),
          amount: z.string().min(1).max(30),
          effectiveFrom: date,
          effectiveTo: date.nullish(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await workers.addRate(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/workforce/workers/:id/rate',
    { preHandler: requirePermission(perm.rateRead) },
    (request) =>
      workforce.getWorkerRate(
        db,
        idParams.parse(request.params).id,
        z.object({ date }).parse(request.query).date,
      ),
  );

  // ---- teams ----

  app.get('/workforce/teams', { preHandler: requirePermission(perm.workerRead) }, (request) =>
    teams.list(db, actorOf(request)),
  );

  app.get('/workforce/teams/mine', { preHandler: requirePermission(perm.workerRead) }, (request) =>
    teams.mine(db, actorOf(request)),
  );

  app.post(
    '/workforce/teams',
    { preHandler: requirePermission(perm.teamManage) },
    (request, reply) => {
      const input = z
        .object({
          code: z.string().min(1).max(40).optional(),
          name: z.string().min(1).max(200),
          supervisorUserId: z.uuid(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await teams.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/workforce/teams/:id', { preHandler: requirePermission(perm.workerRead) }, (request) =>
    teams.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.patch(
    '/workforce/teams/:id',
    { preHandler: requirePermission(perm.teamManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...patch } = z
        .object({
          name: z.string().min(1).max(200).optional(),
          supervisorUserId: z.uuid().optional(),
          active: z.boolean().optional(),
          version,
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await teams.update(id, patch, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/workforce/teams/:id',
    { preHandler: requirePermission(perm.teamManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await teams.remove(id, expected, actorOf(request), tx);
        return gone();
      });
    },
  );

  app.put(
    '/workforce/teams/:id/members',
    { preHandler: requirePermission(perm.teamManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z
        .object({ workerIds: z.array(z.uuid()).max(500), date: date.optional(), version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(
          await teams.setMembers(
            id,
            { workerIds: body.workerIds, date: body.date },
            body.version,
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );
}

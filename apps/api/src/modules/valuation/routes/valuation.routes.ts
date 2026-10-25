import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  movementTypes,
  policyScopes,
  policyStatuses,
  valuationMethods,
  valuationPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Valuation } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ValuationRouteDeps {
  db: Db;
  valuation: Valuation;
  platform: Platform;
}

const policyBody = z.object({
  scope: z.enum(policyScopes),
  categoryId: z.uuid().nullish(),
  method: z.enum(valuationMethods),
  effectiveFrom: z.iso.date(),
});

const policyQuery = z.object({ status: z.enum(policyStatuses).optional() });

const stockQuery = z.object({
  store: z.uuid().optional(),
  item: z.uuid().optional(),
  category: z.uuid().optional(),
});

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const movementQuery = z.object({
  store: z.uuid().optional(),
  item: z.uuid().optional(),
  type: z.enum(movementTypes).optional(),
  ...pageFields,
});

const pageQuery = z.object(pageFields);

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/**
 * The valuation endpoints (spec P1-13 section 5). Receipts, issues, transfers and returns are
 * service-level functions called by inventory inside its own transaction, not public routes.
 */
export function registerValuationRoutes(app: FastifyInstance, deps: ValuationRouteDeps): void {
  const { db, valuation, platform } = deps;

  const actorOf = (request: FastifyRequest): Actor => ({
    userId: currentUser(request).userId,
    requestId: request.id,
  });

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

  app.get(
    '/valuation/policies',
    { preHandler: requirePermission(perm.policyRead) },
    async (request) => ({
      items: await valuation.policies.list(db, policyQuery.parse(request.query).status),
    }),
  );

  app.post(
    '/valuation/policies',
    { preHandler: requirePermission(perm.policyRequest) },
    (request, reply) => {
      const input = policyBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await valuation.setPolicy(input, actorOf(request), tx),
      }));
    },
  );

  app.post(
    '/valuation/transitions/run',
    { preHandler: requirePermission(perm.transitionRun) },
    (request, reply) =>
      command(request, reply, async (tx) => ({
        statusCode: 200,
        body: { items: await valuation.requestTransition(actorOf(request), tx) },
      })),
  );

  app.get('/valuation/transitions', { preHandler: requirePermission(perm.reportRead) }, (request) =>
    valuation.reports.transitions(db, pageQuery.parse(request.query)),
  );

  app.get(
    '/valuation/stock-value',
    { preHandler: requirePermission(perm.reportRead) },
    (request) => {
      const query = stockQuery.parse(request.query);
      return valuation.getTotalValue(db, {
        storeId: query.store,
        itemId: query.item,
        categoryId: query.category,
      });
    },
  );

  app.get('/valuation/movements', { preHandler: requirePermission(perm.reportRead) }, (request) => {
    const query = movementQuery.parse(request.query);
    return valuation.reports.movements(db, {
      storeId: query.store,
      itemId: query.item,
      type: query.type,
      limit: query.limit,
      offset: query.offset,
    });
  });
}

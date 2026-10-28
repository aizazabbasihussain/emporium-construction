import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  advanceStatuses,
  claimCostObjectTypes,
  claimStatuses,
  expensesPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import { assertAny } from '../policy/expenses.policy.js';
import type { Expenses } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ExpensesRouteDeps {
  db: Db;
  expenses: Expenses;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const line = z.object({
  expenseDate: date,
  category: z.string().min(1).max(60),
  description: z.string().min(1).max(500),
  costObjectType: z.enum(claimCostObjectTypes),
  costObjectId: z.uuid().nullish(),
  costCodeId: z.uuid(),
  amount: money,
  receiptFileId: z.uuid().nullish(),
});

const claimFields = {
  note: z.string().max(2000).optional(),
  lines: z.array(line).min(1).max(100),
};

const category = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  name: z.string().min(1).max(200),
  defaultCostCodeId: z.uuid().nullish(),
  receiptRequired: z.boolean(),
  maxWithoutReceipt: money,
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** Anyone who files or reads claims. */
const claimReaders = [perm.claimCreate, perm.claimReadOwn, perm.claimReadAll];

/** The expenses endpoints (spec P1-14 section 5). */
export function registerExpensesRoutes(app: FastifyInstance, deps: ExpensesRouteDeps): void {
  const { db, expenses, platform } = deps;

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

  /** The route is open to the holder of any one of the permissions. */
  const anyOf = (...codes: string[]) => ({
    preHandler: async (request: FastifyRequest) => assertAny(currentUser(request), codes),
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

  const created = (body: unknown): CommandResult => ({ statusCode: 201, body });
  const ok = (body: unknown): CommandResult => ({ statusCode: 200, body });
  const noContent: CommandResult = { statusCode: 204, body: null };

  // ---- claims ----

  app.get('/expenses/claims', anyOf(...claimReaders), (request) =>
    expenses.claims.list(
      db,
      z
        .object({
          status: z.enum(claimStatuses).optional(),
          mine: z
            .enum(['true', 'false'])
            .default('false')
            .transform((v) => v === 'true'),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/expenses/claims',
    { preHandler: requirePermission(perm.claimCreate) },
    (request, reply) => {
      const input = z.object(claimFields).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await expenses.claims.create(input, actorOf(request), tx)),
      );
    },
  );

  app.get('/expenses/claims/:id', anyOf(...claimReaders), (request) =>
    expenses.claims.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/expenses/claims/:id',
    { preHandler: requirePermission(perm.claimCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({ ...claimFields, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.claims.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/expenses/claims/:id',
    { preHandler: requirePermission(perm.claimCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await expenses.claims.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/expenses/claims/:id/submit',
    { preHandler: requirePermission(perm.claimCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, acknowledgeDuplicates } = z
        .object({ version, acknowledgeDuplicates: z.boolean().default(false) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(
          await expenses.claims.submit(
            id,
            { acknowledgeDuplicates },
            expected,
            actorOf(request),
            tx,
          ),
        ),
      );
    },
  );

  app.post(
    '/expenses/claims/:id/post',
    { preHandler: requirePermission(perm.claimPost) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.claims.post(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/expenses/claims/:id/cancel',
    anyOf(perm.claimCreate, perm.claimReverse),
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, reason } = z
        .object({ version, reason: z.string().max(1000).optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.claims.cancel(id, { reason }, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/expenses/claims/:id/reverse',
    { preHandler: requirePermission(perm.claimReverse) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, reason } = z
        .object({ version, reason: z.string().min(1).max(1000) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.claims.reverse(id, reason, expected, actorOf(request), tx)),
      );
    },
  );

  // ---- advances and custodians ----

  app.get('/expenses/advances', anyOf(...claimReaders, perm.advanceIssue), (request) =>
    expenses.advances.list(
      db,
      z
        .object({
          custodianId: z.uuid().optional(),
          status: z.enum(advanceStatuses).optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/expenses/advances',
    { preHandler: requirePermission(perm.advanceIssue) },
    (request, reply) => {
      const input = z
        .object({
          custodianId: z.uuid(),
          amount: money,
          issuedOn: date,
          purpose: z.string().min(1).max(500),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await expenses.advances.issue(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/expenses/advances/:id/settle',
    { preHandler: requirePermission(perm.advanceIssue) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, note } = z
        .object({ version, note: z.string().max(1000).optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.advances.settle(id, { note }, expected, actorOf(request), tx)),
      );
    },
  );

  app.get('/expenses/custodians', anyOf(perm.claimReadAll, perm.advanceIssue), () =>
    expenses.advances.listCustodians(db),
  );

  app.get(
    '/expenses/custodian-candidates',
    { preHandler: requirePermission(perm.advanceIssue) },
    () => expenses.advances.candidates(db),
  );

  app.put(
    '/expenses/custodians/:id',
    { preHandler: requirePermission(perm.advanceIssue) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ floatLimit: money, active: z.boolean(), version: version.optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.advances.saveCustodian(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/expenses/custodians/:id/balance',
    anyOf(...claimReaders, perm.advanceIssue),
    (request) =>
      expenses.advances.getCustodian(db, idParams.parse(request.params).id, actorOf(request)),
  );

  // ---- categories ----

  app.get('/expenses/categories', anyOf(...claimReaders, perm.categoryManage), () =>
    expenses.categories.list(db),
  );

  app.put(
    '/expenses/categories',
    { preHandler: requirePermission(perm.categoryManage) },
    (request, reply) => {
      const { categories } = z
        .object({ categories: z.array(category).min(1).max(100) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await expenses.categories.save(categories, actorOf(request), tx)),
      );
    },
  );
}

import { createHash } from 'node:crypto';
import { ForbiddenError, ValidationError } from '@emporium/domain';
import { accountingDocTypes, accountingPermissions, exportCodes } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { ExportsService } from '../service/exports.service.js';
import type { TaggingService } from '../service/tagging.service.js';
import type { Actor, Db } from '../types.js';

export interface AccountingRouteDeps {
  db: Db;
  exports: ExportsService;
  tagging: TaggingService;
  platform: Platform;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const docType = z.enum(accountingDocTypes);
const accountCode = z.string().min(1).max(20);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const page = {
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const runBody = z.object({
  from: date,
  to: date,
  partyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  accountId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  side: z.enum(['receivable', 'payable']).optional(),
  authorityCode: z.string().min(1).max(20).optional(),
});
const target = z.object({
  docType,
  docId: z.string().min(1).max(100),
  lineRef: z.string().max(50).optional(),
});
const tagsBody = z.object({
  targets: z.array(target).min(1).max(500),
  accountCode,
});
const backfillBody = z.object({ from: date.optional(), to: date.optional() });
const ruleBody = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  sourceDocType: docType,
  condition: z.record(z.string().min(1).max(40), z.string().max(100)).optional(),
  debitAccountCode: accountCode,
  creditAccountCode: accountCode,
  effectiveFrom: date,
  active: z.boolean().optional(),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The accountant exports endpoints (spec P2-09 section 5). */
export function registerAccountingRoutes(app: FastifyInstance, deps: AccountingRouteDeps): void {
  const { db, exports, tagging, platform } = deps;

  const actorOf = (request: FastifyRequest): Actor => {
    const user = currentUser(request);
    return {
      userId: user.userId,
      roles: user.roles,
      scopes: user.scopes,
      permissions: user.permissions,
      requestId: request.id,
      name: user.fullName,
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

  // The permission is checked before the input; the services check it again (defence in depth).
  const anyAccounting = {
    preHandler: async (request: FastifyRequest) => {
      const { permissions } = currentUser(request);
      if (!Object.values(accountingPermissions).some((code) => permissions.has(code))) {
        throw new ForbiddenError('forbidden', 'Not allowed to open the accountant exports');
      }
    },
  };
  const canRun = { preHandler: requirePermission(accountingPermissions.exportRun) };
  const canTag = { preHandler: requirePermission(accountingPermissions.tagManage) };
  const canRules = { preHandler: requirePermission(accountingPermissions.rulesManage) };

  app.get('/exports', anyAccounting, async (request) => exports.list(actorOf(request)));

  app.post('/exports/:code/run', canRun, async (request, reply) => {
    const { code } = z.object({ code: z.enum(exportCodes) }).parse(request.params);
    const body = runBody.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 201,
      body: await exports.run(code, body, actorOf(request), tx),
    }));
  });

  app.get('/exports/runs', anyAccounting, async (request) => {
    const query = z
      .object({ exportCode: z.enum(exportCodes).optional(), ...page })
      .parse(request.query);
    return exports.runs(db, query, actorOf(request));
  });

  app.get('/accounting/untagged', anyAccounting, async (request) => {
    const query = z
      .object({ from: date.optional(), to: date.optional(), docType: docType.optional(), ...page })
      .parse(request.query);
    return tagging.listUntagged(db, query, actorOf(request));
  });

  app.put('/accounting/tags', canTag, async (request, reply) => {
    const { targets, accountCode: code } = tagsBody.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await tagging.tagMany(targets, code, actorOf(request), tx),
    }));
  });

  app.post('/accounting/backfill/dry-run', canTag, async (request, reply) => {
    const body = backfillBody.parse(request.body ?? {});
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await tagging.backfill({ ...body, dryRun: true }, actorOf(request), tx),
    }));
  });

  app.post('/accounting/backfill/commit', canTag, async (request, reply) => {
    const body = backfillBody.parse(request.body ?? {});
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await tagging.backfill({ ...body, dryRun: false }, actorOf(request), tx),
    }));
  });

  app.get('/accounting/mapping-rules', anyAccounting, async (request) =>
    tagging.listRules(db, actorOf(request)),
  );

  /** With an `id` (and its `version`) the rule is changed; without one a new rule is made. */
  app.put('/accounting/mapping-rules', canRules, async (request, reply) => {
    const { id, version, ...input } = ruleBody.parse(request.body);
    if ((id === undefined) !== (version === undefined)) {
      throw new ValidationError('invalid_rule', 'Give both id and version to change a rule');
    }
    return command(request, reply, async (tx) => ({
      statusCode: id === undefined ? 201 : 200,
      body:
        id === undefined || version === undefined
          ? await tagging.createRule(input, actorOf(request), tx)
          : await tagging.updateRule(id, { ...input, version }, actorOf(request), tx),
    }));
  });

  app.get('/accounting/accounts', anyAccounting, async (request) => {
    const { includeInactive } = z.object({ includeInactive: flag.optional() }).parse(request.query);
    return tagging.listAccounts(db, includeInactive ?? false, actorOf(request));
  });

  app.put('/accounting/accounts/:code', canRules, async (request, reply) => {
    const { code } = z.object({ code: accountCode }).parse(request.params);
    const body = z
      .object({ active: z.boolean(), version: z.number().int().min(1) })
      .parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await tagging.setAccountActive(code, body, actorOf(request), tx),
    }));
  });
}

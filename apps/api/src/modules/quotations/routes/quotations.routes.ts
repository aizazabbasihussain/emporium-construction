import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { quotationStatuses, quotationsPermissions as perm, stageBases } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Quotations } from '../index.js';
import { renderQuotationPdf } from '../render/pdf.js';
import type { Actor, Db } from '../types.js';

export interface QuotationsRouteDeps {
  db: Db;
  quotations: Quotations;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const longText = z.string().max(20_000);
const price = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const stage = z.object({
  name: z.string().min(1).max(200),
  basis: z.enum(stageBases),
  percent: percent.nullish(),
  amount: price.nullish(),
  conditionText: z.string().max(1000).nullish(),
});

const fields = {
  title: z.string().min(1).max(500).optional(),
  partyId: z.uuid().nullish(),
  leadId: z.uuid().nullish(),
  locationId: z.uuid().nullish(),
  scopeText: longText.optional(),
  inclusions: longText.optional(),
  exclusions: longText.optional(),
  terms: longText.optional(),
  validityDays: z.number().int().optional(),
  price: price.optional(),
  stages: z.array(stage).max(50),
};

const createBody = z.object({ estimateId: z.uuid(), ...fields });
const updateBody = z.object({ estimateId: z.uuid().optional(), ...fields, version });

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The quotations endpoints (spec P1-08 section 5). */
export function registerQuotationsRoutes(app: FastifyInstance, deps: QuotationsRouteDeps): void {
  const { db, quotations, platform } = deps;
  const { service } = quotations;

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
  /** Spec section 5: the margin panel is visible to authorized users only. */
  const marginOf = (request: FastifyRequest): boolean =>
    currentUser(request).permissions.has(perm.marginRead);

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

  app.get('/quotations', { preHandler: requirePermission(perm.read) }, (request) =>
    service.list(
      db,
      z
        .object({
          q: z.string().max(100).optional(),
          status: z.enum(quotationStatuses).optional(),
          leadId: z.uuid().optional(),
          partyId: z.uuid().optional(),
          estimateId: z.uuid().optional(),
          ...pageFields,
        })
        .parse(request.query),
    ),
  );

  app.get('/quotations/:id', { preHandler: requirePermission(perm.read) }, (request) =>
    service.get(db, idParams.parse(request.params).id, marginOf(request)),
  );

  app.get('/quotations/:id/print-model', { preHandler: requirePermission(perm.read) }, (request) =>
    service.printModel(db, idParams.parse(request.params).id),
  );

  app.get(
    '/quotations/:id/pdf',
    { preHandler: requirePermission(perm.read) },
    async (request, reply) => {
      const model = await service.printModel(db, idParams.parse(request.params).id);
      return reply
        .type('application/pdf')
        .header(
          'content-disposition',
          `inline; filename="${model.quotation.number.replace(/\//g, '-')}.pdf"`,
        )
        .send(renderQuotationPdf(model));
    },
  );

  app.post('/quotations', { preHandler: requirePermission(perm.create) }, (request, reply) => {
    const input = createBody.parse(request.body);
    return command(request, reply, async (tx) =>
      created(await service.create(input, actorOf(request), tx, marginOf(request))),
    );
  });

  app.put('/quotations/:id', { preHandler: requirePermission(perm.update) }, (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { version: expected, ...input } = updateBody.parse(request.body);
    return command(request, reply, async (tx) =>
      ok(await service.update(id, input, expected, actorOf(request), tx, marginOf(request))),
    );
  });

  app.delete(
    '/quotations/:id',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await service.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/quotations/:id/submit',
    { preHandler: requirePermission(perm.submit) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.submit(id, expected, actorOf(request), tx, marginOf(request))),
      );
    },
  );

  app.post(
    '/quotations/:id/issue',
    { preHandler: requirePermission(perm.issue) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.issue(id, expected, actorOf(request), tx, marginOf(request))),
      );
    },
  );

  app.post(
    '/quotations/:id/accept',
    { preHandler: requirePermission(perm.accept) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({
          version,
          acceptedByName: z.string().min(1).max(200),
          note: z.string().max(1000).nullish(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.accept(id, input, expected, actorOf(request), tx, marginOf(request))),
      );
    },
  );

  app.post(
    '/quotations/:id/reject',
    { preHandler: requirePermission(perm.reject) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, reason } = z
        .object({ version, reason: z.string().min(1).max(1000) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.reject(id, reason, expected, actorOf(request), tx, marginOf(request))),
      );
    },
  );

  app.post(
    '/quotations/:id/revise',
    { preHandler: requirePermission(perm.create) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      return command(request, reply, async (tx) =>
        created(await service.revise(id, actorOf(request), tx, marginOf(request))),
      );
    },
  );
}

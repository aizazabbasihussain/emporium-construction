import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  estimateLineKinds,
  estimateSectors,
  estimateSuppliers,
  estimateWorkTypes,
  estimationPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Estimation } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface EstimationRouteDeps {
  db: Db;
  estimation: Estimation;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const text = z.string().max(500);
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const percent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);
const price = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const parameter = z.object({
  key: z.string().min(1).max(32),
  label: text.min(1),
  unit: z.string().max(16),
});

const templateLine = z.object({
  description: text.min(1),
  lineKind: z.enum(estimateLineKinds),
  itemId: z.uuid().nullish(),
  costCodeId: z.uuid(),
  unitCode: z.string().min(1).max(16),
  qtyFormula: z.string().min(1).max(500),
  defaultRate: decimal.nullish(),
  suppliedBy: z.enum(estimateSuppliers).optional(),
});

const templateBody = z.object({
  code: z.string().min(1).max(32),
  name: text.min(1),
  workType: z.enum(estimateWorkTypes),
  parameters: z.array(parameter).max(20),
  active: z.boolean().optional(),
  lines: z.array(templateLine).max(200),
});

const estimateLine = z.object({
  description: text.min(1),
  lineKind: z.enum(estimateLineKinds),
  itemId: z.uuid().nullish(),
  costCodeId: z.uuid(),
  unitCode: z.string().min(1).max(16),
  quantity: decimal,
  rate: decimal,
  suppliedBy: z.enum(estimateSuppliers).optional(),
  note: text.nullish(),
});

const terms = {
  overheadPercent: percent.optional(),
  contingencyPercent: percent.optional(),
  targetMarginPercent: percent.optional(),
  proposedPrice: price.nullish(),
};

const estimateBody = z.object({
  title: text.min(1),
  workType: z.enum(estimateWorkTypes),
  sector: z.enum(estimateSectors),
  leadId: z.uuid().nullish(),
  partyId: z.uuid().nullish(),
  ...terms,
  lines: z.array(estimateLine).max(300),
});

const fromTemplateBody = z.object({
  templateId: z.uuid(),
  title: text.min(1),
  sector: z.enum(estimateSectors),
  workType: z.enum(estimateWorkTypes).optional(),
  leadId: z.uuid().nullish(),
  partyId: z.uuid().nullish(),
  ...terms,
  parameterValues: z.record(z.string().max(32), z.string().max(20)),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The estimation endpoints (spec P1-07 section 5). */
export function registerEstimationRoutes(app: FastifyInstance, deps: EstimationRouteDeps): void {
  const { db, estimation, platform } = deps;
  const { templates, estimates } = estimation;

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

  const created = (body: unknown): CommandResult => ({ statusCode: 201, body });
  const ok = (body: unknown): CommandResult => ({ statusCode: 200, body });
  const noContent: CommandResult = { statusCode: 204, body: null };

  // Templates ----------------------------------------------------------------------------------

  app.get(
    '/estimation/templates',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) =>
      templates.list(
        db,
        z
          .object({
            q: z.string().max(100).optional(),
            workType: z.enum(estimateWorkTypes).optional(),
            active: z
              .enum(['true', 'false'])
              .transform((value) => value === 'true')
              .optional(),
            ...pageFields,
          })
          .parse(request.query),
      ),
  );

  app.get(
    '/estimation/templates/:id',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) => templates.get(db, idParams.parse(request.params).id),
  );

  app.post(
    '/estimation/templates',
    { preHandler: requirePermission(perm.templateManage) },
    (request, reply) => {
      const input = templateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await templates.create(input, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/estimation/templates/:id',
    { preHandler: requirePermission(perm.templateManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = templateBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await templates.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/estimation/templates/:id',
    { preHandler: requirePermission(perm.templateManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await templates.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/estimation/templates/:id/copy',
    { preHandler: requirePermission(perm.templateManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ code: z.string().min(1).max(32), name: text.min(1) })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await templates.copy(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/estimation/formula-preview',
    { preHandler: requirePermission(perm.templateManage) },
    (request) => {
      const input = z
        .object({
          parameters: z.array(parameter).max(20),
          values: z.record(z.string().max(32), z.string().max(20)),
          formulas: z.array(z.string().max(500)).max(200),
        })
        .parse(request.body);
      return { results: templates.previewFormulas(input) };
    },
  );

  // Estimates ----------------------------------------------------------------------------------

  app.get(
    '/estimation/estimates',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) =>
      estimates.list(
        db,
        z
          .object({
            q: z.string().max(100).optional(),
            status: z.enum(['draft', 'locked', 'superseded']).optional(),
            leadId: z.uuid().optional(),
            partyId: z.uuid().optional(),
            ...pageFields,
          })
          .parse(request.query),
      ),
  );

  app.get(
    '/estimation/estimates/:id',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) => estimates.get(db, idParams.parse(request.params).id),
  );

  app.get(
    '/estimation/estimates/:id/summary',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) => estimates.summary(db, idParams.parse(request.params).id),
  );

  app.post(
    '/estimation/estimates',
    { preHandler: requirePermission(perm.estimateCreate) },
    (request, reply) => {
      const input = estimateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await estimates.create(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/estimation/estimates/from-template',
    { preHandler: requirePermission(perm.estimateCreate) },
    (request, reply) => {
      const input = fromTemplateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await estimates.createFromTemplate(input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/estimation/estimates/preview',
    { preHandler: requirePermission(perm.estimateRead) },
    (request) => {
      const input = z
        .object({
          ...terms,
          lines: z
            .array(
              z.object({
                lineKind: z.enum(estimateLineKinds),
                quantity: decimal,
                rate: decimal,
                suppliedBy: z.enum(estimateSuppliers).optional(),
              }),
            )
            .max(300),
        })
        .parse(request.body);
      return estimates.preview(db, input);
    },
  );

  app.put(
    '/estimation/estimates/:id',
    { preHandler: requirePermission(perm.estimateUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = estimateBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await estimates.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/estimation/estimates/:id',
    { preHandler: requirePermission(perm.estimateUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await estimates.remove(id, expected, actorOf(request), tx);
        return noContent;
      });
    },
  );

  app.post(
    '/estimation/estimates/:id/lock',
    { preHandler: requirePermission(perm.estimateLock) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await estimates.lock(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/estimation/estimates/:id/revise',
    { preHandler: requirePermission(perm.estimateCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      return command(request, reply, async (tx) =>
        created(await estimates.revise(id, actorOf(request), tx)),
      );
    },
  );
}

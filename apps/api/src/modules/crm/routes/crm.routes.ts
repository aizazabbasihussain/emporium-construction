import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { crmPermissions as perm, leadSectors, leadWorkTypes } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Crm } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface CrmRouteDeps {
  db: Db;
  crm: Crm;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const date = z.iso.date();
const text = z.string().max(500);
const optionalText = text.nullish();

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  direction: z.enum(['asc', 'desc']).default('asc'),
};

const leadBody = z.object({
  partyId: z.uuid().nullish(),
  contactName: optionalText,
  contactPhone: optionalText,
  workType: z.enum(leadWorkTypes),
  sector: z.enum(leadSectors),
  locationId: z.uuid().nullish(),
  siteAddress: optionalText,
  description: z.string().max(4000).nullish(),
  expectedValue: z
    .string()
    .regex(/^\d{1,16}(\.\d{1,2})?$/)
    .nullish(),
  sourceCode: z.string().min(1).max(32),
  ownerUserId: z.uuid().optional(),
});

const leadQuery = z.object({
  q: z.string().max(100).optional(),
  stageCode: z.string().max(32).optional(),
  sector: z.enum(leadSectors).optional(),
  ownerUserId: z.uuid().optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sort: z.enum(['number', 'created', 'value', 'stage']).default('created'),
  ...pageFields,
  direction: z.enum(['asc', 'desc']).default('desc'),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The CRM endpoints (spec P1-06 section 5). */
export function registerCrmRoutes(app: FastifyInstance, deps: CrmRouteDeps): void {
  const { db, crm, platform } = deps;
  const { service } = crm;

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

  app.get('/crm/reference', { preHandler: requirePermission(perm.leadRead) }, () =>
    service.reference(db),
  );

  // Leads --------------------------------------------------------------------------------------

  app.get('/crm/leads', { preHandler: requirePermission(perm.leadRead) }, (request) =>
    service.listLeads(db, leadQuery.parse(request.query)),
  );

  app.get('/crm/leads/:id', { preHandler: requirePermission(perm.leadRead) }, (request) => {
    const { id } = idParams.parse(request.params);
    return service.detail(db, id);
  });

  app.post('/crm/leads', { preHandler: requirePermission(perm.leadCreate) }, (request, reply) => {
    const input = leadBody.parse(request.body);
    return command(request, reply, async (tx) =>
      created(await service.createLead(input, actorOf(request), tx)),
    );
  });

  app.put(
    '/crm/leads/:id',
    { preHandler: requirePermission(perm.leadUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = leadBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.updateLead(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/crm/leads/:id',
    { preHandler: requirePermission(perm.leadUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await service.removeLead(id, expected, actorOf(request), tx);
        return { statusCode: 204, body: null };
      });
    },
  );

  app.post(
    '/crm/leads/:id/stage',
    { preHandler: requirePermission(perm.leadUpdate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = z
        .object({
          stageCode: z.string().min(1).max(32),
          lossReasonCode: z.string().max(32).nullish(),
          version,
        })
        .parse(request.body);
      const canReopen = currentUser(request).permissions.has(perm.leadReopen);
      return command(request, reply, async (tx) =>
        ok(await service.moveStage(id, input, expected, canReopen, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/crm/leads/:id/visits',
    { preHandler: requirePermission(perm.visitManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ visitDate: date, notes: z.string().max(4000).nullish() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await service.addVisit(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/crm/leads/:id/follow-ups',
    { preHandler: requirePermission(perm.followupManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ dueDate: date, note: optionalText, assignedTo: z.uuid().optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await service.addFollowUp(id, input, actorOf(request), tx)),
      );
    },
  );

  // Follow-ups ---------------------------------------------------------------------------------

  app.get('/crm/follow-ups', { preHandler: requirePermission(perm.leadRead) }, (request) => {
    const query = z
      .object({
        leadId: z.uuid().optional(),
        assignedTo: z.uuid().optional(),
        status: z.enum(['open', 'done', 'cancelled']).optional(),
        limit: pageFields.limit,
        offset: pageFields.offset,
      })
      .parse(request.query);
    return service.listFollowUps(db, query);
  });

  app.post(
    '/crm/follow-ups/:id/done',
    { preHandler: requirePermission(perm.followupManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = z.object({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.completeFollowUp(id, expected, actorOf(request), tx)),
      );
    },
  );

  // Pipeline -----------------------------------------------------------------------------------

  app.get('/crm/pipeline', { preHandler: requirePermission(perm.leadRead) }, () =>
    service.pipeline(db),
  );
}

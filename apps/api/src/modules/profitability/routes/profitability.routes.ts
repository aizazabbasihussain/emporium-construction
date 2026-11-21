import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { profitabilityPermissions, thresholdScopes } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { ProfitabilityService } from '../service/profitability.service.js';
import type { Actor, Db } from '../types.js';

export interface ProfitabilityRouteDeps {
  db: Db;
  profitability: ProfitabilityService;
  platform: Platform;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const formats = z.enum(['json', 'csv', 'xlsx']).default('json');
const percent = z.string().regex(/^-?\d+(\.\d{1,4})?$/);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const portfolioQuery = z.object({
  asOf: date.optional(),
  status: z.string().min(1).max(40).optional(),
  format: formats,
});
const projectQuery = z.object({ asOf: date.optional(), format: formats });
const forecastBody = z.object({
  costToComplete: z.string().min(1).max(30),
  note: z.string().max(500).optional(),
  forecastDate: date.optional(),
});
const thresholdFields = {
  marginFloorPercent: percent,
  overspendPercent: percent,
  receivableAgeDays: z.number().int().min(0).max(36500),
  active: z.boolean().optional(),
};
const thresholdCreate = z.object({
  scope: z.enum(thresholdScopes),
  projectId: z.uuid().optional(),
  ...thresholdFields,
});
const thresholdUpdate = z.object({ ...thresholdFields, version: z.number().int().min(1) });

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The profitability endpoints (spec P2-08 section 5). */
export function registerProfitabilityRoutes(
  app: FastifyInstance,
  deps: ProfitabilityRouteDeps,
): void {
  const { db, profitability, platform } = deps;

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

  const send = (
    reply: FastifyReply,
    file: { contentType: string; fileName: string; body: string | Buffer },
  ) =>
    reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body);

  // The permission is checked before the input, so a caller without it learns nothing from a
  // validation message. The service checks it again (defence in depth).
  const canRead = { preHandler: requirePermission(profitabilityPermissions.read) };
  const canForecast = { preHandler: requirePermission(profitabilityPermissions.forecastSet) };
  const canManage = { preHandler: requirePermission(profitabilityPermissions.thresholdManage) };

  app.get('/profitability/projects', canRead, async (request, reply) => {
    const { format, ...filters } = portfolioQuery.parse(request.query);
    if (format === 'json')
      return profitability.listProjectFinancials(db, filters, actorOf(request));
    return send(reply, await profitability.download(db, filters, format, actorOf(request)));
  });

  app.get('/profitability/projects/:id', canRead, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { format, asOf } = projectQuery.parse(request.query);
    if (format === 'json')
      return profitability.getProjectFinancials(db, id, asOf, actorOf(request));
    return send(
      reply,
      await profitability.download(db, { projectId: id, asOf }, format, actorOf(request)),
    );
  });

  app.put('/profitability/projects/:id/forecast', canForecast, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = forecastBody.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await profitability.setForecast(id, body, actorOf(request), tx),
    }));
  });

  app.get('/profitability/alerts', canRead, async (request) => {
    const { onlyOpen } = z.object({ onlyOpen: flag.optional() }).parse(request.query);
    return profitability.listAlerts(db, { onlyOpen }, actorOf(request));
  });

  app.get('/profitability/thresholds', canRead, async (request) =>
    profitability.listThresholds(db, actorOf(request)),
  );

  app.post('/profitability/thresholds', canManage, async (request, reply) => {
    const body = thresholdCreate.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 201,
      body: await profitability.createThreshold(body, actorOf(request), tx),
    }));
  });

  app.put('/profitability/thresholds/:id', canManage, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = thresholdUpdate.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 200,
      body: await profitability.updateThreshold(id, body, actorOf(request), tx),
    }));
  });

  app.delete('/profitability/thresholds/:id', canManage, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(request.query);
    return command(request, reply, async (tx) => {
      await profitability.removeThreshold(id, version, actorOf(request), tx);
      return { statusCode: 200, body: { id } };
    });
  });
}

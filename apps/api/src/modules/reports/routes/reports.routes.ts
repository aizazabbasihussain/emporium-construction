import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { MAX_PAGE_SIZE, reportCodes, reportFormats } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { ReportsService } from '../service/reports.service.js';
import type { Actor, Db } from '../types.js';

export interface ReportsRouteDeps {
  db: Db;
  reports: ReportsService;
  platform: Platform;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** The filters every report understands; each report uses the ones that fit it. */
const filterShape = {
  projectId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  itemId: z.uuid().optional(),
  vendorId: z.uuid().optional(),
  ownership: z.enum(['company', 'client']).optional(),
  from: date.optional(),
  to: date.optional(),
  overdueOnly: flag.optional(),
  belowReorderOnly: flag.optional(),
};

const reportQuery = z.object({
  ...filterShape,
  format: z.enum(reportFormats).default('json'),
  sort: z.string().min(1).max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** A saved filter keeps only the filters of a report, as the same values the query takes. */
const savedFilterBody = z.object({
  reportCode: z.enum(reportCodes),
  name: z.string().min(1).max(100),
  filter: z.object({
    ...filterShape,
    overdueOnly: z.boolean().optional(),
    belowReorderOnly: z.boolean().optional(),
  }),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The report endpoints (spec P1-19 section 5). */
export function registerReportsRoutes(app: FastifyInstance, deps: ReportsRouteDeps): void {
  const { db, reports, platform } = deps;

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

  app.get('/reports/saved-filters', async (request) =>
    reports.listFilters(
      db,
      actorOf(request),
      z.object({ reportCode: z.enum(reportCodes).optional() }).parse(request.query).reportCode,
    ),
  );

  app.post('/reports/saved-filters', async (request, reply) => {
    const body = savedFilterBody.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 201,
      body: await reports.saveFilter(body, actorOf(request), tx),
    }));
  });

  app.delete('/reports/saved-filters/:id', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(request.query);
    return command(request, reply, async (tx) => {
      await reports.removeFilter(id, version, actorOf(request), tx);
      return { statusCode: 200, body: { id } };
    });
  });

  app.get('/reports/:code', async (request, reply) => {
    const { code } = z.object({ code: z.enum(reportCodes) }).parse(request.params);
    const { format, sort, direction, limit, offset, ...filters } = reportQuery.parse(request.query);
    const query = { filters, sort, direction, limit, offset };
    if (format === 'json') return reports.run(db, code, query, actorOf(request));
    const file = await reports.download(db, code, query, format, actorOf(request));
    return reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .send(file.body);
  });
}

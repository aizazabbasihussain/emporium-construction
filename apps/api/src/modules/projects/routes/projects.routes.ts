import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  costStatuses,
  projectSectors,
  projectStatuses,
  projectsPermissions as perm,
  taskStatuses,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Projects } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ProjectsRouteDeps {
  db: Db;
  projects: Projects;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const taskParams = z.object({ id: z.uuid(), taskId: z.uuid() });
const version = z.number().int().min(1);
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const projectFields = {
  name: z.string().min(1).max(300),
  locationId: z.uuid().nullish(),
  siteAddress: z.string().max(1000).nullish(),
  startDate: day.nullish(),
  plannedEndDate: day.nullish(),
  projectManagerId: z.uuid().nullish(),
};

const createBody = z.object({
  ...projectFields,
  partyId: z.uuid(),
  sector: z.enum(projectSectors),
  originalContractValue: money,
});
const updateBody = z.object({ ...z.object(projectFields).partial().shape, version });
const statusBody = z.object({ status: z.enum(projectStatuses), version });
const budgetBody = z.object({
  version,
  lines: z
    .array(
      z.object({
        costCodeId: z.uuid(),
        description: z.string().max(300).optional(),
        budgetAmount: money,
      }),
    )
    .max(500),
});
const taskFields = {
  name: z.string().min(1).max(300),
  assignedToUser: z.uuid().nullish(),
  startDate: day.nullish(),
  dueDate: day.nullish(),
  status: z.enum(taskStatuses).optional(),
  percentComplete: z.number().int().optional(),
};
const taskCreateBody = z.object(taskFields);
const taskUpdateBody = z.object({ ...z.object(taskFields).partial().shape, version });
const supervisorsBody = z.object({
  supervisors: z
    .array(z.object({ userId: z.uuid(), fromDate: day.optional(), toDate: day.nullish() }))
    .max(50),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The projects endpoints (spec P1-09 section 5). */
export function registerProjectsRoutes(app: FastifyInstance, deps: ProjectsRouteDeps): void {
  const { db, projects, platform } = deps;
  const { service, costing } = projects;

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

  app.get('/projects', { preHandler: requirePermission(perm.read) }, (request) =>
    service.list(
      db,
      z
        .object({
          q: z.string().max(100).optional(),
          status: z.enum(projectStatuses).optional(),
          partyId: z.uuid().optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post('/projects', { preHandler: requirePermission(perm.create) }, (request, reply) => {
    const input = createBody.parse(request.body);
    return command(request, reply, async (tx) =>
      created(await service.create(input, actorOf(request), tx)),
    );
  });

  app.get('/projects/:id', { preHandler: requirePermission(perm.read) }, (request) =>
    service.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.patch('/projects/:id', { preHandler: requirePermission(perm.update) }, (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { version: expected, ...patch } = updateBody.parse(request.body);
    return command(request, reply, async (tx) =>
      ok(await service.update(id, patch, expected, actorOf(request), tx)),
    );
  });

  app.post(
    '/projects/:id/status',
    { preHandler: requirePermission(perm.status) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { status, version: expected } = statusBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.transition(id, status, expected, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/projects/:id/summary',
    { preHandler: requirePermission(perm.costRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await service.get(db, id, actorOf(request));
      return costing.getCostSummary(db, { type: 'project', id });
    },
  );

  app.get('/projects/:id/budget', { preHandler: requirePermission(perm.read) }, (request) =>
    service.getBudget(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/projects/:id/budget',
    { preHandler: requirePermission(perm.budgetManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, lines } = budgetBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.replaceBudget(id, lines, expected, actorOf(request), tx)),
      );
    },
  );

  app.get('/projects/:id/tasks', { preHandler: requirePermission(perm.read) }, (request) =>
    service.listTasks(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/projects/:id/tasks',
    { preHandler: requirePermission(perm.taskManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = taskCreateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await service.createTask(id, input, actorOf(request), tx)),
      );
    },
  );

  app.patch(
    '/projects/:id/tasks/:taskId',
    { preHandler: requirePermission(perm.taskManage) },
    (request, reply) => {
      const { id, taskId } = taskParams.parse(request.params);
      const { version: expected, ...patch } = taskUpdateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.updateTask(id, taskId, patch, expected, actorOf(request), tx)),
      );
    },
  );

  app.put(
    '/projects/:id/supervisors',
    { preHandler: requirePermission(perm.update) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { supervisors } = supervisorsBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await service.setSupervisors(id, supervisors, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/projects/:id/cost-entries',
    { preHandler: requirePermission(perm.costRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await service.get(db, id, actorOf(request));
      return costing.listEntries(
        db,
        { type: 'project', id },
        z
          .object({
            status: z.enum(costStatuses).optional(),
            costCodeId: z.uuid().optional(),
            ...pageFields,
          })
          .parse(request.query),
      );
    },
  );
}

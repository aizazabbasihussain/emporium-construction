import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { approvalsPermissions } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Approvals } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface ApprovalsRouteDeps {
  db: Db;
  approvals: Approvals;
  platform: Platform;
}

const docType = z.string().regex(/^[a-z][a-z0-9_]*$/);
const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'Amount must be a number with up to 2 decimals');
const idParams = z.object({ id: z.uuid() });
const docTypeParams = z.object({ docType });

const requestBody = z.object({
  docType,
  docId: z.uuid(),
  amount,
  requesterId: z.uuid().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
});
const actionBody = z
  .object({
    comment: z.string().max(1000).nullish(),
    version: z.number().int().min(1).optional(),
  })
  .default({});
const step = z.object({
  stepNo: z.number().int().min(1),
  roleCode: z.string().min(1),
  minApprovers: z.number().int().min(1).default(1),
});
const rulesBody = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bands: z
    .array(
      z.object({
        minAmount: amount,
        maxAmount: amount.nullable(),
        steps: z.array(step),
      }),
    )
    .min(1),
});

interface CommandResult {
  statusCode: number;
  body: unknown;
}

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

/** The approval endpoints (spec P1-03 section 5). */
export function registerApprovalsRoutes(app: FastifyInstance, deps: ApprovalsRouteDeps): void {
  const { db, approvals, platform } = deps;

  const actorOf = (request: FastifyRequest): Actor => {
    const user = currentUser(request);
    return {
      userId: user.userId,
      roles: user.roles,
      scopes: user.scopes,
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

  app.post(
    '/approvals/requests',
    { preHandler: requirePermission(approvalsPermissions.ruleManage) },
    (request, reply) => {
      const body = requestBody.parse(request.body);
      const actor = actorOf(request);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await approvals.service.requestApproval(
          {
            docType: body.docType,
            docId: body.docId,
            amount: body.amount,
            requesterId: body.requesterId ?? actor.userId,
            context: body.context,
            requestId: request.id,
          },
          tx,
        ),
      }));
    },
  );

  app.get(
    '/approvals/inbox',
    { preHandler: requirePermission(approvalsPermissions.inboxRead) },
    async (request) => ({ items: await approvals.service.inbox(db, actorOf(request)) }),
  );

  app.get(
    '/approvals/requests/:id',
    { preHandler: requirePermission(approvalsPermissions.requestRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return approvals.service.getRequest(
        db,
        id,
        actorOf(request),
        currentUser(request).permissions.has(approvalsPermissions.ruleManage),
      );
    },
  );

  for (const action of ['approve', 'reject', 'return'] as const) {
    app.post(
      `/approvals/requests/:id/${action}`,
      { preHandler: requirePermission(approvalsPermissions.inboxRead) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const body = actionBody.parse(request.body);
        return command(request, reply, async (tx) => ({
          statusCode: 200,
          body: await approvals.service.act(
            id,
            action,
            { comment: body.comment ?? null, expectedVersion: body.version },
            actorOf(request),
            tx,
          ),
        }));
      },
    );
  }

  app.get(
    '/admin/approval-rules',
    { preHandler: requirePermission(approvalsPermissions.ruleManage) },
    async () => ({ items: await approvals.rules.listDocTypes(db) }),
  );

  app.get(
    '/admin/approval-rules/:docType',
    { preHandler: requirePermission(approvalsPermissions.ruleManage) },
    async (request) => {
      const params = docTypeParams.parse(request.params);
      return { docType: params.docType, sets: await approvals.rules.getRules(db, params.docType) };
    },
  );

  app.put(
    '/admin/approval-rules/:docType',
    { preHandler: requirePermission(approvalsPermissions.ruleManage) },
    (request, reply) => {
      const params = docTypeParams.parse(request.params);
      const body = rulesBody.parse(request.body);
      const actor = actorOf(request);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: {
          docType: params.docType,
          sets: await approvals.rules.replaceRules(params.docType, body, actor, tx),
        },
      }));
    },
  );
}

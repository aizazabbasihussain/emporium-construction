import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import { billingPermissions as perm, invoiceStatuses, supplyKinds } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import { renderInvoicePdf } from '../render/pdf.js';
import type { Billing } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface BillingRouteDeps {
  db: Db;
  billing: Billing;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const versionBody = z.object({ version });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const money = z.string().regex(/^\d{1,14}(\.\d{1,2})?$/);
const signedMoney = z.string().regex(/^-?\d{1,14}(\.\d{1,2})?$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

const invoiceFields = {
  source: z.string().min(1).max(60).optional(),
  scheduleIds: z.array(z.uuid()).max(100),
  invoiceDate: date,
  paymentDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().max(2000).optional(),
  supplyKind: z.enum(supplyKinds).optional(),
  nature: z.string().min(1).max(100).optional(),
};
const createBody = z.object({ projectId: z.uuid(), ...invoiceFields });
const updateBody = z.object({ ...invoiceFields, version });

const scheduleBody = z.object({
  stages: z
    .array(
      z.object({
        id: z.uuid().optional(),
        stageNo: z.number().int().min(1),
        name: z.string().min(1).max(200),
        amount: signedMoney,
      }),
    )
    .max(100),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The billing endpoints (spec P2-02 section 5). */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingRouteDeps): void {
  const { db, billing, platform } = deps;

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

  app.get(
    '/billing/schedule/:id',
    { preHandler: requirePermission(perm.scheduleRead) },
    (request) => billing.schedule.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/billing/schedule/:id',
    { preHandler: requirePermission(perm.scheduleManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { stages } = scheduleBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await billing.schedule.edit(id, stages, actorOf(request), tx)),
      );
    },
  );

  app.get('/billing/invoices', { preHandler: requirePermission(perm.invoiceRead) }, (request) =>
    billing.invoices.list(
      db,
      z
        .object({
          projectId: z.uuid().optional(),
          status: z.enum(invoiceStatuses).optional(),
          ...pageFields,
        })
        .parse(request.query),
      actorOf(request),
    ),
  );

  app.post(
    '/billing/invoices',
    { preHandler: requirePermission(perm.invoiceCreate) },
    (request, reply) => {
      const { projectId, ...input } = createBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await billing.invoices.create(projectId, input, actorOf(request), tx)),
      );
    },
  );

  app.get('/billing/invoices/:id', { preHandler: requirePermission(perm.invoiceRead) }, (request) =>
    billing.invoices.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.put(
    '/billing/invoices/:id',
    { preHandler: requirePermission(perm.invoiceCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = updateBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await billing.invoices.update(id, input, expected, actorOf(request), tx)),
      );
    },
  );

  app.delete(
    '/billing/invoices/:id',
    { preHandler: requirePermission(perm.invoiceCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) =>
        ok(await billing.invoices.cancel(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/billing/invoices/:id/preview',
    { preHandler: requirePermission(perm.invoiceRead) },
    (request) => billing.invoices.preview(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/billing/invoices/:id/submit',
    { preHandler: requirePermission(perm.invoiceCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await billing.invoices.submit(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/billing/invoices/:id/issue',
    { preHandler: requirePermission(perm.invoiceIssue) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await billing.invoices.issue(id, expected, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/billing/invoices/:id/cancel-by-credit-note',
    { preHandler: requirePermission(perm.creditNoteCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(1).max(1000) }).parse(request.body);
      return command(request, reply, async (tx) =>
        created(await billing.creditNotes.cancelByCreditNote(id, reason, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/billing/invoices/:id/credit-notes',
    { preHandler: requirePermission(perm.invoiceRead) },
    (request) =>
      billing.creditNotes.listForInvoice(db, idParams.parse(request.params).id, actorOf(request)),
  );

  app.post(
    '/billing/invoices/:id/credit-notes',
    { preHandler: requirePermission(perm.creditNoteCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = z
        .object({ reason: z.string().min(1).max(1000), baseAmount: money.optional() })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await billing.creditNotes.create(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/billing/credit-notes/:id',
    { preHandler: requirePermission(perm.invoiceRead) },
    (request) => billing.creditNotes.get(db, idParams.parse(request.params).id, actorOf(request)),
  );

  for (const action of ['submit', 'issue'] as const) {
    app.post(
      `/billing/credit-notes/:id/${action}`,
      { preHandler: requirePermission(perm.creditNoteCreate) },
      (request, reply) => {
        const { id } = idParams.parse(request.params);
        const { version: expected } = versionBody.parse(request.body);
        return command(request, reply, async (tx) =>
          ok(await billing.creditNotes[action](id, expected, actorOf(request), tx)),
        );
      },
    );
  }

  app.get('/billing/advances', { preHandler: requirePermission(perm.invoiceRead) }, (request) =>
    billing.advances.list(
      db,
      z.object({ projectId: z.uuid() }).parse(request.query).projectId,
      actorOf(request),
    ),
  );

  app.post(
    '/billing/advances',
    { preHandler: requirePermission(perm.advanceManage) },
    (request, reply) => {
      const input = z
        .object({
          projectId: z.uuid(),
          amount: money,
          invoiceDate: date,
          notes: z.string().max(2000).optional(),
        })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        created(await billing.advances.request(input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/billing/invoices/:id/print-model',
    { preHandler: requirePermission(perm.invoiceRead) },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await billing.invoices.get(db, id, actorOf(request));
      return billing.invoices.printModel(db, id);
    },
  );

  app.get(
    '/billing/invoices/:id/pdf',
    { preHandler: requirePermission(perm.invoiceRead) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const invoice = await billing.invoices.get(db, id, actorOf(request));
      const model = await billing.invoices.printModel(db, id);
      return reply
        .type('application/pdf')
        .header(
          'content-disposition',
          `inline; filename="${(invoice.number ?? `draft-${invoice.id}`).replace(/[^A-Za-z0-9_-]/g, '-')}.pdf"`,
        )
        .send(renderInvoicePdf(model));
    },
  );

  app.get(
    '/billing/projects/:id/summary',
    { preHandler: requirePermission(perm.invoiceRead) },
    (request) => billing.advances.summary(db, idParams.parse(request.params).id, actorOf(request)),
  );
}

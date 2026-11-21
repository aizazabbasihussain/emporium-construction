import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  costDifferenceTreatments,
  payrollPaymentMethods,
  payrollPermissions as perm,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Payroll } from '../index.js';
import { renderPayslipsPdf } from '../render/pdf.js';
import type { Actor, Db } from '../types.js';

export interface PayrollRouteDeps {
  db: Db;
  payroll: Payroll;
  platform: Platform;
}

const idParams = z.object({ id: z.uuid() });
const version = z.number().int().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lineIds = z.array(z.uuid()).min(1).max(500).optional();
const treatment = z.enum(costDifferenceTreatments).optional();

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createBody = z.object({ periodId: z.uuid(), costDifferenceTreatment: treatment });
const finalizeBody = z.object({ version, costDifferenceTreatment: treatment });
const reasonBody = z.object({ reason: z.string().min(1).max(1000), version });
const requestBody = z.object({ lineIds });
const payBody = z.object({
  lineIds,
  paymentDate: date,
  method: z.enum(payrollPaymentMethods),
  accountId: z.uuid(),
  approvalDocId: z.uuid().optional(),
  version,
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The payroll endpoints (spec P2-07 section 5). */
export function registerPayrollRoutes(app: FastifyInstance, deps: PayrollRouteDeps): void {
  const { db, payroll, platform } = deps;
  const { runs, payments, payslips } = payroll;

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

  app.get('/payroll/runs', { preHandler: requirePermission(perm.runRead) }, (request) =>
    runs.list(db, pageQuery.parse(request.query)),
  );

  app.post('/payroll/runs', { preHandler: requirePermission(perm.runCreate) }, (request, reply) => {
    const input = createBody.parse(request.body);
    return command(request, reply, async (tx) =>
      created(await runs.create(input, actorOf(request), tx)),
    );
  });

  app.get('/payroll/runs/:id', { preHandler: requirePermission(perm.runRead) }, (request) =>
    runs.get(db, idParams.parse(request.params).id),
  );

  app.get('/payroll/runs/:id/lines', { preHandler: requirePermission(perm.runRead) }, (request) =>
    runs.lines(db, idParams.parse(request.params).id),
  );

  app.post(
    '/payroll/runs/:id/finalize',
    { preHandler: requirePermission(perm.runFinalize) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = finalizeBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await runs.finalize(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payroll/runs/:id/reopen',
    { preHandler: requirePermission(perm.runReopen) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = reasonBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await runs.reopen(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payroll/runs/:id/payment-requests',
    { preHandler: requirePermission(perm.paymentCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = requestBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await payments.requestPayment(id, input, actorOf(request), tx)),
      );
    },
  );

  app.post(
    '/payroll/runs/:id/pay',
    { preHandler: requirePermission(perm.paymentCreate) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = payBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await payments.pay(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/payroll/runs/:id/payments',
    { preHandler: requirePermission(perm.runRead) },
    (request) => payments.listPayments(db, idParams.parse(request.params).id),
  );

  app.post(
    '/payroll/payments/:id/reverse',
    { preHandler: requirePermission(perm.paymentReverse) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = reasonBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await payments.reverse(id, input, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/payroll/runs/:id/payslips.pdf',
    { preHandler: requirePermission(perm.payslipRead) },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const slips = await payslips.ofRun(db, id);
      return reply
        .type('application/pdf')
        .header('content-disposition', `inline; filename="payslips-${id}.pdf"`)
        .send(renderPayslipsPdf(slips));
    },
  );

  app.get('/payroll/payslips/:id', { preHandler: requirePermission(perm.payslipRead) }, (request) =>
    payslips.get(db, idParams.parse(request.params).id, null),
  );

  app.get('/payroll/unpaid', { preHandler: requirePermission(perm.runRead) }, () =>
    payments.unpaid(db),
  );
}

import { createHash } from 'node:crypto';
import { ValidationError } from '@emporium/domain';
import {
  supplyKinds,
  taxPermissions as perm,
  taxRegions,
  taxRuleStatuses,
  withholdingBases,
  withholdingDirections,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { Tax } from '../index.js';
import type { Actor, Db } from '../types.js';

export interface TaxRouteDeps {
  db: Db;
  tax: Tax;
  platform: Platform;
}

const rate = z.string().regex(/^\d+(\.\d{1,4})?$/);
const text = z.string().trim().min(1).max(200);
const note = z.string().trim().max(500).nullish();

const rangeFields = {
  authorityCode: z.string().trim().min(1).max(20),
  effectiveFrom: z.iso.date(),
  effectiveTo: z.iso.date().nullish(),
  note,
};

const salesRuleBody = z.object({
  ...rangeFields,
  supplyKind: z.enum(supplyKinds),
  nature: text.nullish(),
  ratePercent: rate,
  taxCode: text,
});

const withholdingBody = z.object({
  ...rangeFields,
  direction: z.enum(withholdingDirections),
  partyType: text.nullish(),
  nature: text,
  ratePercent: rate,
  base: z.enum(withholdingBases),
});

const regionBody = z.object({
  ...rangeFields,
  region: z.enum(taxRegions),
  supplyKind: z.enum(supplyKinds),
});

const statusQuery = z.object({ status: z.enum(taxRuleStatuses).optional() });

const money = z.string().regex(/^-?\d+(\.\d+)?$/);

const calculateBody = z.object({
  locationId: z.uuid(),
  supplyKind: z.enum(supplyKinds),
  date: z.iso.date(),
  pricesIncludeTax: z.boolean().optional(),
  lines: z
    .array(z.object({ id: text, amount: money, nature: text.nullish() }))
    .min(1)
    .max(500),
});

const reportQuery = z.object({
  authority: z.string().trim().min(1).max(20),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The tax endpoints (spec P2-01 section 5). */
export function registerTaxRoutes(app: FastifyInstance, deps: TaxRouteDeps): void {
  const { db, tax, platform } = deps;

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

  app.get('/tax/rules', { preHandler: requirePermission(perm.ruleRead) }, async (request) => {
    const { status } = statusQuery.parse(request.query);
    return {
      items: await tax.rules.listSalesRules(db, status),
      authorities: await tax.rules.authorities(db),
      regionMap: await tax.rules.listRegionMap(db, status),
      settings: await tax.rules.settings(db),
    };
  });

  app.post('/tax/rules', { preHandler: requirePermission(perm.ruleManage) }, (request, reply) => {
    const input = salesRuleBody.parse(request.body);
    return command(request, reply, async (tx) => ({
      statusCode: 201,
      body: await tax.rules.requestSalesRule(input, actorOf(request), tx),
    }));
  });

  app.post(
    '/tax/region-map',
    { preHandler: requirePermission(perm.ruleManage) },
    (request, reply) => {
      const input = regionBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await tax.rules.requestRegionEntry(input, actorOf(request), tx),
      }));
    },
  );

  app.get(
    '/tax/withholding-rules',
    { preHandler: requirePermission(perm.ruleRead) },
    async (request) => ({
      items: await tax.rules.listWithholdingRules(db, statusQuery.parse(request.query).status),
    }),
  );

  app.post(
    '/tax/withholding-rules',
    { preHandler: requirePermission(perm.ruleManage) },
    (request, reply) => {
      const input = withholdingBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await tax.rules.requestWithholdingRule(input, actorOf(request), tx),
      }));
    },
  );

  app.post('/tax/calculate', { preHandler: requirePermission(perm.ruleRead) }, (request) =>
    tax.calculateSalesTax(db, calculateBody.parse(request.body)),
  );

  app.get('/tax/reports', { preHandler: requirePermission(perm.reportRead) }, (request) => {
    const query = reportQuery.parse(request.query);
    return tax.taxReportData(db, query.authority, query.month);
  });
}

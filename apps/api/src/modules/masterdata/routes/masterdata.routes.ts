import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '@emporium/domain';
import {
  costCodeKinds,
  itemKinds,
  masterdataPermissions as perm,
  partyRoles,
  partyStatuses,
  regions,
  registrationTypes,
  taxKinds,
  unitKinds,
} from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requirePermission } from '../../identity/index.js';
import type { Platform } from '../../platform/index.js';
import type { MasterData } from '../index.js';
import { paginateList } from '../service/support.js';
import type { Actor, Db } from '../types.js';

export interface MasterDataRouteDeps {
  db: Db;
  masterData: MasterData;
  platform: Platform;
}

// Shared request pieces ------------------------------------------------------------------------

const idParams = z.object({ id: z.uuid() });
const codeParams = z.object({ code: z.string().min(1).max(40) });
const versionQuery = z.object({ version: z.coerce.number().int().min(1) });
const version = z.number().int().min(1);
const date = z.iso.date();
const text = z.string().max(500);
const optionalText = text.nullish();
const decimal = z.string().regex(/^\d{1,14}(\.\d{1,6})?$/);

const pageFields = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  direction: z.enum(['asc', 'desc']).default('asc'),
};
const listQuery = z.object({
  q: z.string().max(100).optional(),
  sort: z.string().optional(),
  ...pageFields,
});

const partyBody = z.object({
  name: text.min(1),
  legalName: optionalText,
  roles: z.array(z.enum(partyRoles)).min(1),
  ntn: optionalText,
  strn: optionalText,
  cnic: optionalText,
  phone: optionalText,
  email: optionalText,
  address: optionalText,
  city: optionalText,
  status: z.enum(partyStatuses).optional(),
  notes: z.string().max(2000).nullish(),
  contacts: z
    .array(
      z.object({ name: text.min(1), phone: optionalText, email: optionalText, role: optionalText }),
    )
    .max(50)
    .optional(),
  confirmDuplicate: z.boolean().default(false),
});

const partyQuery = z.object({
  q: z.string().max(100).optional(),
  role: z.enum(partyRoles).optional(),
  status: z.enum(partyStatuses).optional(),
  sort: z.enum(['code', 'name', 'city', 'status']).default('name'),
  ...pageFields,
});

const itemBody = z.object({
  code: text.min(1),
  name: text.min(1),
  categoryId: z.uuid().nullish(),
  unitCode: z.string().min(1).max(16),
  itemKind: z.enum(itemKinds),
  stockable: z.boolean().optional(),
  defaultTaxKind: z.enum(taxKinds),
  reorderLevel: z
    .string()
    .regex(/^\d{1,14}(\.\d{1,4})?$/)
    .nullish(),
  active: z.boolean().optional(),
});

const itemQuery = z.object({
  q: z.string().max(100).optional(),
  categoryId: z.uuid().optional(),
  kind: z.enum(itemKinds).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sort: z.enum(['code', 'name', 'kind']).default('code'),
  ...pageFields,
});

const priceBody = z.object({
  vendorId: z.uuid(),
  itemId: z.uuid(),
  unitCode: z.string().min(1).max(16),
  rate: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
  validFrom: date,
  validTo: date.nullish(),
});

const registrationBody = z.object({
  authority: z.string().min(2).max(20),
  registrationType: z.enum(registrationTypes),
  number: text.min(1),
  validFrom: date,
  validTo: date.nullish(),
});

const locationBody = z.object({
  name: text.min(1),
  region: z.enum(regions),
  city: text.min(1),
});

const hashRequest = (method: string, url: string, body: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify([method.toUpperCase(), url, body ?? null]))
    .digest('hex');

interface CommandResult {
  statusCode: number;
  body: unknown;
}

/** The master data endpoints (spec P1-05 section 5). */
export function registerMasterDataRoutes(app: FastifyInstance, deps: MasterDataRouteDeps): void {
  const { db, masterData, platform } = deps;
  const { parties, catalog, costing, company } = masterData;

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
  const gone: CommandResult = { statusCode: 204, body: null };

  // Company profile and tax registrations ------------------------------------------------------

  app.get('/master/company', { preHandler: requirePermission(perm.referenceRead) }, async () => {
    const found = await company.getCompany(db);
    if (found === null) throw new NotFoundError('company_not_found', 'No company profile yet');
    return found;
  });

  const companyBody = z.object({
    name: text.min(1),
    address: optionalText,
    phone: optionalText,
    email: optionalText,
    logoFileId: z.uuid().nullish(),
    version: version.optional(),
  });
  app.put(
    '/master/company',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const { version: expected, ...input } = companyBody.parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await company.saveCompany(input, expected, actorOf(request), tx)),
      );
    },
  );

  app.get(
    '/master/tax-registrations',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) => {
      const query = listQuery.parse(request.query);
      return paginateList(
        await company.listRegistrations(db),
        query,
        (r) => [r.authority, r.registrationType, r.number],
        {
          authority: (r) => r.authority,
          type: (r) => r.registrationType,
          validFrom: (r) => r.validFrom,
        },
      );
    },
  );
  app.get(
    '/master/tax-registrations/current',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) => {
      const query = z
        .object({
          authority: z.string().min(2).max(20),
          date: date.optional(),
          type: z.enum(registrationTypes).optional(),
        })
        .parse(request.query);
      const found = await company.getRegistration(db, query.authority, {
        ...(query.date === undefined ? {} : { date: query.date }),
        ...(query.type === undefined ? {} : { type: query.type }),
      });
      if (found === null) throw new NotFoundError('registration_not_found', 'No registration');
      return found;
    },
  );
  app.post(
    '/master/tax-registrations',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const input = registrationBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await company.createRegistration(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/tax-registrations/:id',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = registrationBody
        .extend({ version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await company.updateRegistration(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/tax-registrations/:id',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await company.removeRegistration(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Locations ----------------------------------------------------------------------------------

  app.get(
    '/master/locations',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) => {
      const query = listQuery.extend({ region: z.enum(regions).optional() }).parse(request.query);
      return paginateList(
        await company.listLocations(db, query.region),
        query,
        (l) => [l.name, l.city],
        { name: (l) => l.name, city: (l) => l.city, region: (l) => l.region },
      );
    },
  );
  app.post(
    '/master/locations',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const input = locationBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await company.createLocation(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/locations/:id',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = locationBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await company.updateLocation(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/locations/:id',
    { preHandler: requirePermission(perm.companyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await company.removeLocation(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Parties ------------------------------------------------------------------------------------

  app.get('/master/parties', { preHandler: requirePermission(perm.partyRead) }, async (request) =>
    parties.search(db, partyQuery.parse(request.query)),
  );
  app.post(
    '/master/parties/check-duplicate',
    { preHandler: requirePermission(perm.partyRead) },
    async (request) => {
      const query = z
        .object({
          name: text.min(1),
          phone: optionalText,
          ntn: optionalText,
          cnic: optionalText,
          excludeId: z.uuid().optional(),
        })
        .parse(request.body);
      return { duplicates: await parties.checkDuplicate(db, query) };
    },
  );
  app.get(
    '/master/parties/:id',
    { preHandler: requirePermission(perm.partyRead) },
    async (request) => parties.get(db, idParams.parse(request.params).id),
  );
  app.post(
    '/master/parties',
    { preHandler: requirePermission(perm.partyManage) },
    (request, reply) => {
      const { confirmDuplicate, ...input } = partyBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await parties.create(input, actorOf(request), tx, { confirmDuplicate })),
      );
    },
  );
  app.put(
    '/master/parties/:id',
    { preHandler: requirePermission(perm.partyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const {
        version: expected,
        confirmDuplicate,
        ...input
      } = partyBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await parties.update(id, input, expected, actorOf(request), tx, { confirmDuplicate })),
      );
    },
  );
  app.delete(
    '/master/parties/:id',
    { preHandler: requirePermission(perm.partyManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await parties.remove(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Units and conversions ----------------------------------------------------------------------

  app.get('/master/units', { preHandler: requirePermission(perm.referenceRead) }, async (request) =>
    paginateList(
      await catalog.listUnits(db),
      listQuery.parse(request.query),
      (u) => [u.code, u.name],
      { code: (u) => u.code, name: (u) => u.name, kind: (u) => u.kind },
    ),
  );
  app.get(
    '/master/units/convert',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) => {
      const query = z
        .object({ quantity: decimal, from: z.string().min(1), to: z.string().min(1) })
        .parse(request.query);
      return {
        quantity: await catalog.convert(db, query.quantity, query.from, query.to),
        unit: query.to,
      };
    },
  );
  const unitBody = z.object({
    code: z.string().min(1).max(16),
    name: text.min(1),
    kind: z.enum(unitKinds),
  });
  app.post(
    '/master/units',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const input = unitBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await catalog.createUnit(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/units/:code',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const {
        version: expected,
        name,
        kind,
      } = unitBody.omit({ code: true }).extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await catalog.updateUnit(code, { name, kind }, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/units/:code',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await catalog.removeUnit(code, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  const conversionBody = z.object({
    fromUnit: z.string().min(1).max(16),
    toUnit: z.string().min(1).max(16),
    factor: decimal,
  });
  app.get(
    '/master/unit-conversions',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) =>
      paginateList(
        await catalog.listConversions(db),
        listQuery.parse(request.query),
        (c) => [c.fromUnit, c.toUnit],
        { from: (c) => c.fromUnit, to: (c) => c.toUnit },
      ),
  );
  app.post(
    '/master/unit-conversions',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const input = conversionBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await catalog.createConversion(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/unit-conversions/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { factor, version: expected } = z
        .object({ factor: decimal, version })
        .parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await catalog.updateConversion(id, factor, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/unit-conversions/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await catalog.removeConversion(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Item categories and items ------------------------------------------------------------------

  const categoryBody = z.object({
    code: text.min(1),
    name: text.min(1),
    parentId: z.uuid().nullish(),
  });
  app.get(
    '/master/item-categories',
    { preHandler: requirePermission(perm.itemRead) },
    async (request) =>
      paginateList(
        await catalog.listCategories(db),
        listQuery.parse(request.query),
        (c) => [c.code, c.name],
        { code: (c) => c.code, name: (c) => c.name },
      ),
  );
  app.post(
    '/master/item-categories',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const input = categoryBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await catalog.createCategory(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/item-categories/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = categoryBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await catalog.updateCategory(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/item-categories/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await catalog.removeCategory(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  app.get('/master/items', { preHandler: requirePermission(perm.itemRead) }, async (request) =>
    catalog.searchItems(db, itemQuery.parse(request.query)),
  );
  app.get('/master/items/:id', { preHandler: requirePermission(perm.itemRead) }, async (request) =>
    catalog.getItem(db, idParams.parse(request.params).id),
  );
  app.post(
    '/master/items',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const input = itemBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await catalog.createItem(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/items/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = itemBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await catalog.updateItem(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/items/:id',
    { preHandler: requirePermission(perm.itemManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await catalog.removeItem(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Cost codes ---------------------------------------------------------------------------------

  const costCodeBody = z.object({
    code: text.min(1),
    name: text.min(1),
    parentId: z.uuid().nullish(),
    kind: z.enum(costCodeKinds),
    active: z.boolean().optional(),
  });
  app.get(
    '/master/cost-codes',
    { preHandler: requirePermission(perm.referenceRead) },
    async (request) =>
      paginateList(
        await costing.listCostCodes(db),
        listQuery.parse(request.query),
        (c) => [c.code, c.name],
        { code: (c) => c.code, name: (c) => c.name, kind: (c) => c.kind },
      ),
  );
  app.post(
    '/master/cost-codes',
    { preHandler: requirePermission(perm.costcodeManage) },
    (request, reply) => {
      const input = costCodeBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await costing.createCostCode(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/cost-codes/:id',
    { preHandler: requirePermission(perm.costcodeManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = costCodeBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await costing.updateCostCode(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/cost-codes/:id',
    { preHandler: requirePermission(perm.costcodeManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await costing.removeCostCode(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );

  // Vendor prices ------------------------------------------------------------------------------

  app.get(
    '/master/vendor-prices',
    { preHandler: requirePermission(perm.priceRead) },
    async (request) => {
      const query = z
        .object({
          vendorId: z.uuid().optional(),
          itemId: z.uuid().optional(),
          onDate: date.optional(),
          limit: pageFields.limit,
          offset: pageFields.offset,
        })
        .parse(request.query);
      return costing.searchPrices(db, query);
    },
  );
  app.post(
    '/master/vendor-prices',
    { preHandler: requirePermission(perm.priceManage) },
    (request, reply) => {
      const input = priceBody.parse(request.body);
      return command(request, reply, async (tx) =>
        created(await costing.createPrice(input, actorOf(request), tx)),
      );
    },
  );
  app.put(
    '/master/vendor-prices/:id',
    { preHandler: requirePermission(perm.priceManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected, ...input } = priceBody.extend({ version }).parse(request.body);
      return command(request, reply, async (tx) =>
        ok(await costing.updatePrice(id, input, expected, actorOf(request), tx)),
      );
    },
  );
  app.delete(
    '/master/vendor-prices/:id',
    { preHandler: requirePermission(perm.priceManage) },
    (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { version: expected } = versionQuery.parse(request.query);
      return command(request, reply, async (tx) => {
        await costing.removePrice(id, expected, actorOf(request), tx);
        return gone;
      });
    },
  );
}

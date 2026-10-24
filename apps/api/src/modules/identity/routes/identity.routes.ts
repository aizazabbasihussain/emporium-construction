import { createHash } from 'node:crypto';
import { UnauthorizedError, ValidationError } from '@emporium/domain';
import { identityPermissions, locales, scopeTypes } from '@emporium/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Identity } from '../index.js';
import type { Db, UserDto } from '../types.js';
import { currentUser, requireAdminRole, requirePermission } from './guard.js';

export interface IdentityRouteDeps {
  db: Db;
  identity: Identity;
}

const idParams = z.object({ id: z.uuid() });
const codeParams = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const version = z.number().int().min(1);

const meBody = z.object({ locale: z.enum(locales), version });
const createBody = z.object({
  email: z.email().max(254),
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(1).max(30).nullish(),
  roles: z.array(z.string().min(1)).max(20).default([]),
});
const patchBody = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(1).max(30).nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    version,
  })
  .refine((body) => Object.keys(body).length > 1, { message: 'Nothing to change' });
const rolesBody = z.object({ roles: z.array(z.string().min(1)).max(20), version });
const scopesBody = z.object({
  scopes: z.array(z.object({ type: z.enum(scopeTypes), id: z.uuid() })).max(500),
  version,
});
const permissionsBody = z.object({ permissions: z.array(z.string().min(1)).max(500) });

/** Authentication for every route except /health (BR-1, AC-1), then the identity endpoints. */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  const { db, identity } = deps;

  app.addHook('onRequest', async (request) => {
    if (request.method === 'OPTIONS' || request.url.split('?')[0] === '/health') return;
    const header = request.headers.authorization;
    const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
    if (match === null) throw new UnauthorizedError('missing_token', 'Bearer token required');
    request.user = await identity.auth.authenticate(db, match[1] as string);
  });

  const context = (request: FastifyRequest) => ({
    actorUserId: currentUser(request).userId,
    requestId: request.id,
  });

  /** Runs a mutation in one transaction; with an Idempotency-Key header a retry replays the first response. */
  const command = async (
    request: FastifyRequest,
    reply: FastifyReply,
    run: (tx: Db) => Promise<{ statusCode: number; body: unknown }>,
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
        : await identity.platform.idempotency.execute(
            db,
            {
              key,
              userId: currentUser(request).userId,
              requestHash: createHash('sha256')
                .update(JSON.stringify([request.method, request.url, request.body ?? null]))
                .digest('hex'),
            },
            run,
          );
    return reply.status(result.statusCode).send(result.body);
  };

  const profile = (user: ReturnType<typeof currentUser>) => ({
    id: user.userId,
    email: user.email,
    fullName: user.fullName,
    locale: user.locale,
    version: user.version,
    roles: [...user.roles],
    permissions: [...user.permissions].sort(),
    scopes: user.scopes,
  });

  app.get('/me', async (request) => {
    const user = currentUser(request);
    await identity.users.recordLogin(user.userId, db);
    return profile(user);
  });

  app.patch('/me', async (request, reply) => {
    const user = currentUser(request);
    const body = meBody.parse(request.body);
    return command(request, reply, async (tx) => {
      const updated = await identity.users.setLocale(
        user.userId,
        body.locale,
        body.version,
        context(request),
        tx,
      );
      return { statusCode: 200, body: toProfile(user, updated) };
    });
  });

  const toProfile = (user: ReturnType<typeof currentUser>, updated: UserDto) => ({
    ...profile(user),
    locale: updated.locale,
    version: updated.version,
  });

  app.get(
    '/admin/users',
    { preHandler: requirePermission(identityPermissions.userRead) },
    async () => ({ items: await identity.users.list(db) }),
  );

  app.post(
    '/admin/users',
    { preHandler: [requirePermission(identityPermissions.userManage), requireAdminRole()] },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 201,
        body: await identity.users.create(
          { ...body, phone: body.phone ?? null },
          context(request),
          tx,
        ),
      }));
    },
  );

  app.patch(
    '/admin/users/:id',
    { preHandler: [requirePermission(identityPermissions.userManage), requireAdminRole()] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { fullName, phone, status, version: expected } = patchBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: await identity.users.update(
          id,
          {
            version: expected,
            ...(fullName === undefined ? {} : { fullName }),
            ...(phone === undefined ? {} : { phone }),
            ...(status === undefined ? {} : { status }),
          },
          context(request),
          tx,
        ),
      }));
    },
  );

  app.put(
    '/admin/users/:id/roles',
    { preHandler: [requirePermission(identityPermissions.userManage), requireAdminRole()] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = rolesBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: await identity.users.setRoles(id, body.roles, body.version, context(request), tx),
      }));
    },
  );

  app.put(
    '/admin/users/:id/scopes',
    { preHandler: [requirePermission(identityPermissions.userManage), requireAdminRole()] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = scopesBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: await identity.users.setScopes(id, body.scopes, body.version, context(request), tx),
      }));
    },
  );

  app.get(
    '/admin/roles',
    { preHandler: requirePermission(identityPermissions.userRead) },
    async () => ({
      items: await identity.roles.list(db),
      permissions: identity.registry.list(),
    }),
  );

  app.put(
    '/admin/roles/:code/permissions',
    { preHandler: [requirePermission(identityPermissions.roleManage), requireAdminRole()] },
    async (request, reply) => {
      const { code } = codeParams.parse(request.params);
      const body = permissionsBody.parse(request.body);
      return command(request, reply, async (tx) => ({
        statusCode: 200,
        body: await identity.roles.setPermissions(code, body.permissions, context(request), tx),
      }));
    },
  );
}

import { UnauthorizedError } from '@emporium/domain';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { assertAdmin, assertPermission } from '../policy/identity.policy.js';
import type { CurrentUser } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on every route except /health. */
    user?: CurrentUser;
  }
}

/** The authenticated caller of this request; 401 if there is none (for example on /health). */
export function currentUser(request: FastifyRequest): CurrentUser {
  if (!request.user) throw new UnauthorizedError();
  return request.user;
}

/** Route guard: `{ preHandler: requirePermission('identity.user.read') }` (BR-3). */
export function requirePermission(permission: string): preHandlerAsyncHookHandler {
  return async (request) => {
    assertPermission(request.user, permission);
  };
}

/** Route guard for administration that is limited to the admin role (BR-5). */
export function requireAdminRole(): preHandlerAsyncHookHandler {
  return async (request) => {
    assertAdmin(currentUser(request));
  };
}

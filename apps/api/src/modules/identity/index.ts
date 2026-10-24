// The only public entry point of the identity module.
import type { Platform } from '../platform/index.js';
import { createAuthService, type AuthService } from './service/auth.service.js';
import type { AuthVerifier } from './service/jwt-verifier.service.js';
import {
  createPermissionRegistry,
  type PermissionRegistry,
} from './service/permission-registry.service.js';
import { createRolesService, type RolesService } from './service/roles.service.js';
import { createUsersService, type UsersService } from './service/users.service.js';

export interface Identity {
  auth: AuthService;
  users: UsersService;
  roles: RolesService;
  registry: PermissionRegistry;
  platform: Platform;
  /** Modules declare the permission codes they own so role editors can offer and validate them. */
  registerPermissions: PermissionRegistry['register'];
  /** Idempotent: modules that own a role (for example `worker` in P1-22) register it at startup. */
  registerRole: RolesService['register'];
}

/** Wires identity on top of the kernel. Other modules receive the returned object. */
export function createIdentity(deps: {
  platform: Platform;
  verifier: AuthVerifier;
  newId: () => string;
}): Identity {
  const registry = createPermissionRegistry();
  const roles = createRolesService({ platform: deps.platform, registry });
  return {
    auth: createAuthService({ verifier: deps.verifier, platform: deps.platform }),
    users: createUsersService({ platform: deps.platform, newId: deps.newId }),
    roles,
    registry,
    platform: deps.platform,
    registerPermissions: (module, codes) => registry.register(module, codes),
    registerRole: (code, name, description, db) => roles.register(code, name, description, db),
  };
}

export { registerIdentityRoutes, type IdentityRouteDeps } from './routes/identity.routes.js';
export { currentUser, requireAdminRole, requirePermission } from './routes/guard.js';
export {
  assertPermission,
  assertScopeForRead,
  scopeFilterFor,
  userHasScope,
} from './policy/identity.policy.js';
export { createJwtVerifier } from './service/jwt-verifier.service.js';
export type {
  AuthVerifier,
  JwtVerifierOptions,
  VerifiedToken,
} from './service/jwt-verifier.service.js';
export type { CurrentUser, RoleDto, UserDto } from './types.js';

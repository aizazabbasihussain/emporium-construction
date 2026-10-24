import { DomainError, NotFoundError, UnauthorizedError } from '@emporium/domain';
import {
  ADMIN_ROLE,
  hasScope,
  scopeFilter,
  type ScopeFilter,
  type ScopeType,
} from '@emporium/domain/identity';
import type { CurrentUser } from '../types.js';

/** Throws 401 without a caller; 403 carrying the missing permission code (BR-3). */
export function assertPermission(
  user: CurrentUser | null | undefined,
  permission: string,
): CurrentUser {
  if (!user) throw new UnauthorizedError();
  if (!user.permissions.has(permission)) {
    throw new DomainError('forbidden', 'permission_denied', `Missing permission ${permission}`, {
      permission,
    });
  }
  return user;
}

/** BR-5: user and role administration is for the admin role even if a permission is granted wider. */
export function assertAdmin(user: CurrentUser): CurrentUser {
  if (!user.roles.includes(ADMIN_ROLE)) {
    throw new DomainError('forbidden', 'admin_only', 'Only an admin may do this', {
      role: ADMIN_ROLE,
    });
  }
  return user;
}

/** Whether the user may see the project or team (BR-4). Unscoped users may see everything. */
export const userHasScope = (user: CurrentUser, type: ScopeType, id: string): boolean =>
  hasScope(user, type, id);

/**
 * For reads: a record outside the user's scope is reported as missing, never as forbidden, so
 * its existence is not revealed (T-3).
 */
export function assertScopeForRead(user: CurrentUser, type: ScopeType, id: string): void {
  if (!userHasScope(user, type, id)) throw new NotFoundError();
}

/** The ids a list query must be limited to, or `all`. */
export const scopeFilterFor = (user: CurrentUser, type: ScopeType): ScopeFilter =>
  scopeFilter(user, type);

import { ForbiddenError, UnauthorizedError } from '@emporium/domain';
import { platformPermissions, type PlatformPermission } from '@emporium/shared';
import type { Principal } from '../types.js';

/** Throws 401 without a caller and 403 without the permission; returns the caller otherwise. */
export function requirePermission(
  principal: Principal | null | undefined,
  permission: PlatformPermission,
): Principal {
  if (!principal) throw new UnauthorizedError();
  if (!principal.permissions.has(permission)) throw new ForbiddenError();
  return principal;
}

export const canOverrideBackdating = (principal: Principal): boolean =>
  principal.permissions.has(platformPermissions.backdateOverride);

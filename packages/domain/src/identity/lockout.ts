import { RuleViolationError } from '../errors.js';

export const ADMIN_ROLE = 'admin';

export interface RoleChange {
  actorId: string;
  targetId: string;
  targetStatus: 'active' | 'disabled';
  currentRoles: readonly string[];
  newRoles: readonly string[];
  /** Active users who currently hold the admin role, including the target when it qualifies. */
  activeAdminCount: number;
}

/** BR-5: an admin cannot remove their own admin role, and the last active admin cannot be demoted. */
export function assertRoleChangeAllowed(change: RoleChange): void {
  const losesAdmin =
    change.currentRoles.includes(ADMIN_ROLE) && !change.newRoles.includes(ADMIN_ROLE);
  if (!losesAdmin) return;
  if (change.actorId === change.targetId) {
    throw new RuleViolationError(
      'cannot_remove_own_admin',
      'You cannot remove your own admin role',
    );
  }
  if (change.targetStatus === 'active' && change.activeAdminCount <= 1) {
    throw new RuleViolationError('last_admin', 'The last active admin cannot be demoted');
  }
}

export interface StatusChange {
  actorId: string;
  targetId: string;
  from: 'active' | 'disabled';
  to: 'active' | 'disabled';
  targetRoles: readonly string[];
  activeAdminCount: number;
}

/** BR-5: an admin cannot disable themselves, and the last active admin cannot be disabled. */
export function assertStatusChangeAllowed(change: StatusChange): void {
  if (change.from !== 'active' || change.to !== 'disabled') return;
  if (change.actorId === change.targetId) {
    throw new RuleViolationError('cannot_disable_self', 'You cannot disable yourself');
  }
  if (change.targetRoles.includes(ADMIN_ROLE) && change.activeAdminCount <= 1) {
    throw new RuleViolationError('last_admin', 'The last active admin cannot be disabled');
  }
}

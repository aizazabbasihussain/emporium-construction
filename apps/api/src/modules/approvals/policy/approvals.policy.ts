import { NotFoundError } from '@emporium/domain';
import { hasScope, type ScopeGrant } from '@emporium/domain/identity';
import type { Actor } from '../types.js';

/** The scope the owning module put in `context.scope`, if it is well formed (BR-7). */
export function scopeOf(context: Record<string, unknown>): ScopeGrant | null {
  const scope = context.scope as { type?: unknown; id?: unknown } | undefined;
  if (
    scope !== undefined &&
    (scope.type === 'project' || scope.type === 'team') &&
    typeof scope.id === 'string'
  ) {
    return { type: scope.type, id: scope.id };
  }
  return null;
}

/** Scope-limited roles only see documents of their own projects or teams; others are unaffected. */
export function isInScope(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  context: Record<string, unknown>,
) {
  const scope = scopeOf(context);
  return scope === null || hasScope(actor, scope.type, scope.id);
}

/** A request outside the caller's scope is reported as missing, never as forbidden. */
export function assertInScope(
  actor: Pick<Actor, 'roles' | 'scopes'>,
  context: Record<string, unknown>,
): void {
  if (!isInScope(actor, context)) throw new NotFoundError('request_not_found', 'Not found');
}

/** BR-7: a request is in the inbox of someone who holds the current step role and may see its scope. */
export function isInboxVisible(
  actor: Actor,
  request: { requesterId: string; currentRole: string | null; context: Record<string, unknown> },
): boolean {
  return (
    request.currentRole !== null &&
    actor.roles.includes(request.currentRole) &&
    request.requesterId !== actor.userId &&
    isInScope(actor, request.context)
  );
}

/** The requester, anyone holding a role of the rule, and rule managers may read a request. */
export function assertMayRead(
  actor: Actor,
  request: { requesterId: string; stepRoles: readonly string[]; context: Record<string, unknown> },
  canManage: boolean,
): void {
  if (canManage || request.requesterId === actor.userId) return;
  const isApprover = request.stepRoles.some((role) => actor.roles.includes(role));
  if (!isApprover || !isInScope(actor, request.context)) {
    throw new NotFoundError('request_not_found', 'Not found');
  }
}

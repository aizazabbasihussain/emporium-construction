import { hasScope, type ScopeGrant } from '@emporium/domain/identity';
import type { DirectoryUser } from '../types.js';

/** The scope the owning module put in an approval's `context.scope`, if it is well formed. */
export function scopeOf(context: Record<string, unknown> | undefined): ScopeGrant | null {
  const scope = context?.scope as { type?: unknown; id?: unknown } | undefined;
  if (
    scope !== undefined &&
    (scope.type === 'project' || scope.type === 'team') &&
    typeof scope.id === 'string'
  ) {
    return { type: scope.type, id: scope.id };
  }
  return null;
}

/**
 * BR-10: who should be told that a request waits at a step. Mirrors the approval inbox rule: holders
 * of the step role who may see the request's scope, never the requester.
 */
export function approverIds(
  holders: readonly DirectoryUser[],
  request: { requesterId: string; context?: Record<string, unknown> | undefined },
): string[] {
  const scope = scopeOf(request.context);
  return holders
    .filter((user) => user.id !== request.requesterId)
    .filter((user) => scope === null || hasScope(user, scope.type, scope.id))
    .map((user) => user.id);
}

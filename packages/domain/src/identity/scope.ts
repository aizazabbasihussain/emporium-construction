export type ScopeType = 'project' | 'team';

export interface ScopeGrant {
  type: ScopeType;
  id: string;
}

export interface ScopedSubject {
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
}

/** Roles whose holders only see the projects and teams assigned to them (BR-4). */
export const SCOPED_ROLES: readonly string[] = ['supervisor'];

/**
 * A user is limited to assigned scopes when every role they hold is a scoped role.
 * Holding any unscoped role (for example project_manager) lifts the limit.
 */
export function isScopeLimited(subject: Pick<ScopedSubject, 'roles'>): boolean {
  return subject.roles.length > 0 && subject.roles.every((role) => SCOPED_ROLES.includes(role));
}

export function hasScope(subject: ScopedSubject, type: ScopeType, id: string): boolean {
  if (!isScopeLimited(subject)) return true;
  return subject.scopes.some((scope) => scope.type === type && scope.id === id);
}

export type ScopeFilter = { all: true } | { all: false; ids: readonly string[] };

/** The ids a query must be limited to, or `all` when the user is not scope-limited. */
export function scopeFilter(subject: ScopedSubject, type: ScopeType): ScopeFilter {
  if (!isScopeLimited(subject)) return { all: true };
  return {
    all: false,
    ids: subject.scopes.filter((scope) => scope.type === type).map((scope) => scope.id),
  };
}

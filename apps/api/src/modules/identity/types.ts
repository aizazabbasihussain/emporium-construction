import type { ScopeGrant } from '@emporium/domain/identity';
import type { Db } from '../platform/index.js';

export type { Db };

/** The authenticated, active caller. Structurally a platform `Principal`. */
export interface CurrentUser {
  userId: string;
  email: string;
  fullName: string;
  locale: string;
  version: number;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
  scopes: readonly ScopeGrant[];
}

/** Who is acting and under which request; recorded in the audit log. */
export interface ActionContext {
  actorUserId: string | null;
  requestId: string | null;
}

export interface UserDto {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  status: 'active' | 'disabled';
  locale: string;
  lastLoginAt: string | null;
  version: number;
  roles: string[];
  scopes: ScopeGrant[];
}

export interface RoleDto {
  code: string;
  name: string;
  description: string;
  system: boolean;
  permissions: string[];
}

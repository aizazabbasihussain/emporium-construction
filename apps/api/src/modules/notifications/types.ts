import type { ScopeGrant } from '@emporium/domain/identity';
import type { Db } from '../platform/index.js';

export type { Db };

export interface NotificationDto {
  id: string;
  template: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationDto[];
  unread: number;
}

/** A user as the notifications module needs to see one: who they are, what role and scope they hold. */
export interface DirectoryUser {
  id: string;
  roles: readonly string[];
  scopes: readonly ScopeGrant[];
}

/** Supplied by composition from the identity module; notifications never reads sys_ tables. */
export interface UserDirectory {
  /** Active users holding `roleCode`. */
  usersWithRole(db: Db, roleCode: string): Promise<DirectoryUser[]>;
}

/** The slice of the approvals read API this module consumes (BR-10). */
export interface ApprovalLookup {
  (
    db: Db,
    docType: string,
    docId: string,
  ): Promise<{ status: string; currentRole?: string | null; context?: Record<string, unknown> }>;
}

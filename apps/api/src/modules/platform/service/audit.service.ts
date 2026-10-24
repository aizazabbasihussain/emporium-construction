import { redactSecrets } from '@emporium/domain/kernel';
import { insertAudit, searchAudit, type AuditFilter, type AuditRow } from '../repo/audit.repo.js';
import type { Db } from '../types.js';

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

export interface AuditService {
  /** Appends an audit row inside the caller's transaction (constitution 5.12). */
  record(entry: AuditEntry, tx: Db): Promise<void>;
  search(db: Db, filter: AuditFilter): Promise<AuditRow[]>;
}

export function createAuditService(deps: { newId: () => string }): AuditService {
  return {
    async record(entry, tx) {
      await insertAudit(tx, {
        id: deps.newId(),
        actorUserId: entry.actorUserId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: redactSecrets(entry.before),
        after: redactSecrets(entry.after),
        requestId: entry.requestId ?? null,
      });
    },
    search: (db, filter) => searchAudit(db, filter),
  };
}

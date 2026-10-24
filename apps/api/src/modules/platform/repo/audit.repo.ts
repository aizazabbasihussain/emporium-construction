import type { Db } from '../types.js';

export interface AuditRow {
  id: string;
  at: Date;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
}

export interface NewAuditRow {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

export interface AuditFilter {
  entityType?: string | undefined;
  entityId?: string | undefined;
  actorUserId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}

const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

export async function insertAudit(db: Db, row: NewAuditRow): Promise<void> {
  await db.query(
    `insert into sys_audit_log (id, actor_user_id, action, entity_type, entity_id, before, after, request_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      row.id,
      row.actorUserId,
      row.action,
      row.entityType,
      row.entityId,
      json(row.before),
      json(row.after),
      row.requestId,
    ],
  );
}

export async function searchAudit(db: Db, filter: AuditFilter): Promise<AuditRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown, cast = '') => {
    params.push(value);
    return `${column} $${params.length}${cast}`;
  };
  if (filter.entityType) where.push(add('entity_type =', filter.entityType));
  if (filter.entityId) where.push(add('entity_id =', filter.entityId));
  if (filter.actorUserId) where.push(add('actor_user_id =', filter.actorUserId));
  if (filter.from) where.push(add('at >=', filter.from, '::timestamptz'));
  if (filter.to) where.push(add('at <=', filter.to, '::timestamptz'));
  params.push(filter.limit, filter.offset);
  return db.query<AuditRow>(
    `select * from sys_audit_log
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by at desc, id desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

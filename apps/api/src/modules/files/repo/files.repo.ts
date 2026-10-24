import type { Db } from '../types.js';

export interface AttachmentRow {
  id: string;
  entity_type: string;
  entity_id: string;
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string;
  caption: string | null;
  taken_at: Date | null;
  latitude: number | null;
  longitude: number | null;
  retain_forever: boolean;
  uploaded_by: string;
  created_at: Date;
  version: number;
  deleted_at: Date | null;
}

const COLUMNS = `id, entity_type, entity_id, storage_key, file_name, content_type, size_bytes,
  checksum_sha256, caption, taken_at, latitude::float8 as latitude, longitude::float8 as longitude,
  retain_forever, uploaded_by, created_at, version, deleted_at`;

export interface NewAttachment {
  id: string;
  entityType: string;
  entityId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksum: string;
  caption: string | null;
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  retainForever: boolean;
  uploadedBy: string;
  at: Date;
}

/** Undefined when the same bytes are already attached to the entity (BR-2). */
export async function insertAttachment(
  db: Db,
  row: NewAttachment,
): Promise<AttachmentRow | undefined> {
  const rows = await db.query<AttachmentRow>(
    `insert into fil_attachments
       (id, entity_type, entity_id, storage_key, file_name, content_type, size_bytes,
        checksum_sha256, caption, taken_at, latitude, longitude, retain_forever, uploaded_by,
        created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, $15, $14)
     on conflict (entity_type, entity_id, checksum_sha256) where deleted_at is null do nothing
     returning ${COLUMNS}`,
    [
      row.id,
      row.entityType,
      row.entityId,
      row.storageKey,
      row.fileName,
      row.contentType,
      row.sizeBytes,
      row.checksum,
      row.caption,
      row.takenAt?.toISOString() ?? null,
      row.latitude,
      row.longitude,
      row.retainForever,
      row.uploadedBy,
      row.at.toISOString(),
    ],
  );
  return rows[0];
}

export async function findAttachment(
  db: Db,
  id: string,
  lock = false,
): Promise<AttachmentRow | undefined> {
  const rows = await db.query<AttachmentRow>(
    `select ${COLUMNS} from fil_attachments where id = $1 and deleted_at is null
     ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0];
}

export async function findByChecksum(
  db: Db,
  entityType: string,
  entityId: string,
  checksum: string,
): Promise<AttachmentRow | undefined> {
  const rows = await db.query<AttachmentRow>(
    `select ${COLUMNS} from fil_attachments
      where entity_type = $1 and entity_id = $2 and checksum_sha256 = $3 and deleted_at is null`,
    [entityType, entityId, checksum],
  );
  return rows[0];
}

export function listByEntity(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<AttachmentRow[]> {
  return db.query<AttachmentRow>(
    `select ${COLUMNS} from fil_attachments
      where entity_type = $1 and entity_id = $2 and deleted_at is null
      order by created_at, id`,
    [entityType, entityId],
  );
}

/** BR-5: removal is soft; the object stays until the purge job runs. */
export async function softDelete(db: Db, id: string, actorId: string, at: Date): Promise<void> {
  await db.query(
    `update fil_attachments
        set deleted_at = $3, updated_at = $3, updated_by = $2, version = version + 1
      where id = $1`,
    [id, actorId, at.toISOString()],
  );
}

/** Removed files older than the cutoff whose object is still there; `retain_forever` is never due. */
export function listPurgeable(db: Db, cutoff: Date, limit: number): Promise<AttachmentRow[]> {
  return db.query<AttachmentRow>(
    `select ${COLUMNS} from fil_attachments
      where deleted_at is not null and deleted_at <= $1 and purged_at is null
        and not retain_forever
      order by deleted_at, id
      limit $2`,
    [cutoff.toISOString(), limit],
  );
}

export async function markPurged(db: Db, id: string, at: Date): Promise<void> {
  await db.query('update fil_attachments set purged_at = $2 where id = $1', [id, at.toISOString()]);
}

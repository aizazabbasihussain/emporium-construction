import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '@emporium/domain';
import {
  FILE_PURGE_AFTER_DAYS,
  SIGNED_URL_TTL_SECONDS,
  assertAcceptableContent,
  assertEntityType,
  assertSafeFileName,
  retentionCutoff,
} from '@emporium/domain/files';
import type { Clock } from '@emporium/domain/kernel';
import type { FileOperation } from '@emporium/shared';
import type { Platform } from '../../platform/index.js';
import { assertEntityAccess, assertFilePermission } from '../policy/files.policy.js';
import {
  findAttachment,
  findByChecksum,
  insertAttachment,
  listByEntity,
  listPurgeable,
  markPurged,
  softDelete,
  type AttachmentRow,
} from '../repo/files.repo.js';
import type { FileStore } from '../store/file-store.js';
import type {
  AttachmentDto,
  Db,
  FileAccessCheck,
  FileAccessOptions,
  FileActor,
  SignedUrl,
  UploadInput,
} from '../types.js';

const PURGE_BATCH = 100;

export interface FilesService {
  /** BR-4: the module that owns `entityType` says who may use its files; there is no default. */
  registerFileAccess(entityType: string, check: FileAccessCheck, options?: FileAccessOptions): void;
  /** BR-2: attaching the same bytes to the same entity again returns the existing attachment. */
  attach(
    upload: UploadInput,
    actor: FileActor,
    tx: Db,
  ): Promise<{ attachment: AttachmentDto; created: boolean }>;
  list(db: Db, actor: FileActor, entityType: string, entityId: string): Promise<AttachmentDto[]>;
  /** BR-4: a five-minute link, issued only after the permission and entity checks. */
  getSignedUrl(db: Db, actor: FileActor, attachmentId: string): Promise<SignedUrl>;
  /** BR-5: soft removal; the object is purged later. */
  remove(
    attachmentId: string,
    actor: FileActor,
    tx: Db,
    expectedVersion?: number,
  ): Promise<AttachmentDto>;
  /** BR-5: deletes the objects of files removed more than 30 days ago; returns how many. */
  purgeExpired(db: Db): Promise<number>;
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    caption: row.caption,
    takenAt: row.taken_at?.toISOString() ?? null,
    latitude: row.latitude,
    longitude: row.longitude,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

export function createFilesService(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  /** A random UUID for each object (BR-3). */
  newKey: () => string;
  store: FileStore;
}): FilesService {
  const { platform, clock, newId, newKey, store } = deps;
  const registry = new Map<string, { check: FileAccessCheck; retainForever: boolean }>();

  const entityOf = (entityType: string) => {
    const entry = registry.get(entityType);
    if (entry === undefined) throw new NotFoundError('entity_not_found', 'Not found');
    return entry;
  };

  async function authorize(
    db: Db,
    actor: FileActor,
    operation: FileOperation,
    entityType: string,
    entityId: string,
  ) {
    assertFilePermission(actor, operation);
    const entry = entityOf(entityType);
    await assertEntityAccess(entry.check, { actor, entityId, operation, db });
    return entry;
  }

  const record = async (
    tx: Db,
    actor: FileActor,
    action: string,
    row: AttachmentRow,
    eventType: string,
  ) => {
    await platform.audit.record(
      {
        actorUserId: actor.userId,
        action,
        entityType: 'file_attachment',
        entityId: row.id,
        after: {
          entityType: row.entity_type,
          entityId: row.entity_id,
          fileName: row.file_name,
          checksumSha256: row.checksum_sha256,
        },
        requestId: actor.requestId,
      },
      tx,
    );
    await platform.events.publish(
      {
        type: eventType,
        payload: { attachmentId: row.id, entityType: row.entity_type, entityId: row.entity_id },
      },
      tx,
    );
  };

  return {
    registerFileAccess(entityType, check, options = {}) {
      assertEntityType(entityType);
      if (registry.has(entityType)) {
        throw new ValidationError(
          'file_access_registered',
          `File access for ${entityType} is already registered`,
        );
      }
      registry.set(entityType, { check, retainForever: options.retainForever ?? false });
    },

    async attach(upload, actor, tx) {
      assertEntityType(upload.entityType);
      assertFilePermission(actor, 'upload');
      const entry = registry.get(upload.entityType);
      if (entry === undefined) {
        throw new ValidationError(
          'entity_type_unknown',
          `No module has registered files for ${upload.entityType}`,
        );
      }
      await assertEntityAccess(entry.check, {
        actor,
        entityId: upload.entityId,
        operation: 'upload',
        db: tx,
      });
      const fileName = assertSafeFileName(upload.fileName);
      const contentType = assertAcceptableContent(upload.bytes);
      const checksum = createHash('sha256').update(upload.bytes).digest('hex');

      const existing = await findByChecksum(tx, upload.entityType, upload.entityId, checksum);
      if (existing !== undefined) return { attachment: toAttachmentDto(existing), created: false };

      const storageKey = newKey();
      await store.put(storageKey, upload.bytes, contentType);
      let inserted: AttachmentRow | undefined;
      try {
        inserted = await insertAttachment(tx, {
          id: newId(),
          entityType: upload.entityType,
          entityId: upload.entityId,
          storageKey,
          fileName,
          contentType,
          sizeBytes: upload.bytes.length,
          checksum,
          caption: upload.caption?.trim() || null,
          takenAt: upload.takenAt ?? null,
          latitude: upload.latitude ?? null,
          longitude: upload.longitude ?? null,
          retainForever: entry.retainForever,
          uploadedBy: actor.userId,
          at: clock.now(),
        });
      } catch (error) {
        await store.delete(storageKey);
        throw error;
      }
      if (inserted === undefined) {
        // A concurrent upload of the same bytes won the race: keep theirs, drop our object.
        await store.delete(storageKey);
        const winner = (await findByChecksum(
          tx,
          upload.entityType,
          upload.entityId,
          checksum,
        )) as AttachmentRow;
        return { attachment: toAttachmentDto(winner), created: false };
      }
      await record(tx, actor, 'file.attach', inserted, 'file.attached');
      return { attachment: toAttachmentDto(inserted), created: true };
    },

    async list(db, actor, entityType, entityId) {
      await authorize(db, actor, 'read', entityType, entityId);
      return (await listByEntity(db, entityType, entityId)).map(toAttachmentDto);
    },

    async getSignedUrl(db, actor, attachmentId) {
      const row = await findAttachment(db, attachmentId);
      if (row === undefined) throw new NotFoundError('attachment_not_found', 'Not found');
      await authorize(db, actor, 'read', row.entity_type, row.entity_id);
      const url = await store.getSignedUrl(row.storage_key, {
        expiresInSeconds: SIGNED_URL_TTL_SECONDS,
        fileName: row.file_name,
        contentType: row.content_type,
      });
      return {
        url,
        expiresAt: new Date(clock.now().getTime() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },

    async remove(attachmentId, actor, tx, expectedVersion) {
      const row = await findAttachment(tx, attachmentId, true);
      if (row === undefined) throw new NotFoundError('attachment_not_found', 'Not found');
      await authorize(tx, actor, 'remove', row.entity_type, row.entity_id);
      if (expectedVersion !== undefined && expectedVersion !== row.version) {
        throw new ConflictError('version_conflict', 'The file was changed by someone else', {
          expectedVersion,
        });
      }
      await softDelete(tx, row.id, actor.userId, clock.now());
      await record(tx, actor, 'file.remove', row, 'file.removed');
      return { ...toAttachmentDto(row), version: row.version + 1 };
    },

    async purgeExpired(db) {
      const now = clock.now();
      const due = await listPurgeable(db, retentionCutoff(now, FILE_PURGE_AFTER_DAYS), PURGE_BATCH);
      for (const row of due) {
        await store.delete(row.storage_key);
        await db.transaction(async (tx) => {
          await markPurged(tx, row.id, now);
          await platform.audit.record(
            {
              actorUserId: null,
              action: 'file.purge',
              entityType: 'file_attachment',
              entityId: row.id,
              after: { entityType: row.entity_type, entityId: row.entity_id },
            },
            tx,
          );
        });
      }
      return due.length;
    },
  };
}

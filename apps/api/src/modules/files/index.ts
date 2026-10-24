// The only public entry point of the files module.
import type { Clock } from '@emporium/domain/kernel';
import type { Platform } from '../platform/index.js';
import { createFilesService, type FilesService } from './service/files.service.js';
import type { FileStore } from './store/file-store.js';

export interface Files {
  service: FilesService;
  /** Module-to-module API (spec P1-04 section 2); call these inside the owning module's transaction. */
  attach: FilesService['attach'];
  list: FilesService['list'];
  getSignedUrl: FilesService['getSignedUrl'];
  remove: FilesService['remove'];
  registerFileAccess: FilesService['registerFileAccess'];
  purgeExpired: FilesService['purgeExpired'];
}

/** Wires files on top of the kernel and a `FileStore` driver. Other modules receive the result. */
export function createFiles(deps: {
  platform: Platform;
  clock: Clock;
  newId: () => string;
  newKey: () => string;
  store: FileStore;
}): Files {
  const service = createFilesService(deps);
  return {
    service,
    attach: (upload, actor, tx) => service.attach(upload, actor, tx),
    list: (db, actor, entityType, entityId) => service.list(db, actor, entityType, entityId),
    getSignedUrl: (db, actor, attachmentId) => service.getSignedUrl(db, actor, attachmentId),
    remove: (attachmentId, actor, tx, expectedVersion) =>
      service.remove(attachmentId, actor, tx, expectedVersion),
    registerFileAccess: (entityType, check, options) =>
      service.registerFileAccess(entityType, check, options),
    purgeExpired: (db) => service.purgeExpired(db),
  };
}

export {
  registerFileBlobRoute,
  registerFilesRoutes,
  type FilesRouteDeps,
} from './routes/files.routes.js';
export {
  createFileStore,
  type FileStoreConfig,
  type CreatedFileStore,
} from './store/create-store.js';
export type { FileStore, SignOptions } from './store/file-store.js';
export type { LocalFileStore } from './store/local.store.js';
export type {
  AttachmentDto,
  FileAccessCheck,
  FileAccessOptions,
  FileActor,
  SignedUrl,
  UploadInput,
} from './types.js';

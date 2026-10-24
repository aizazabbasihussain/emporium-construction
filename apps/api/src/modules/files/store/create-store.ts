import { ValidationError } from '@emporium/domain';
import type { FileStoreDriver } from '@emporium/shared';
import type { FileStore } from './file-store.js';
import { createLocalFileStore, type LocalFileStore } from './local.store.js';
import { createSupabaseFileStore, createSupabaseStorageClient } from './supabase.store.js';

export interface FileStoreConfig {
  driver: FileStoreDriver;
  local?: { directory: string; secret: string; baseUrl: string } | undefined;
  supabase?: { url: string; serviceKey: string; bucket: string } | undefined;
}

export interface CreatedFileStore {
  store: FileStore;
  /** Present for the local driver: serves its own signed links. */
  local: LocalFileStore | undefined;
}

/** BR-6: `FILE_STORE_DRIVER` picks the driver; each driver needs its own settings. */
export function createFileStore(config: FileStoreConfig, now: () => Date): CreatedFileStore {
  if (config.driver === 'local') {
    if (config.local === undefined) {
      throw new ValidationError(
        'file_store_config',
        'FILE_STORE_DRIVER=local needs FILE_STORE_LOCAL_DIR and FILE_URL_SECRET',
      );
    }
    const local = createLocalFileStore({ ...config.local, now });
    return { store: local, local };
  }
  if (config.supabase === undefined) {
    throw new ValidationError(
      'file_store_config',
      'FILE_STORE_DRIVER=supabase needs SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_STORAGE_BUCKET',
    );
  }
  return {
    store: createSupabaseFileStore(createSupabaseStorageClient(config.supabase)),
    local: undefined,
  };
}

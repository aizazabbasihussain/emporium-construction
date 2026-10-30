import type { Draft, PhotoRecord, QueueItem } from '@emporium/shared';

/** Spec P1-20 section 3: the IndexedDB database that holds drafts, the queue and photos. */
export const DB_NAME = 'ops-offline';
const DB_VERSION = 1;

/** A photo row: the record the pure rules use, plus the stored bytes. */
export interface PhotoRow extends PhotoRecord {
  blob: Blob;
}

/** The device refused a write because it is out of space (BR-6). */
export class StorageFullError extends Error {
  constructor() {
    super('Device storage is full');
    this.name = 'StorageFullError';
  }
}

export interface Store<T> {
  get(key: IDBValidKey): Promise<T | undefined>;
  put(value: T): Promise<void>;
  delete(key: IDBValidKey): Promise<void>;
  all(): Promise<T[]>;
}

export interface OfflineDb {
  drafts: Store<Draft>;
  queue: Store<QueueItem>;
  photos: Store<PhotoRow>;
}

const done = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });

const isQuotaError = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === 'QuotaExceededError';

function storeOf<T>(db: IDBDatabase, name: string): Store<T> {
  return {
    get: async (key) =>
      (await done(db.transaction(name).objectStore(name).get(key))) as T | undefined,
    put: async (value) => {
      try {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).put(value);
        await finished(tx);
      } catch (cause) {
        throw isQuotaError(cause) ? new StorageFullError() : cause;
      }
    },
    delete: async (key) => {
      const tx = db.transaction(name, 'readwrite');
      tx.objectStore(name).delete(key);
      await finished(tx);
    },
    all: async () => (await done(db.transaction(name).objectStore(name).getAll())) as T[],
  };
}

/** Opens (and on first use creates) the database. `factory` is replaced by a fake in tests. */
export async function openOfflineDb(
  factory: IDBFactory = indexedDB,
  name: string = DB_NAME,
): Promise<OfflineDb> {
  const request = factory.open(name, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    // One draft per user and key, so two users of a shared phone never overwrite each other.
    db.createObjectStore('drafts', { keyPath: ['userId', 'key'] });
    db.createObjectStore('queue', { keyPath: 'id' });
    db.createObjectStore('photos', { keyPath: 'id' });
  };
  const db = await done(request);
  return {
    drafts: storeOf<Draft>(db, 'drafts'),
    queue: storeOf<QueueItem>(db, 'queue'),
    photos: storeOf<PhotoRow>(db, 'photos'),
  };
}

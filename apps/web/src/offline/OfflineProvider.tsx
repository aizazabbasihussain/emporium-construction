import {
  dprReportEntityType,
  isStorageLow,
  isUnsent,
  type DraftFormType,
  type QueueItem,
  type QueueSource,
} from '@emporium/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { request } from '../admin/api';
import { useAuth } from '../auth/AuthProvider';
import { filesApi } from '../files/api';
import { openOfflineDb, type OfflineDb, type PhotoRow } from './db';
import { createDraftStore, type DraftStore } from './draftStore';
import { createPhotoQueue, type PhotoQueue } from './photoQueue';
import { createSubmitQueue, type SubmitQueue } from './submitQueue';

/** Entity types the photo queue can attach to; only reports carry photos in this phase. */
const photoEntityTypes: Partial<Record<DraftFormType, string>> = { dpr: dprReportEntityType };

export interface SubmitInput {
  method: string;
  url: string;
  body: unknown;
  source: QueueSource;
}

export type SubmitResult =
  | { status: 'sent'; item: QueueItem }
  | { status: 'queued'; item: QueueItem }
  | { status: 'failed'; item: QueueItem };

export interface OfflineContextValue {
  /** False when the browser has no usable IndexedDB; forms then call the API directly. */
  available: boolean;
  online: boolean;
  drafts: DraftStore | null;
  photos: PhotoQueue | null;
  /** Waiting and failed requests of the signed-in user. */
  unsent: QueueItem[];
  /** Photos stored on the device that have not reached the server. */
  unsentPhotos: PhotoRow[];
  storageLow: boolean;
  staleDraftCount: number;
  /** Queues the request, tries it once now and reports where it ended up (BR-3). */
  submit: (input: SubmitInput) => Promise<SubmitResult>;
  /** Puts a failed item back into its form as a draft; returns the screen to open (BR-4). */
  editAndResend: (item: QueueItem) => Promise<string>;
  discard: (item: QueueItem) => Promise<void>;
  sync: () => Promise<void>;
  /** Shared-device setting: ask at logout whether to delete the drafts (BR-2). */
  sharedDevice: boolean;
  setSharedDevice: (value: boolean) => void;
  clearDrafts: () => Promise<void>;
}

const unavailable: OfflineContextValue = {
  available: false,
  online: true,
  drafts: null,
  photos: null,
  unsent: [],
  unsentPhotos: [],
  storageLow: false,
  staleDraftCount: 0,
  submit: () => Promise.reject(new Error('Offline storage is not available')),
  editAndResend: () => Promise.reject(new Error('Offline storage is not available')),
  discard: () => Promise.resolve(),
  sync: () => Promise.resolve(),
  sharedDevice: false,
  setSharedDevice: () => undefined,
  clearDrafts: () => Promise.resolve(),
};

const OfflineContext = createContext<OfflineContextValue>(unavailable);

/** Without a provider (most tests) the layer reports itself unavailable and forms go direct. */
export const useOffline = (): OfflineContextValue => useContext(OfflineContext);

const SHARED_KEY = 'ops-offline-shared-device';
const MIN_WAIT_MS = 1_000;

const readShared = (): boolean => {
  try {
    return localStorage.getItem(SHARED_KEY) === 'true';
  } catch {
    return false;
  }
};

const openDefault = () => openOfflineDb();

export interface OfflineProviderProps {
  children: ReactNode;
  /** Replaced in tests by a fake database. */
  openDb?: () => Promise<OfflineDb>;
}

/**
 * Owns the device database, the retry queue and the photo queue for the signed-in user, and runs
 * them when the browser comes online, the app returns to the foreground or a retry is due.
 */
export function OfflineProvider({ children, openDb = openDefault }: OfflineProviderProps) {
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const [stores, setStores] = useState<{
    drafts: DraftStore;
    photos: PhotoQueue;
    queue: SubmitQueue;
  } | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [unsent, setUnsent] = useState<QueueItem[]>([]);
  const [unsentPhotos, setUnsentPhotos] = useState<PhotoRow[]>([]);
  const [storageLow, setStorageLow] = useState(false);
  const [staleDraftCount, setStaleDraftCount] = useState(0);
  const [sharedDevice, setShared] = useState(readShared);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncing = useRef<Promise<void> | null>(null);
  const userRef = useRef(userId);
  userRef.current = userId;

  // The photo uploader needs the parent id and entity type of the item a photo belongs to.
  const parentsRef = useRef(new Map<string, { id: string; entityType: string }>());

  useEffect(() => {
    let active = true;
    void openDb()
      .then((db) => {
        if (!active) return;
        setStores({
          drafts: createDraftStore(db),
          queue: createSubmitQueue({
            db,
            send: (item) =>
              request<{ id?: string }>(item.method, item.url, item.body, item.idempotencyKey),
          }),
          photos: createPhotoQueue({
            db,
            upload: (row) => {
              const parent = parentsRef.current.get(row.draftKey);
              if (parent === undefined) return Promise.reject(new Error('Parent not sent yet'));
              return filesApi.upload(parent.entityType, parent.id, row.blob as File, '', row.id);
            },
          }),
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [openDb]);

  const refresh = useCallback(async () => {
    if (stores === null || userRef.current === null) {
      setUnsent([]);
      setUnsentPhotos([]);
      return;
    }
    const items = await stores.queue.list(userRef.current);
    setUnsent(items.filter(isUnsent));
    const mine = new Set(items.map((i) => i.id));
    setUnsentPhotos(
      (await stores.photos.list()).filter((p) => mine.has(p.draftKey) && p.status !== 'uploaded'),
    );
    setStaleDraftCount((await stores.drafts.stale(userRef.current)).length);
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    setStorageLow(isStorageLow(estimate ?? null));
  }, [stores]);

  const schedule = useCallback(
    async (run: () => Promise<void>) => {
      if (stores === null || userRef.current === null) return;
      if (timer.current !== null) clearTimeout(timer.current);
      const queued = await stores.queue.nextAttempt(userRef.current);
      const photoTimes = (await stores.photos.list())
        .filter((p) => p.status === 'pending')
        .map((p) => p.nextAttemptAt);
      const times = [...(queued === null ? [] : [queued]), ...photoTimes];
      if (times.length === 0) return;
      const wait = Math.max(MIN_WAIT_MS, Math.min(...times) - Date.now());
      timer.current = setTimeout(() => void run(), wait);
    },
    [stores],
  );

  const sync = useCallback((): Promise<void> => {
    const current = userRef.current;
    if (stores === null || current === null) return Promise.resolve();
    const pass = async () => {
      try {
        // A request delivered earlier goes once its photos are delivered too. Items delivered in
        // this pass stay until the next, so the caller can still read the id they created.
        for (const item of await stores.queue.list(current)) {
          if (item.status === 'sent' && (await stores.photos.settle(item.id))) {
            await stores.queue.discard(item.id);
          }
        }
        await stores.queue.run(current);
        const items = await stores.queue.list(current);
        parentsRef.current.clear();
        const parents = new Map<string, string>();
        for (const item of items) {
          if (item.status !== 'sent' || item.resultId === null || item.source === null) continue;
          const entityType = photoEntityTypes[item.source.formType];
          if (entityType === undefined) continue;
          parentsRef.current.set(item.id, { id: item.resultId, entityType });
          parents.set(item.id, item.resultId);
        }
        const result = await stores.photos.run(parents);
        if (result.paused) stores.queue.pause();
      } finally {
        await refresh();
        await schedule(sync);
      }
    };
    // Passes run one after another, so a request queued during a pass is still sent right away.
    const next = (syncing.current ?? Promise.resolve()).then(pass);
    syncing.current = next.catch(() => undefined);
    return next;
  }, [stores, refresh, schedule]);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void (async () => {
        const current = userRef.current;
        if (stores === null || current === null) return;
        await stores.queue.retryNow(current);
        await stores.photos.retryNow();
        await sync();
      })();
    };
    const goOffline = () => setOnline(false);
    const foreground = () => {
      if (document.visibilityState === 'visible') void sync();
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [stores, sync]);

  // Sign-in (a new profile object) lifts a pause caused by 401 and starts sending.
  useEffect(() => {
    stores?.queue.resume();
    void sync();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [stores, profile, sync]);

  const submit = useCallback(
    async (input: SubmitInput): Promise<SubmitResult> => {
      if (stores === null || userRef.current === null) throw new Error('Not ready');
      const item = await stores.queue.enqueue({ ...input, userId: userRef.current });
      // The form's photos follow the request, and the form's draft is now the queued request.
      await stores.photos.rekey(input.source.draftKey, item.id);
      await stores.drafts.remove(input.source.draftKey, userRef.current);
      await sync();
      const after =
        (await stores.queue.list(userRef.current)).find((i) => i.id === item.id) ?? item;
      return { status: after.status === 'pending' ? 'queued' : after.status, item: after };
    },
    [stores, sync],
  );

  const editAndResend = useCallback(
    async (item: QueueItem): Promise<string> => {
      if (stores === null || userRef.current === null || item.source === null) {
        throw new Error('Cannot edit this item');
      }
      const { source } = item;
      await stores.photos.rekey(item.id, source.draftKey);
      await stores.drafts.save(source.draftKey, source.formType, source.payload, userRef.current);
      await stores.queue.discard(item.id);
      await refresh();
      return source.path;
    },
    [stores, refresh],
  );

  const discard = useCallback(
    async (item: QueueItem) => {
      if (stores === null) return;
      for (const photo of await stores.photos.listFor(item.id))
        await stores.photos.remove(photo.id);
      await stores.queue.discard(item.id);
      await refresh();
    },
    [stores, refresh],
  );

  const clearDrafts = useCallback(async () => {
    if (stores !== null && userRef.current !== null) await stores.drafts.clear(userRef.current);
  }, [stores]);

  const setSharedDevice = useCallback((value: boolean) => {
    setShared(value);
    try {
      localStorage.setItem(SHARED_KEY, String(value));
    } catch {
      // The setting just does not stick on a device that refuses storage.
    }
  }, []);

  const value = useMemo<OfflineContextValue>(
    () =>
      stores === null
        ? { ...unavailable, online }
        : {
            available: true,
            online,
            drafts: stores.drafts,
            photos: stores.photos,
            unsent,
            unsentPhotos,
            storageLow,
            staleDraftCount,
            submit,
            editAndResend,
            discard,
            sync,
            sharedDevice,
            setSharedDevice,
            clearDrafts,
          },
    [
      stores,
      online,
      unsent,
      unsentPhotos,
      storageLow,
      staleDraftCount,
      submit,
      editAndResend,
      discard,
      sync,
      sharedDevice,
      setSharedDevice,
      clearDrafts,
    ],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

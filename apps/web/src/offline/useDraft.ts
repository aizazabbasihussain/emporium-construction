import {
  autosaveDelayMs,
  draftKey,
  isStaleDraft,
  type Draft,
  type DraftFormType,
} from '@emporium/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { StorageFullError } from './db';
import { useOffline } from './OfflineProvider';

export interface UseDraft<P> {
  /** The draft key of this form, also the key of its queued photos. */
  key: string;
  /** A draft found on the device at load time that the user has not restored or discarded. */
  found: Draft<P> | null;
  /** True when the found draft is older than 30 days (BR-6). */
  foundIsStale: boolean;
  /** Saves the form input 500 ms after the last call (BR-2). */
  save: (payload: P) => void;
  /** Hands back the found draft and hides the banner. */
  restore: () => P | null;
  /** Deletes the draft (after a successful send, or when the user discards it). */
  clear: () => Promise<void>;
  /** The device refused the last write: tell the user before data is lost (BR-6). */
  storageFull: boolean;
}

/**
 * Autosave and restore for one form. `scope` tells drafts of the same form apart, for example a
 * team and date. Without offline storage every call does nothing and the form works as before.
 */
export function useDraft<P>(formType: DraftFormType, scope: string): UseDraft<P> {
  const { drafts } = useOffline();
  const { profile } = useAuth();
  const userId = profile?.id ?? null;
  const key = draftKey(formType, scope);
  const [found, setFound] = useState<Draft<P> | null>(null);
  const [storageFull, setStorageFull] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ payload: P } | null>(null);

  const write = useCallback(async () => {
    const next = pending.current;
    pending.current = null;
    if (next === null || drafts === null || userId === null) return;
    try {
      await drafts.save(key, formType, next.payload, userId);
      setStorageFull(false);
    } catch (cause) {
      if (cause instanceof StorageFullError) setStorageFull(true);
    }
  }, [drafts, userId, key, formType]);

  useEffect(() => {
    setFound(null);
    if (drafts === null || userId === null) return;
    let active = true;
    void drafts.get<P>(key, userId).then((draft) => {
      if (active && draft !== undefined) setFound(draft);
    });
    return () => {
      active = false;
    };
  }, [drafts, userId, key]);

  // Leaving the form writes what is waiting, so the last 500 ms of typing are not lost.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      void write();
    },
    [write],
  );

  const save = useCallback(
    (payload: P) => {
      pending.current = { payload };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void write(), autosaveDelayMs);
    },
    [write],
  );

  const clear = useCallback(async () => {
    if (timer.current !== null) clearTimeout(timer.current);
    pending.current = null;
    setFound(null);
    if (drafts !== null && userId !== null) await drafts.remove(key, userId);
  }, [drafts, userId, key]);

  const restore = useCallback((): P | null => {
    const payload = found?.payload ?? null;
    setFound(null);
    return payload;
  }, [found]);

  return {
    key,
    found,
    foundIsStale: found !== null && isStaleDraft(found, Date.now()),
    save,
    restore,
    clear,
    storageFull,
  };
}

import type { Profile } from './api';

/**
 * Spec P1-20 BR-1: the last profile the API returned, so the app shell opens offline for a user who
 * is still signed in. It holds names and permission codes only, never tokens, and is removed at
 * sign-out.
 */
const KEY = 'ops-offline-profile';

export function cacheProfile(profile: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Without the cache the app simply asks for sign-in when it starts offline.
  }
}

export function cachedProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as Profile);
  } catch {
    return null;
  }
}

export function clearCachedProfile(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to remove.
  }
}

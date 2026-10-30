import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AppProviders, AppRoutes } from '../App';
import { allPermissions, fakeAuth, profileOf } from '../test-utils';
import { cacheProfile, cachedProfile, clearCachedProfile } from './profileCache';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('profile cache (BR-1)', () => {
  it('keeps the last profile and forgets it on request', () => {
    expect(cachedProfile()).toBeNull();
    cacheProfile(profileOf(['a.b.c']));
    expect(cachedProfile()?.permissions).toEqual(['a.b.c']);
    clearCachedProfile();
    expect(cachedProfile()).toBeNull();
  });

  it('never stores anything that looks like a token', () => {
    cacheProfile(profileOf(['a.b.c']));
    expect(JSON.stringify(Object.entries(localStorage))).not.toMatch(/token/i);
  });

  it('survives storage that refuses, or holds rubbish', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => cacheProfile(profileOf([]))).not.toThrow();
    expect(cachedProfile()).toBeNull();
    expect(() => clearCachedProfile()).not.toThrow();
    vi.unstubAllGlobals();
    localStorage.setItem('ops-offline-profile', '{not json');
    expect(cachedProfile()).toBeNull();
  });
});

const openShell = () =>
  render(
    <AppProviders auth={fakeAuth()}>
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );

describe('opening the app without a connection', () => {
  it('opens the shell for a signed-in user from the last known profile', async () => {
    cacheProfile(profileOf(allPermissions, { fullName: 'Cached Person' }));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    openShell();
    expect(await screen.findByText('Signed in as Cached Person')).toBeVisible();
  });

  it('asks for sign-in when there is no profile to fall back on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    openShell();
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeVisible();
  });

  it('trusts a refusal from the server over the cache', async () => {
    cacheProfile(profileOf(allPermissions, { fullName: 'Cached Person' }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { code: 'forbidden', message: 'No' } }),
      }),
    );
    openShell();
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeVisible();
    expect(cachedProfile()).toBeNull();
  });
});

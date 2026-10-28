import {
  approvalsPermissions,
  crmPermissions,
  estimationPermissions,
  filesPermissions,
  identityPermissions,
  importerPermissions,
  inventoryPermissions,
  masterdataPermissions,
  quotationsPermissions,
  notificationsPermissions,
  platformPermissions,
  procurementPermissions,
  projectsPermissions,
  valuationPermissions,
  variationsPermissions,
} from '@emporium/shared';
import type { AuthClient } from './auth/client';
import type { Profile } from './auth/api';

export const allPermissions: string[] = [
  ...Object.values(identityPermissions),
  ...Object.values(platformPermissions),
  ...Object.values(importerPermissions),
  ...Object.values(approvalsPermissions),
  ...Object.values(filesPermissions),
  ...Object.values(notificationsPermissions),
  ...Object.values(masterdataPermissions),
  ...Object.values(crmPermissions),
  ...Object.values(valuationPermissions),
  ...Object.values(estimationPermissions),
  ...Object.values(quotationsPermissions),
  ...Object.values(projectsPermissions),
  ...Object.values(variationsPermissions),
  ...Object.values(procurementPermissions),
  ...Object.values(inventoryPermissions),
];

export const profileOf = (permissions: string[], overrides: Partial<Profile> = {}): Profile => ({
  id: '018f2222-0000-7000-8000-000000000001',
  email: 'person@example.test',
  fullName: 'Test Person',
  locale: 'en',
  version: 1,
  roles: ['admin'],
  permissions,
  scopes: [],
  ...overrides,
});

export interface FakeAuth extends AuthClient {
  token: string | null;
  signedOutCallbacks: (() => void)[];
  /** Simulates the session ending elsewhere. */
  expire(): void;
}

/** A sign-in provider that never leaves the test; `signedIn` decides whether a session exists. */
export function fakeAuth(options: { signedIn?: boolean; wrongPassword?: boolean } = {}): FakeAuth {
  const auth: FakeAuth = {
    token: options.signedIn === false ? null : 'test-token',
    signedOutCallbacks: [],
    getAccessToken: () => Promise.resolve(auth.token),
    signIn: () => {
      if (options.wrongPassword) return Promise.reject(new Error('Invalid login credentials'));
      auth.token = 'test-token';
      return Promise.resolve();
    },
    signOut: () => {
      auth.token = null;
      return Promise.resolve();
    },
    onSignedOut: (callback) => {
      auth.signedOutCallbacks.push(callback);
      return () => {
        auth.signedOutCallbacks = auth.signedOutCallbacks.filter((c) => c !== callback);
      };
    },
    expire() {
      auth.token = null;
      auth.signedOutCallbacks.forEach((callback) => callback());
    },
  };
  return auth;
}

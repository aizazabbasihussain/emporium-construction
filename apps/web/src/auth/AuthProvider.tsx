import { isRtl } from '@emporium/shared';
import { useQueryClient } from '@tanstack/react-query';
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
import { useTranslation } from 'react-i18next';
import { ApiError, setTokenProvider } from '../admin/api';
import { identityApi, type Profile } from './api';
import type { AuthClient } from './client';
import { cacheProfile, cachedProfile, clearCachedProfile } from './profileCache';

export type SignInResult = 'ok' | 'bad_credentials' | 'no_account' | 'error';

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  profile: Profile | null;
}

export interface AuthContextValue extends AuthState {
  /** Whether the signed-in user holds the permission (BR-10); false when signed out. */
  can: (permission: string) => boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  setLanguage: (locale: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

export const directionOf = (language: string): 'rtl' | 'ltr' => (isRtl(language) ? 'rtl' : 'ltr');

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const [state, setState] = useState<AuthState>({ status: 'loading', profile: null });
  const profileRef = useRef<Profile | null>(null);
  // The language instance changes identity when the language changes; handlers go through a ref
  // so switching language never restarts the session check.
  const i18nRef = useRef(i18n);
  i18nRef.current = i18n;

  // BR-9: signing out drops the profile and every cached query.
  const signedOut = useCallback(() => {
    profileRef.current = null;
    clearCachedProfile();
    queryClient.clear();
    setState({ status: 'signedOut', profile: null });
  }, [queryClient]);

  const adopt = useCallback((profile: Profile) => {
    profileRef.current = profile;
    cacheProfile(profile);
    void i18nRef.current.changeLanguage(profile.locale);
    setState({ status: 'signedIn', profile });
  }, []);

  // The API reads the token from the sign-in provider on every call.
  useEffect(() => {
    setTokenProvider(() => client.getAccessToken());
  }, [client]);

  useEffect(() => {
    let active = true;
    void (async () => {
      let profile: Profile | null = null;
      if ((await client.getAccessToken()) !== null) {
        // An answer from the server (even a refusal) decides; only a missing connection falls back
        // to the last known profile, so the shell opens offline.
        profile = await identityApi
          .me()
          .catch((cause: unknown) => (cause instanceof ApiError ? null : cachedProfile()));
      }
      if (!active) return;
      if (profile === null) signedOut();
      else adopt(profile);
    })();
    const unsubscribe = client.onSignedOut(signedOut);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, adopt, signedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      can: (permission) => state.profile?.permissions.includes(permission) ?? false,
      async signIn(email, password) {
        try {
          await client.signIn(email, password);
        } catch {
          return 'bad_credentials';
        }
        try {
          adopt(await identityApi.me());
          return 'ok';
        } catch (error) {
          await client.signOut();
          signedOut();
          return error instanceof ApiError && (error.status === 401 || error.status === 403)
            ? 'no_account'
            : 'error';
        }
      },
      async signOut() {
        await client.signOut();
        signedOut();
      },
      setLanguage(locale) {
        void i18nRef.current.changeLanguage(locale);
        const profile = profileRef.current;
        if (!profile || profile.locale === locale) return;
        // Remember the choice on the account; the screen already switched, so a failure is harmless.
        identityApi
          .setLocale(locale, profile.version)
          .then(adopt)
          .catch(() => undefined);
      },
    }),
    [state, client, adopt, signedOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

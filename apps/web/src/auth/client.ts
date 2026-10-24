import { createClient } from '@supabase/supabase-js';

/** What the shell needs from the sign-in provider; Supabase Auth is one implementation. */
export interface AuthClient {
  getAccessToken(): Promise<string | null>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Called when the session ends elsewhere (expiry, another tab); returns an unsubscribe. */
  onSignedOut(callback: () => void): () => void;
}

/**
 * Supabase Auth keeps the session itself (BR-9): the app never reads or writes tokens in
 * storage, it only asks for the current access token when it calls the API.
 */
export function createSupabaseAuthClient(url: string, anonKey: string): AuthClient {
  const supabase = createClient(url, anonKey);
  return {
    async getAccessToken() {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() {
      await supabase.auth.signOut();
    },
    onSignedOut(callback) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (session === null) callback();
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

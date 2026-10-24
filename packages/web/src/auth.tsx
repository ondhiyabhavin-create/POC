import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { UserIdentity } from '@odr/shared';
import { api, setUnauthorizedHandler, tokenStore, type AuthConfig } from './api';

interface AuthState {
  user: UserIdentity | null;
  config: AuthConfig | null;
  loading: boolean;
  /** Returns a continuation when Cognito requires a new password. */
  signIn: (email: string, password: string) => Promise<void | ((newPassword: string) => Promise<void>)>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    if (config?.mode === 'cognito') void import('./cognito').then((m) => m.cognitoSignOut(config.userPoolId, config.clientId));
  }, [config]);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, [signOut]);

  useEffect(() => {
    (async () => {
      try {
        setConfig(await api.authConfig());
        if (tokenStore.get()) setUser(await api.me());
      } catch {
        tokenStore.clear();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = useCallback<AuthState['signIn']>(
    async (email, password) => {
      if (!config || config.mode === 'local') {
        const res = await api.localLogin(email, password);
        tokenStore.set(res.token);
        setUser(res.user);
        return;
      }
      const { cognitoSignIn } = await import('./cognito');
      const finish = async (idToken: string) => {
        tokenStore.set(idToken);
        const me = await api.me().catch(() => null);
        if (!me) {
          tokenStore.clear();
          throw new Error('Your account could not be verified. Contact your administrator.');
        }
        setUser(me);
      };
      const result = await cognitoSignIn(config.userPoolId, config.clientId, email, password);
      if (result.kind === 'ok') return finish(result.idToken);
      return async (newPassword: string) => {
        const done = await result.complete(newPassword);
        if (done.kind === 'ok') await finish(done.idToken);
      };
    },
    [config],
  );

  const value = useMemo(() => ({ user, config, loading, signIn, signOut }), [user, config, loading, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

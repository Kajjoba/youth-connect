import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api, setAccessToken, onAuthLost, flushQueue } from './api.js';
import { mayHaveSession, rememberSession, forgetSession } from './session-hint.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [restoring, setRestoring] = useState(true);

  /**
   * Session restore on boot.
   *
   * The access token lives in memory, so a page reload loses it. The
   * httpOnly refresh cookie survives, so we exchange it for a new access
   * token before rendering anything that depends on being signed in.
   * Getting this wrong is what causes the flash of a sign-in screen on
   * every refresh.
   *
   * The refresh is SKIPPED entirely when nothing suggests there is a
   * session to restore. See lib/session-hint.js: an anonymous visitor to
   * a public course page used to spend a round trip discovering they were
   * anonymous, which is the one thing they could have known for free.
   */
  useEffect(() => {
    let cancelled = false;

    if (!mayHaveSession()) {
      setRestoring(false);
      return () => {};
    }

    (async () => {
      const refreshed = await api.refresh();
      if (cancelled) return;

      if (refreshed?.user) {
        setUser(refreshed.user);
        rememberSession();
        flushQueue();
      } else {
        // The hint was stale: the cookie has expired or been revoked.
        // Clear it so the next load costs nothing.
        forgetSession();
      }
      setRestoring(false);
    })();

    return () => { cancelled = true; };
  }, []);

  // The API client tells us when a refresh finally failed.
  useEffect(() => onAuthLost(() => {
    setUser(null);
    forgetSession();
  }), []);

  const value = useMemo(() => ({
    user,
    restoring,

    async signIn(credentials) {
      const result = await api.signIn(credentials);
      setAccessToken(result.accessToken);
      setUser(result.user);
      rememberSession();
      flushQueue();
      return result.user;
    },

    // ADR-029. One call handles both a returning Google user and a
    // brand new one; the server decides which this is, same as it
    // would make no sense for the client to ask "sign in or register"
    // before it has even looked at who the credential belongs to.
    async signInWithGoogle(credential) {
      const result = await api.signInWithGoogle(credential);
      setAccessToken(result.accessToken);
      setUser(result.user);
      rememberSession();
      flushQueue();
      return result.user;
    },

    async register(details) {
      const result = await api.register(details);
      setAccessToken(result.accessToken);
      setUser(result.user);
      rememberSession();
      return result.user;
    },

    async signOut() {
      // The hint goes FIRST. If the network call hangs or fails, the
      // browser must not come back believing there is a session, because
      // that turns a sign-out into a silent failure.
      forgetSession();
      await api.signOut().catch(() => {});
      setAccessToken(null);
      setUser(null);
    },

    patchUser(changes) {
      setUser((current) => (current ? { ...current, ...changes } : current));
    }
  }), [user, restoring]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

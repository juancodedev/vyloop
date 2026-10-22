'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

interface User {
  email: string;
  name: string;
  id?: string;
  role?: string;
}

interface StoredSession {
  token: string;
  refreshToken: string;
  email: string;
  user: User;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/** Decode JWT payload without verifying — just to read exp for client-side guard. */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/** Read the current session from localStorage (used by api.ts too). */
export function getSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('auth');
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return null;
}

/** Save a full session object to localStorage. */
export function saveSession(session: StoredSession): void {
  localStorage.setItem('auth', JSON.stringify(session));
}

/** Clear auth and optionally redirect to login. */
export function clearSession(redirect = true): void {
  localStorage.removeItem('auth');
  if (redirect && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

/**
 * Attempt to refresh the access token using the stored refresh token.
 * Returns the new session data on success, or null if refresh failed.
 */
export async function refreshAccessToken(): Promise<StoredSession | null> {
  const session = getSession();
  if (!session?.refreshToken || !session?.email) return null;

  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: session.refreshToken,
        email: session.email,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();

    const newSession: StoredSession = {
      token: data.access_token,
      refreshToken: data.refresh_token,
      email: session.email,
      user: session.user,
    };

    saveSession(newSession);
    return newSession;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore or refresh session on mount
  useEffect(() => {
    const stored = getSession();
    if (!stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLoading(false);
      return;
    }

    if (stored.token && !isTokenExpired(stored.token)) {
      // Token still valid — restore
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUser(stored.user);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToken(stored.token);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRefreshToken(stored.refreshToken);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLoading(false);
      return;
    }

    // Token expired — try refreshing
    refreshAccessToken().then((newSession) => {
      if (newSession) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUser(newSession.user);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setToken(newSession.token);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRefreshToken(newSession.refreshToken);
      } else {
        // Refresh failed — clear session silently (no redirect on init)
        clearSession(false);
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLoading(false);
    });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_URL}/v1/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || 'Credenciales inválidas');
      }

      const data = await res.json();

      const session: StoredSession = {
        token: data.access_token,
        refreshToken: data.refresh_token,
        email: data.user.email,
        user: {
          email: data.user.email,
          name: data.user.fullName,
          id: data.user.id,
          role: data.user.role,
        },
      };

      saveSession(session);
      setUser(session.user);
      setToken(session.token);
      setRefreshToken(session.refreshToken);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setToken(null);
    setRefreshToken(null);
    clearSession(false);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, refreshToken, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

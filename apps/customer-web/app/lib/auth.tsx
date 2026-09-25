'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';

import { api, ApiError } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerInfo {
  /** Maps to login API `customer.name` (the customer's fullName from DB) */
  fullName: string;
  globalId: string;
}

/**
 * Why a login attempt did not produce a session.
 *
 * - `not_registered`: the gateway answered 401 — the phone is unknown or the
 *   customer was deleted. Retrying the same number will not help.
 * - `unavailable`: the request never produced a trustworthy answer (network
 *   failure, or a 5xx from a misconfigured/overloaded gateway). Retrying is
 *   reasonable and the user did nothing wrong.
 * - `unknown`: any other outcome. Treated as a generic, non-committal failure.
 */
export type LoginFailureReason = 'not_registered' | 'unavailable' | 'unknown';

export type LoginResult = { ok: true } | { ok: false; reason: LoginFailureReason };

interface AuthContextValue {
  customer: CustomerInfo | null;
  login: (phone: string, businessSlug?: string) => Promise<LoginResult>;
  isAuthenticated: () => boolean;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  customer: null,
  login: async () => ({ ok: false, reason: 'unknown' }),
  isAuthenticated: () => false,
  logout: () => {},
  isLoading: true,
});

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const JWT_KEY = 'vyloop_jwt';
const CUSTOMER_KEY = 'vyloop_customer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Naive JWT expiry check — decodes the payload and compares `exp` to now. */
function isTokenValid(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/**
 * Detects a request that never produced a response.
 *
 * An HTTP response that already reached us is a server outcome, not a local
 * outage, even when the gateway text happens to read like a fetch failure.
 */
function isNetworkError(error: unknown): boolean {
  if (error instanceof ApiError) return false;

  return (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message))
  );
}

/** Maps a thrown value from the login call onto an honest, actionable reason. */
function classifyLoginFailure(error: unknown): LoginFailureReason {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'not_registered';
    if (error.status >= 500) return 'unavailable';
    return 'unknown';
  }

  if (isNetworkError(error)) return 'unavailable';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const jwt = localStorage.getItem(JWT_KEY);
    const stored = localStorage.getItem(CUSTOMER_KEY);

    if (jwt && stored && isTokenValid(jwt)) {
      try {
        setCustomer(JSON.parse(stored));
      } catch {
        // Corrupted data — clear everything
        localStorage.removeItem(JWT_KEY);
        localStorage.removeItem(CUSTOMER_KEY);
      }
    } else if (jwt && !isTokenValid(jwt)) {
      // Expired token — clean up
      localStorage.removeItem(JWT_KEY);
      localStorage.removeItem(CUSTOMER_KEY);
    }

    setIsLoading(false);
  }, []);

  const login = useCallback(
    async (phone: string, businessSlug?: string): Promise<LoginResult> => {
      try {
        const result = await api.loginCustomer(phone, businessSlug);
        const info: CustomerInfo = {
          fullName: result.customer.name,
          globalId: result.customer.globalId,
        };

        localStorage.setItem(JWT_KEY, result.token);
        localStorage.setItem(CUSTOMER_KEY, JSON.stringify(info));
        setCustomer(info);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: classifyLoginFailure(error) };
      }
    },
    [],
  );

  const isAuthenticated = useCallback((): boolean => {
    const jwt = localStorage.getItem(JWT_KEY);
    if (!jwt) return false;
    return isTokenValid(jwt);
  }, []);

  const logout = useCallback(() => {
    setCustomer(null);
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(CUSTOMER_KEY);
  }, []);

  return (
    <AuthContext.Provider
      value={{ customer, login, isAuthenticated, logout, isLoading }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth() {
  return useContext(AuthContext);
}

'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';

import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomerInfo {
  /** Maps to login API `customer.name` (the customer's fullName from DB) */
  fullName: string;
  globalId: string;
}

interface AuthContextValue {
  customer: CustomerInfo | null;
  login: (phone: string, businessSlug?: string) => Promise<boolean>;
  isAuthenticated: () => boolean;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  customer: null,
  login: async () => false,
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
    async (phone: string, businessSlug?: string): Promise<boolean> => {
      try {
        const result = await api.loginCustomer(phone, businessSlug);
        const info: CustomerInfo = {
          fullName: result.customer.name,
          globalId: result.customer.globalId,
        };

        localStorage.setItem(JWT_KEY, result.token);
        localStorage.setItem(CUSTOMER_KEY, JSON.stringify(info));
        setCustomer(info);
        return true;
      } catch {
        return false;
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

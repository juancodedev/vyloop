'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import {
  MOCK_CUSTOMER,
  getCustomerByPhone,
  type CustomerProfile,
} from './mock-data';

interface AuthContextValue {
  customer: CustomerProfile | null;
  login: (phone: string) => boolean;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  customer: null,
  login: () => false,
  logout: () => {},
  isLoading: true,
});

const STORAGE_KEY = 'vyloop_customer_id';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === MOCK_CUSTOMER.id) {
      setCustomer(MOCK_CUSTOMER);
    }
    setIsLoading(false);
  }, []);

  const login = useCallback((phone: string): boolean => {
    const found = getCustomerByPhone(phone);
    if (found) {
      setCustomer(found);
      localStorage.setItem(STORAGE_KEY, found.id);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    setCustomer(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <AuthContext.Provider value={{ customer, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

'use client';

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

interface SidebarContextValue {
  collapsed: boolean;
  isMobile: boolean;
  mobileOpen: boolean;
  toggle: () => void;
  openMobile: () => void;
  closeMobile: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Hydrate from localStorage and matchMedia on mount
  useEffect(() => {
    setCollapsed(localStorage.getItem('vy-sidebar-collapsed') === 'true');
    setIsMobile(window.matchMedia('(max-width: 767px)').matches);
  }, []);

  // Listen for viewport changes — close mobile drawer when resizing to desktop
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileOpen(false);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const toggle = useCallback(() => {
    if (isMobile) {
      setMobileOpen((prev) => !prev);
    } else {
      setCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem('vy-sidebar-collapsed', String(next));
        return next;
      });
    }
  }, [isMobile]);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  return (
    <SidebarContext.Provider
      value={{ collapsed, isMobile, mobileOpen, toggle, openMobile, closeMobile }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider');
  return ctx;
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from '@/lib/auth';

// Minimal inline SVG icons
const IconUsers = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const IconStar = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

const IconSettings = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconLayers = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const _IconLogOut = () => (
  <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') {
    return pathname === '/dashboard';
  }
  return pathname.startsWith(href);
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  useEffect(() => {
    if (!user) {
      router.push('/login');
    }
  }, [user, router]);

  if (!user) return null;

  return (
    <div className="dashboard-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h2>
            <span className="brand-accent">V</span>yloop
          </h2>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section-label">Navegación</div>

          <Link
            href="/dashboard/customers"
            className={isActive(pathname, '/dashboard/customers') ? 'active' : ''}
          >
            <IconUsers />
            <span>Clientes</span>
          </Link>

          <div className="sidebar-section-label">Lealtad</div>

          <Link
            href="/dashboard/loyalty/config"
            className={isActive(pathname, '/dashboard/loyalty/config') ? 'active sub-nav' : 'sub-nav'}
          >
            <IconSettings />
            <span>Configuración</span>
          </Link>

          <Link
            href="/dashboard/loyalty/tiers"
            className={isActive(pathname, '/dashboard/loyalty/tiers') ? 'active sub-nav' : 'sub-nav'}
          >
            <IconLayers />
            <span>Niveles</span>
          </Link>

          <Link
            href="/dashboard/loyalty/customers"
            className={isActive(pathname, '/dashboard/loyalty/customers') ? 'active sub-nav' : 'sub-nav'}
          >
            <IconStar />
            <span>Puntos</span>
          </Link>
        </nav>

        <div className="sidebar-footer">
          <div className="business-name">Café Central</div>
        </div>
      </aside>

      {/* Main area */}
      <div className="main-area">
        <header className="main-topbar">
          <div className="page-title">
            {pathname === '/dashboard/customers' && 'Clientes'}
            {pathname.match(/^\/dashboard\/customers\/(.+)/) && 'Detalle del Cliente'}
            {pathname === '/dashboard/loyalty/config' && 'Configuración de Lealtad'}
            {pathname === '/dashboard/loyalty/tiers' && 'Niveles de Lealtad'}
            {pathname === '/dashboard/loyalty/customers' && 'Puntos de Clientes'}
            {pathname === '/dashboard' && 'Panel Principal'}
          </div>
          <div className="topbar-right">
            <span className="user-info">{user.email}</span>
            <button className="btn-logout" onClick={() => { logout(); router.push('/login'); }}>
              Salir
            </button>
          </div>
        </header>

        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}

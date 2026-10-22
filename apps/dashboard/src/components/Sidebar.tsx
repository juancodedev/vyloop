'use client';

import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import styles from './Sidebar.module.css';

import { useAuth } from '@/lib/auth';
import { NAV_SECTIONS, BOTTOM_ITEMS, isActive } from '@/lib/navigation';
import { useSidebar } from '@/lib/sidebar-context';


export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, isMobile, mobileOpen, toggle, closeMobile } = useSidebar();
  const { logout } = useAuth();

  const handleNavClick = () => {
    if (isMobile) closeMobile();
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const sidebarContent = (
    <>
      {/* Brand */}
      <div className={styles.brand}>
        <span className={styles.brandAccent}>V</span>
        {(!collapsed || isMobile) && <span className={styles.brandName}>yloop</span>}
      </div>

      {/* Navigation sections */}
      <nav className={styles.nav}>
        {NAV_SECTIONS.map((section, idx) => (
          <div key={idx} className={styles.section}>
            {section.title && (!collapsed || isMobile) && (
              <div className={styles.sectionTitle}>{section.title}</div>
            )}
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleNavClick}
                  className={clsx(styles.navLink, active && styles.navLinkActive)}
                >
                  <Icon className={styles.navIcon} aria-hidden="true" />
                  {(!collapsed || isMobile) && (
                    <span className={styles.navLabel}>{item.label}</span>
                  )}
                  {collapsed && !isMobile && (
                    <span className={styles.tooltip} role="tooltip">
                      {item.label}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Bottom area */}
      <div className={styles.bottom}>
        {BOTTOM_ITEMS.map((item) => {
          const Icon = item.icon;
          if (item.isAction) {
            return (
              <button
                key={item.label}
                onClick={handleLogout}
                className={clsx(styles.navLink, styles.navLinkAction)}
              >
                <Icon className={styles.navIcon} aria-hidden="true" />
                {(!collapsed || isMobile) && (
                  <span className={styles.navLabel}>{item.label}</span>
                )}
                {collapsed && !isMobile && (
                  <span className={styles.tooltip} role="tooltip">
                    {item.label}
                  </span>
                )}
              </button>
            );
          }
          return null;
        })}

        {/* Collapse toggle — desktop only */}
        {!isMobile && (
          <button
            onClick={toggle}
            className={styles.toggleBtn}
            aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        )}
      </div>
    </>
  );

  // Mobile: drawer overlay
  if (isMobile) {
    return (
      <>
        {mobileOpen && (
          <div
            className={styles.backdrop}
            onClick={closeMobile}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeMobile();
            }}
            role="presentation"
          />
        )}
        <aside
          className={clsx(styles.sidebar, mobileOpen && styles.mobileOpen)}
        >
          {sidebarContent}
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar
  return (
    <aside className={clsx(styles.sidebar, collapsed && styles.collapsed)}>
      {sidebarContent}
    </aside>
  );
}

'use client';

import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import styles from './Sidebar.module.css';

import { useAuth } from '@/lib/auth';
import { NAV_SECTIONS, BOTTOM_ITEMS, PRIMARY_ACTION, isActive } from '@/lib/navigation';
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

  const expanded = !collapsed || isMobile;
  const PrimaryIcon = PRIMARY_ACTION.icon;

  const sidebarContent = (
    <>
      {/* Brand */}
      <div className={styles.brand}>{expanded ? 'vyloop' : 'v'}</div>

      {/* The till, ahead of everything else */}
      <Link
        href={PRIMARY_ACTION.href}
        onClick={handleNavClick}
        className={styles.primaryAction}
        aria-label={expanded ? undefined : PRIMARY_ACTION.label}
      >
        <PrimaryIcon className={styles.navIcon} aria-hidden="true" />
        {expanded && <span>{PRIMARY_ACTION.label}</span>}
      </Link>

      {/* Navigation sections */}
      <nav className={styles.nav} aria-label="Panel">
        {NAV_SECTIONS.map((section, idx) => (
          <div key={idx} className={styles.section}>
            {section.title && expanded && (
              <div className={styles.sectionTitle}>{section.title}</div>
            )}
            {section.items.map((item) => {
              const Icon = item.icon;
              if (item.comingSoon) {
                return (
                  <span
                    key={item.href}
                    className={clsx(styles.navLink, styles.navLinkSoon)}
                    aria-disabled="true"
                  >
                    <Icon className={styles.navIcon} aria-hidden="true" />
                    {expanded && <span className={styles.navLabel}>{item.label}</span>}
                    {expanded && <span className={styles.soonTag}>Próximamente</span>}
                    {collapsed && !isMobile && (
                      <span className={styles.tooltip} role="tooltip">
                        {item.label} (próximamente)
                      </span>
                    )}
                  </span>
                );
              }
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleNavClick}
                  className={clsx(styles.navLink, active && styles.navLinkActive)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon className={styles.navIcon} aria-hidden="true" />
                  {expanded && <span className={styles.navLabel}>{item.label}</span>}
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
                {expanded && <span className={styles.navLabel}>{item.label}</span>}
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
        <aside className={clsx(styles.sidebar, mobileOpen && styles.mobileOpen)}>
          {sidebarContent}
        </aside>
      </>
    );
  }

  // Desktop: fixed sidebar
  return (
    <aside className={clsx(styles.sidebar, collapsed && styles.collapsed)}>{sidebarContent}</aside>
  );
}

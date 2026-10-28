'use client';

import { Menu } from 'lucide-react';
import { usePathname } from 'next/navigation';

import styles from './Topbar.module.css';

import { useAuth } from '@/lib/auth';
import { getPageTitle } from '@/lib/navigation';
import { useSidebar } from '@/lib/sidebar-context';

export function Topbar() {
  const pathname = usePathname();
  const { isMobile, openMobile } = useSidebar();
  // Signing out lives in the sidebar, once.
  const { user } = useAuth();
  const title = getPageTitle(pathname);

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {isMobile && (
          <button onClick={openMobile} className={styles.hamburger} aria-label="Abrir menú">
            <Menu size={20} />
          </button>
        )}
        <h1 className={styles.title}>{title}</h1>
      </div>

      <div className={styles.right}>
        <span className={styles.userEmail}>{user?.email ?? 'Usuario'}</span>
      </div>
    </header>
  );
}

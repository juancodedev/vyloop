'use client';

import { Button } from '@vyloop/design-system';
import { Menu, LogOut } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';

import styles from './Topbar.module.css';

import { useAuth } from '@/lib/auth';
import { getPageTitle } from '@/lib/navigation';
import { useSidebar } from '@/lib/sidebar-context';



export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile, openMobile } = useSidebar();
  const { user, logout } = useAuth();
  const title = getPageTitle(pathname);

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {isMobile && (
          <button
            onClick={openMobile}
            className={styles.hamburger}
            aria-label="Abrir menú"
          >
            <Menu size={20} />
          </button>
        )}
        <h1 className={styles.title}>{title}</h1>
      </div>

      <div className={styles.right}>
        <span className={styles.userEmail}>{user?.email ?? 'Usuario'}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          aria-label="Cerrar sesión"
          icon={<LogOut size={16} />}
          className={styles.logoutBtn}
        />
      </div>
    </header>
  );
}

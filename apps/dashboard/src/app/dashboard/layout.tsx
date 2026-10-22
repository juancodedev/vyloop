'use client';

import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import styles from './layout.module.css';

import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { useAuth } from '@/lib/auth';
import { SidebarProvider, useSidebar } from '@/lib/sidebar-context';


function DashboardContent({ children }: { children: ReactNode }) {
  const { collapsed, isMobile } = useSidebar();

  return (
    <div className={styles.layout}>
      <Sidebar />
      <div
        className={clsx(
          styles.contentArea,
          collapsed && !isMobile && styles.contentCollapsed,
        )}
      >
        <Topbar />
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading) return null;
  if (!user) return null;

  return (
    <SidebarProvider>
      <DashboardContent>{children}</DashboardContent>
    </SidebarProvider>
  );
}

import type { ReactNode } from 'react';

import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';

import { Header } from './components/Header';
import styles from './layout.module.css';

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <p className={styles.footerText}>
          &copy; {new Date().getFullYear()} Vyloop — Todos los derechos reservados.
        </p>
      </footer>
    </div>
  );
}

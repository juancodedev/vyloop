import Link from 'next/link';

import { CashierPreview } from './(landing)/components/CashierPreview';
import { Features } from './(landing)/components/Features';
import { Header } from './(landing)/components/Header';
import { Hero } from './(landing)/components/Hero';
import { HowItWorks } from './(landing)/components/HowItWorks';
import styles from './(landing)/landing.module.css';

export default function LandingPage() {
  return (
    <div id="inicio" className={styles.page}>
      <Header />
      <main>
        <Hero />
        <HowItWorks />
        <CashierPreview />
        <Features />
        <section className={`${styles.wrap} ${styles.closing}`}>
          <div className={styles.closingSign}>
            <h2 className={`${styles.display} ${styles.closingTitle}`}>
              Arma tu programa hoy y pega el QR mañana.
            </h2>
            <Link href="/login?signup=true" className={`${styles.pill} ${styles.pillInk}`}>
              Crear mi comercio
            </Link>
          </div>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={`${styles.wrap} ${styles.footerInner}`}>
          <p>
            <span className={styles.footerBrand}>vyloop</span> es de Lawen Tech Solutions SPA,
            Santiago de Chile.
          </p>
          <div className={styles.footerLinks}>
            <Link href="/login">Iniciar sesión</Link>
            <a href="#inicio">Volver arriba</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

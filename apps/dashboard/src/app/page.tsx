import { Header } from './(landing)/components/Header';
import { Hero } from './(landing)/components/Hero';
import { HowItWorks } from './(landing)/components/HowItWorks';
import { Features } from './(landing)/components/Features';
import styles from './(landing)/layout.module.css';

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <Header />
      <main className={styles.main}>
        <Hero />
        <HowItWorks />
        <Features />
      </main>
      <footer className={styles.footer}>
        <p className={styles.footerText}>
          &copy; {new Date().getFullYear()} Vyloop — Todos los derechos reservados.
        </p>
      </footer>
    </div>
  );
}

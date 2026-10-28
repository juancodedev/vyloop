'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import styles from '../landing.module.css';

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className={`${styles.wrap} ${styles.header}`}>
      <Link href="/" className={styles.logo}>
        vyloop
      </Link>

      <button
        type="button"
        className={styles.menuToggle}
        onClick={() => setOpen(!open)}
        aria-label={open ? 'Cerrar menú' : 'Abrir menú'}
        aria-expanded={open}
        aria-controls="landing-nav"
      >
        {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
      </button>

      <nav
        id="landing-nav"
        aria-label="Principal"
        className={`${styles.nav} ${open ? styles.navOpen : ''}`}
      >
        <a href="#como-funciona" className={styles.navLink} onClick={close}>
          Cómo funciona
        </a>
        <a href="#que-incluye" className={styles.navLink} onClick={close}>
          Qué incluye
        </a>
        <Link href="/login" className={styles.navLink}>
          Iniciar sesión
        </Link>
        <Link href="/login?signup=true" className={`${styles.pill} ${styles.navCta}`}>
          Crear mi comercio
        </Link>
      </nav>
    </header>
  );
}

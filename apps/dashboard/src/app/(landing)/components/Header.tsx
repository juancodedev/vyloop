'use client';

import { Button } from '@vyloop/design-system';
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import styles from './Header.module.css';

const NAV_LINKS = [
  { label: 'Características', href: '#features' },
  { label: 'Precios', href: '#pricing' },
];

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          vyloop
        </Link>

        {/* Desktop nav */}
        <nav className={styles.desktopNav}>
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={styles.navLink}>
              {link.label}
            </Link>
          ))}
          <Link href="/login" className={styles.navLink}>
            Iniciar sesión
          </Link>
          <Link href="/login?signup=true">
            <Button variant="primary" size="md">
              Comenzar gratis
            </Button>
          </Link>
        </nav>

        {/* Mobile toggle */}
        <button
          type="button"
          className={styles.menuToggle}
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label={mobileOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile nav */}
      {mobileOpen && (
        <nav className={styles.mobileNav}>
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={styles.mobileNavLink}
              onClick={() => setMobileOpen(false)}
            >
              {link.label}
            </Link>
          ))}
          <Link
            href="/login"
            className={styles.mobileNavLink}
            onClick={() => setMobileOpen(false)}
          >
            Iniciar sesión
          </Link>
          <Link
            href="/login?signup=true"
            className={styles.mobileCta}
            onClick={() => setMobileOpen(false)}
          >
            <Button variant="primary" size="md" fullWidth>
              Comenzar gratis
            </Button>
          </Link>
        </nav>
      )}
    </header>
  );
}

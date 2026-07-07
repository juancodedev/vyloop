import { Github, Twitter, Mail } from 'lucide-react';
import Link from 'next/link';

import styles from './Footer.module.css';

const LINK_COLUMNS = [
  {
    title: 'Producto',
    links: [
      { label: 'Características', href: '#features' },
      { label: 'Precios', href: '#pricing' },
    ],
  },
  {
    title: 'Compañía',
    links: [
      { label: 'Blog', href: '#' },
      { label: 'Sobre nosotros', href: '#' },
    ],
  },
  {
    title: 'Soporte',
    links: [
      { label: 'FAQ', href: '#faq' },
      { label: 'Contacto', href: '#' },
    ],
  },
];

const SOCIAL_LINKS = [
  { label: 'GitHub', href: '#', icon: Github },
  { label: 'Twitter', href: '#', icon: Twitter },
  { label: 'Email', href: 'mailto:hola@vyloop.com', icon: Mail },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Link href="/" className={styles.logo}>
            vyloop
          </Link>
          <p className={styles.tagline}>
            Lealtad simple para negocios latinoamericanos
          </p>
        </div>
        <div className={styles.links}>
          {LINK_COLUMNS.map((col) => (
            <div key={col.title} className={styles.linkColumn}>
              <h4 className={styles.linkColumnTitle}>{col.title}</h4>
              <ul className={styles.linkList}>
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className={styles.link}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={styles.social}>
          {SOCIAL_LINKS.map((s) => {
            const Icon = s.icon;
            return (
              <a
                key={s.label}
                href={s.href}
                className={styles.socialLink}
                aria-label={s.label}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon size={18} aria-hidden="true" />
              </a>
            );
          })}
        </div>
      </div>
      <div className={styles.bottom}>
        <p className={styles.copyright}>
          &copy; {new Date().getFullYear()} vyloop. Todos los derechos reservados.
        </p>
        <div className={styles.legal}>
          <Link href="#" className={styles.legalLink}>
            Términos del servicio
          </Link>
          <span className={styles.separator}>·</span>
          <Link href="#" className={styles.legalLink}>
            Política de privacidad
          </Link>
        </div>
      </div>
    </footer>
  );
}

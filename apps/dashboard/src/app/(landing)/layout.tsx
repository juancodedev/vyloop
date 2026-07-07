import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';

import { Footer } from './components/Footer';
import { Header } from './components/Header';
import styles from './layout.module.css';

export const metadata: Metadata = {
  title: 'vyloop — Lealtad simple para tu negocio',
  description:
    'Crea un programa de lealtad en minutos. Tus clientes acumulan puntos, tú retienes más. Sin contratos ni tecnicismos.',
  openGraph: {
    title: 'vyloop — Lealtad simple para tu negocio',
    description:
      'Crea un programa de lealtad en minutos. Tus clientes acumulan puntos, tú retienes más. Sin contratos ni tecnicismos.',
    url: 'https://vyloop.com',
    siteName: 'vyloop',
    locale: 'es_LA',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
  },
  robots: {
    index: true,
    follow: true,
  },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'vyloop',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  description:
    'Programa de lealtad para pequeñas y medianas empresas en Latinoamérica.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
};

export default function LandingLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className={styles.page}>
        <Header />
        <main className={styles.main}>{children}</main>
        <Footer />
      </div>
    </>
  );
}

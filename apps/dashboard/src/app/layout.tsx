import type { Metadata } from 'next';
import { Bricolage_Grotesque, Instrument_Sans } from 'next/font/google';

import { AuthProvider } from '@/lib/auth';
import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';
import './globals.css';

const body = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-body',
});

const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
});

export const metadata: Metadata = {
  title: 'vyloop: puntos para tu café o almacén',
  description:
    'Un programa de puntos para tu local. Tus clientes suman según lo que compran y lo ven en Google Wallet.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${body.variable} ${display.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

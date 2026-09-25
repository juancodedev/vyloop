import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';

import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';
import './globals.css';
import { AuthProvider } from './lib/auth';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Vyloop',
  description: 'Tu programa de lealtad para acumular y canjear puntos.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3eee5',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="customer-web">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

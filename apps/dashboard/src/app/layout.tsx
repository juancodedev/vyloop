import type { Metadata } from 'next';

import '@vyloop/design-system/tokens';
import '@vyloop/design-system/styles';

import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vyloop — Dashboard',
  description: 'Vyloop Platform — Loyalty & Growth Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

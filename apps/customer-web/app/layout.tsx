import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from './lib/auth';

export const metadata: Metadata = {
  title: 'Vyloop',
  description: 'Tu programa de lealtad para acumular y canjear puntos.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f59e0b',
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

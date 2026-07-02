import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Vyloop — Registro',
  description:
    'Registrate en el programa de lealtad y empezá a acumular puntos.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#2563eb',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}

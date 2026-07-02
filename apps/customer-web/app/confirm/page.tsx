'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

export default function ConfirmPage() {
  const searchParams = useSearchParams();
  const name = searchParams.get('name') ?? 'Cliente';

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <div style={styles.icon}>✅</div>

        <h1 style={styles.title}>¡Gracias, {name}!</h1>
        <p style={styles.subtitle}>
          Te has registrado correctamente. Ya podés empezar a acumular puntos
          con tus compras en este local.
        </p>

        <Link href="/" style={styles.button}>
          Volver al inicio
        </Link>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    background: '#f9fafb',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    background: 'white',
    borderRadius: '16px',
    padding: '32px 24px',
    maxWidth: '360px',
    width: '100%',
    textAlign: 'center',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  icon: {
    fontSize: '48px',
    marginBottom: '16px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 700,
    margin: '0 0 8px',
    color: '#111827',
  },
  subtitle: {
    fontSize: '14px',
    color: '#6b7280',
    margin: '0 0 24px',
    lineHeight: 1.5,
  },
  button: {
    display: 'inline-block',
    width: '100%',
    padding: '14px 0',
    background: '#2563eb',
    color: 'white',
    fontSize: '16px',
    fontWeight: 600,
    borderRadius: '10px',
    border: 'none',
    cursor: 'pointer',
    textDecoration: 'none',
    minHeight: '48px',
    lineHeight: '20px',
  },
};

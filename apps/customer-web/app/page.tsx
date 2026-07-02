import Link from 'next/link';

export default function Home() {
  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <div style={styles.qrPlaceholder}>
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
            <rect x="8" y="8" width="44" height="44" rx="4" fill="#e5e7eb" />
            <rect x="18" y="18" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="34" y="18" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="18" y="34" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="68" y="8" width="44" height="44" rx="4" fill="#e5e7eb" />
            <rect x="78" y="18" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="94" y="18" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="78" y="34" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="8" y="68" width="44" height="44" rx="4" fill="#e5e7eb" />
            <rect x="18" y="78" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="34" y="78" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="18" y="94" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="68" y="68" width="44" height="44" rx="4" fill="#e5e7eb" />
            <rect x="78" y="78" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="94" y="78" width="8" height="8" rx="1" fill="#9ca3af" />
            <rect x="78" y="94" width="8" height="8" rx="1" fill="#9ca3af" />
          </svg>
        </div>

        <h1 style={styles.title}>¡Bienvenido!</h1>
        <p style={styles.subtitle}>
          Escaneá el código QR en el local para registrarte y empezar a
          acumular puntos.
        </p>

        <Link href="/register" style={styles.button}>
          Registrarme
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
  qrPlaceholder: {
    marginBottom: '24px',
    display: 'flex',
    justifyContent: 'center',
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

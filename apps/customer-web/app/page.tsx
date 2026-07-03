'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from './lib/auth';

export default function Home() {
  const router = useRouter();
  const { customer, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && customer) {
      router.replace('/profile');
    }
  }, [isLoading, customer, router]);

  if (isLoading) {
    return <div className="loading">Cargando...</div>;
  }

  if (customer) {
    return null;
  }

  return (
    <div className="page page--centered fade-in">
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="qr-icon">
          <svg width="100" height="100" viewBox="0 0 120 120" fill="none">
            <rect
              x="8"
              y="8"
              width="44"
              height="44"
              rx="4"
              fill="#fde68a"
            />
            <rect
              x="18"
              y="18"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="34"
              y="18"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="18"
              y="34"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="68"
              y="8"
              width="44"
              height="44"
              rx="4"
              fill="#fde68a"
            />
            <rect
              x="78"
              y="18"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="94"
              y="18"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="78"
              y="34"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="8"
              y="68"
              width="44"
              height="44"
              rx="4"
              fill="#fde68a"
            />
            <rect
              x="18"
              y="78"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="34"
              y="78"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="18"
              y="94"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="68"
              y="68"
              width="44"
              height="44"
              rx="4"
              fill="#fde68a"
            />
            <rect
              x="78"
              y="78"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="94"
              y="78"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
            <rect
              x="78"
              y="94"
              width="8"
              height="8"
              rx="1"
              fill="#f59e0b"
            />
          </svg>
        </div>

        <h1 className="title">¡Bienvenido!</h1>
        <p className="subtitle">
          Escaneá el código QR en el local para registrarte y empezar a
          acumular puntos.
        </p>

        <div className="landing-buttons">
          <Link href="/login" className="btn btn--primary">
            Ingresar
          </Link>
          <Link href="/register" className="btn btn--outline">
            Registrarme
          </Link>
        </div>
      </div>
    </div>
  );
}

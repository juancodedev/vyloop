'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useAuth } from '../lib/auth';

export default function ProfilePage() {
  const router = useRouter();
  const { customer, logout, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

  if (isLoading) {
    return <div className="loading">Cargando...</div>;
  }

  if (!customer) {
    return null;
  }

  return (
    <div className="page fade-in">
      {/* Welcome */}
      <div className="welcome-header">
        <h1 className="welcome-header__greeting">
          ¡Hola, {customer.fullName.split(' ')[0]}!
        </h1>
      </div>

      {/* Quick actions */}
      <div className="card card--compact" style={{ marginBottom: 16 }}>
        <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
          Tus puntos y movimientos estarán disponibles pronto.
        </p>
      </div>

      <Link
        href="/profile/history"
        className="btn btn--secondary"
        style={{ marginBottom: 20 }}
      >
        Ver historial
      </Link>

      {/* Logout */}
      <button
        type="button"
        className="logout-btn"
        onClick={() => {
          logout();
          router.push('/');
        }}
      >
        Cerrar sesión
      </button>
    </div>
  );
}

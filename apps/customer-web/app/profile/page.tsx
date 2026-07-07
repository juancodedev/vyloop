'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { api, type CustomerProfile } from '../lib/api';
import { useAuth } from '../lib/auth';

const CID_KEY = 'vyloop_customer_id';

export default function ProfilePage() {
  const router = useRouter();
  const { customer, logout, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !customer) {
      router.replace('/login');
    }
  }, [authLoading, customer, router]);

  useEffect(() => {
    if (!customer) return;

    setFetching(true);
    api
      .getProfile()
      .then((data) => {
        setProfile(data);
        // Persist internal customer id so rewards/history can use it
        localStorage.setItem(CID_KEY, data.id);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFetching(false));
  }, [customer]);

  if (authLoading || fetching) {
    return <div className="loading">Cargando...</div>;
  }

  if (!customer) {
    return null;
  }

  if (error) {
    return (
      <div className="page fade-in">
        <div className="error-box">{error}</div>
        <button
          type="button"
          className="btn btn--secondary"
          style={{ marginTop: 16 }}
          onClick={() => window.location.reload()}
        >
          Reintentar
        </button>
      </div>
    );
  }

  const p = profile;

  return (
    <div className="page fade-in">
      {/* Welcome */}
      <div className="welcome-header">
        <h1 className="welcome-header__greeting">
          ¡Hola, {customer.fullName.split(' ')[0]}!
        </h1>
      </div>

      {/* Points card */}
      <div className="card card--compact" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
              Tus puntos
            </p>
            <p style={{ fontSize: 28, fontWeight: 700, margin: '4px 0 0' }}>
              {p ? p.points.toLocaleString('es-CL') : '—'}
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>
              Categoría
            </p>
            <p style={{ fontSize: 16, fontWeight: 600, margin: '4px 0 0', color: '#2563eb' }}>
              {p?.currentTier ?? 'Bronce'}
            </p>
          </div>
        </div>
        {p && (
          <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Total acumulado: {p.totalPointsEarned.toLocaleString('es-CL')} pts
          </p>
        )}
      </div>

      <Link
        href="/profile/history"
        className="btn btn--secondary"
        style={{ marginBottom: 20 }}
      >
        Ver historial
      </Link>

      <Link
        href="/profile/rewards"
        className="btn btn--primary"
        style={{ marginBottom: 20 }}
      >
        Canjear puntos
      </Link>

      {/* Logout */}
      <button
        type="button"
        className="logout-btn"
        onClick={() => {
          localStorage.removeItem(CID_KEY);
          logout();
          router.push('/');
        }}
      >
        Cerrar sesión
      </button>
    </div>
  );
}

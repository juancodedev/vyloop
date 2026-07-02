'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { MOCK_MOVEMENTS } from '../../lib/mock-data';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

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

  const recentMovements = MOCK_MOVEMENTS.slice(0, 3);

  return (
    <div className="page fade-in">
      {/* Business name */}
      <div className="business-name">{customer.businessName}</div>

      {/* Welcome */}
      <div className="welcome-header">
        <h1 className="welcome-header__greeting">
          ¡Hola, {customer.fullName.split(' ')[0]}!
        </h1>
        <p className="welcome-header__member-since">
          Miembro desde {customer.memberSince}
        </p>
      </div>

      {/* Points Card */}
      <div className="points-card">
        <div className="points-card__label">Tus puntos</div>
        <div className="points-card__value">
          {customer.points.toLocaleString('es-CL')} pts
        </div>
        <div className="points-card__sublabel">
          {customer.currentTier.name} · Multiplicador ×
          {customer.currentTier.multiplier}
        </div>
      </div>

      {/* Tier */}
      <div className="card card--compact" style={{ marginBottom: 16 }}>
        <div className="tier-section" style={{ marginBottom: 0 }}>
          <div className="tier-header">
            <div className="tier-badge">
              <span className="tier-badge__icon">🏅</span>
              {customer.currentTier.name}
            </div>
          </div>
          <div className="tier-info">{customer.currentTier.benefits}</div>
        </div>
      </div>

      {/* Progress to next tier */}
      {customer.nextTier && (
        <div className="card card--compact" style={{ marginBottom: 16 }}>
          <div className="progress-section" style={{ marginBottom: 0 }}>
            <div className="progress-label">
              <span>
                Próximo nivel:{' '}
                <strong>{customer.nextTier.name}</strong>
              </span>
              <span>{Math.round(customer.progressToNextTier)}%</span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-bar__fill"
                style={{ width: `${customer.progressToNextTier}%` }}
              />
            </div>
            <div className="progress-hint">
              Faltan{' '}
              {(customer.nextTier.minPoints - customer.points).toLocaleString(
                'es-CL'
              )}{' '}
              pts para llegar a {customer.nextTier.name}
            </div>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <Link href="/profile/history" className="btn btn--secondary" style={{ marginBottom: 20 }}>
        Ver historial
      </Link>

      {/* Recent movements */}
      <div className="card card--compact" style={{ marginBottom: 16 }}>
        <h2 className="section-title">Últimos movimientos</h2>

        {recentMovements.length === 0 ? (
          <div className="empty-state">Aún no tenés movimientos</div>
        ) : (
          recentMovements.map((mov) => (
            <div className="movement" key={mov.id}>
              <div
                className={`movement__icon ${
                  mov.type === 'earned'
                    ? 'movement__icon--earned'
                    : 'movement__icon--redeemed'
                }`}
              >
                {mov.type === 'earned' ? '↑' : '↓'}
              </div>
              <div className="movement__body">
                <div className="movement__description">
                  {mov.description}
                </div>
                <div className="movement__date">
                  {formatDate(mov.date)}
                </div>
              </div>
              <div>
                <div
                  className={`movement__points ${
                    mov.type === 'earned'
                      ? 'movement__points--earned'
                      : 'movement__points--redeemed'
                  }`}
                >
                  {mov.type === 'earned' ? '+' : '-'}
                  {mov.points.toLocaleString('es-CL')}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

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

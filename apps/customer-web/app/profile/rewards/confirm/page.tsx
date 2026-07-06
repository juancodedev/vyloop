'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

import { useAuth } from '../../../lib/auth';

function ConfirmContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer, isLoading } = useAuth();

  const rewardName = searchParams.get('name');
  const pointsCost = searchParams.get('points');
  const remainingBalance = searchParams.get('balance');

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

  // Redirect back if no reward info (direct access without redeem flow)
  useEffect(() => {
    if (!isLoading && customer && !rewardName) {
      router.replace('/profile/rewards');
    }
  }, [isLoading, customer, rewardName, router]);

  if (isLoading) {
    return <div className="loading">Cargando...</div>;
  }

  if (!customer || !rewardName) {
    return null;
  }

  return (
    <div className="page fade-in page--centered">
      {/* Success icon */}
      <div className="confirm-icon">✓</div>

      <h1 className="title" style={{ textAlign: 'center', marginBottom: 8 }}>
        ¡Canje exitoso!
      </h1>

      <p className="confirm-message">
        Has canjeado <strong>{rewardName}</strong>
        {pointsCost && (
          <>
            {' '}
            por <strong>{Number(pointsCost).toLocaleString('es-CL')} puntos</strong>
          </>
        )}
        .
      </p>

      {remainingBalance && (
        <div className="card card--compact confirm-balance">
          <span className="confirm-balance__label">Saldo restante</span>
          <span className="confirm-balance__value">
            {Number(remainingBalance).toLocaleString('es-CL')} pts
          </span>
        </div>
      )}

      <div className="confirm-actions">
        <Link href="/profile/rewards" className="btn btn--primary">
          Ver más recompensas
        </Link>
        <Link href="/profile" className="btn btn--secondary">
          Ir a mi perfil
        </Link>
      </div>
    </div>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense
      fallback={<div className="loading">Cargando...</div>}
    >
      <ConfirmContent />
    </Suspense>
  );
}

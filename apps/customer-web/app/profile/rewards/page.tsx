'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';

import { api, Reward } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export default function RewardsPage() {
  const router = useRouter();
  const { customer, isLoading: authLoading } = useAuth();
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !customer) {
      router.replace('/login');
    }
  }, [authLoading, customer, router]);

  useEffect(() => {
    if (!customer) return;
    setLoading(true);
    setFetchError(null);
    api
      .getRewards()
      .then(setRewards)
      .catch((err: Error) => setFetchError(err.message))
      .finally(() => setLoading(false));
  }, [customer]);

  const handleRedeem = useCallback(
    async (reward: Reward) => {
      setRedeemingId(reward.id);
      setRedeemError(null);
      try {
        const result = (await api.redeemReward(reward.id)) as {
          success: boolean;
          remainingBalance?: number;
          rewardName?: string;
        };
        if (result?.success) {
          const params = new URLSearchParams({
            name: result.rewardName ?? reward.name,
            points: String(reward.pointsCost),
          });
          if (result.remainingBalance != null) {
            params.set('balance', String(result.remainingBalance));
          }
          router.push(`/profile/rewards/confirm?${params.toString()}`);
        }
      } catch (err) {
        setRedeemError((err as Error).message || 'Error al canjear');
        setRedeemingId(null);
      }
    },
    [router],
  );

  // --- Auth guard ---
  if (authLoading) {
    return <div className="loading">Cargando...</div>;
  }

  if (!customer) {
    return null;
  }

  // --- Loading state ---
  if (loading) {
    return (
      <div className="page fade-in page--centered">
        <div className="loading">Cargando recompensas...</div>
      </div>
    );
  }

  // --- Fetch error ---
  if (fetchError) {
    return (
      <div className="page fade-in">
        <Link href="/profile" className="back-link">
          ← Volver
        </Link>
        <h1 className="title title--sm" style={{ marginBottom: 16 }}>
          Recompensas
        </h1>
        <div className="error-box">{fetchError}</div>
      </div>
    );
  }

  return (
    <div className="page fade-in">
      <Link href="/profile" className="back-link">
        ← Volver
      </Link>

      <h1 className="title title--sm" style={{ marginBottom: 4 }}>
        Recompensas
      </h1>
      <p className="subtitle" style={{ marginBottom: 16 }}>
        Canjea tus puntos por estas recompensas
      </p>

      {/* Redeem error banner */}
      {redeemError && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          {redeemError}
        </div>
      )}

      {/* Empty state */}
      {rewards.length === 0 ? (
        <div className="empty-state">No hay recompensas disponibles</div>
      ) : (
        <div className="rewards-grid">
          {rewards.map((reward) => (
            <div className="card reward-card" key={reward.id}>
              {reward.imageUrl && (
                <div className="reward-card__image-wrap">
                  <img
                    src={reward.imageUrl}
                    alt={reward.name}
                    className="reward-card__image"
                  />
                </div>
              )}

              <div className="reward-card__body">
                <h2 className="reward-card__name">{reward.name}</h2>
                {reward.description && (
                  <p className="reward-card__desc">{reward.description}</p>
                )}

                <div className="reward-card__meta">
                  <span className="reward-card__cost">
                    {reward.pointsCost.toLocaleString('es-CL')} pts
                  </span>
                  {reward.stock != null && (
                    <span
                      className={`reward-card__stock ${
                        reward.stock === 0
                          ? 'reward-card__stock--empty'
                          : 'reward-card__stock--ok'
                      }`}
                    >
                      {reward.stock === 0
                        ? 'Agotado'
                        : `Stock: ${reward.stock}`}
                    </span>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="btn btn--primary reward-card__btn"
                disabled={redeemingId === reward.id || reward.stock === 0}
                onClick={() => handleRedeem(reward)}
              >
                {redeemingId === reward.id ? 'Canjeando...' : 'Canjear'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

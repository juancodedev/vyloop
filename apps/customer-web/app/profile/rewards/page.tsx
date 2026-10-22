'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { ClubShell } from '../../components/club-shell';
import { ClubError, ClubStatus } from '../../components/club-status';
import { RewardCard } from '../../components/reward-card';
import { api, type CustomerProfile, type Reward } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const ERROR_TITLE = 'No pudimos cargar las recompensas';
const ERROR_DESCRIPTION =
  'Hubo un problema al traer el catálogo. Podés reintentar; no gastamos ningún punto.';

const CATALOG_LABEL = 'Catálogo de recompensas';

export default function RewardsPage() {
  const router = useRouter();
  const { customer, isLoading: authLoading } = useAuth();

  const [rewards, setRewards] = useState<Reward[]>([]);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !customer) {
      router.replace('/login');
    }
  }, [authLoading, customer, router]);

  const load = useCallback(() => {
    setFetching(true);
    setError(null);

    // Two independent reads. `getRewards` names no customer and `getProfile`
    // is "me" by construction, so there is no identifier for this page to
    // source from anywhere.
    return Promise.all([api.getRewards(), api.getProfile()])
      .then(([catalog, me]) => {
        setRewards(catalog);
        setProfile(me);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setFetching(false));
  }, []);

  useEffect(() => {
    if (!customer) return;
    void Promise.resolve().then(() => load());
  }, [customer, load]);

  if (authLoading) {
    return (
      <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
        <ClubStatus variant="loading">
          <span className="club-status__description">Cargando recompensas…</span>
        </ClubStatus>
      </ClubShell>
    );
  }

  // No session: reveal nothing.
  if (!customer) return null;

  if (fetching) {
    return (
      <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
        <ClubStatus variant="loading">
          <span className="club-status__description">Cargando recompensas…</span>
        </ClubStatus>
      </ClubShell>
    );
  }

  if (error) {
    return (
      <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
        <ClubError
          title={ERROR_TITLE}
          description={ERROR_DESCRIPTION}
          action={
            <button type="button" className="btn btn--outline" onClick={() => void load()}>
              Reintentar
            </button>
          }
        />
      </ClubShell>
    );
  }

  // The tenant's own unit, from loyalty_programs.points_currency. Never a
  // hardcoded "puntos": a tenant that calls them "estampitas" must see that.
  const currency = profile?.program?.pointsCurrency ?? null;

  return (
    <ClubShell backLink={{ href: '/profile', label: 'Volver a mi pase' }}>
      <h1 className="title title--sm">Recompensas</h1>
      <p className="subtitle">Canjéa tus puntos por lo que quieras</p>

      {rewards.length === 0 ? (
        // An empty catalog is a real answer, not a failure. It is announced as
        // a status rather than left as blank space the user has to interpret.
        <ClubStatus variant="empty">
          <p className="club-status__title">No hay recompensas disponibles</p>
          <p className="club-status__description">
            Cuando el local active recompensas, las vas a ver acá.
          </p>
        </ClubStatus>
      ) : (
        <ul className="rewards-grid" aria-label={CATALOG_LABEL}>
          {rewards.map((reward) => (
            <li key={reward.id}>
              <RewardCard
                reward={reward}
                currency={currency}
                confirmHref={`/profile/rewards/confirm?reward=${encodeURIComponent(reward.id)}`}
              />
            </li>
          ))}
        </ul>
      )}
    </ClubShell>
  );
}

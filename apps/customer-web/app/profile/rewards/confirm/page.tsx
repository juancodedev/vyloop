'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { ClubShell } from '../../../components/club-shell';
import { ClubError, ClubStatus } from '../../../components/club-status';
import { RewardCard } from '../../../components/reward-card';
import { ApiError, api, type CustomerProfile, type Reward } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

const NOT_FOUND_TITLE = 'No encontramos esa recompensa';
const NOT_FOUND_DESCRIPTION =
  'Puede que ya no esté disponible. Volvé al catálogo a ver las que hay ahora.';

/**
 * A reference id per attempt.
 *
 * The server holds a unique constraint on (customer_id, reference_id) and
 * answers a repeat with 409 DUPLICATE_REFERENCE. That is the backstop; this is
 * the front one. A counter is folded into the value so two attempts in the same
 * millisecond still differ, and `randomUUID` is used when the runtime has it.
 */
let attemptCounter = 0;

function newReferenceId(): string {
  attemptCounter += 1;

  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${attemptCounter.toString(36)}`;

  return `redeem-${random}-${attemptCounter}`;
}

/**
 * Turns a server refusal into something the customer can act on.
 *
 * The codes are read off the worker, which answers a sold-out reward, a short
 * balance, an inactive reward and a repeated reference with four distinct
 * codes. Collapsing all of them into "algo salió mal" would throw away the only
 * information the customer can use, so each one keeps its own meaning. The
 * server's own message is carried in the description because it names the
 * numbers involved.
 */
function describeRedeemFailure(err: unknown): { title: string; description: string } {
  if (!(err instanceof ApiError)) {
    return {
      title: 'No pudimos completar el canje',
      description: 'No pudimos comunicarnos con el servidor. No se descontó ningún punto.',
    };
  }

  const serverMessage = err.message;

  switch (err.code) {
    case 'REWARD_OUT_OF_STOCK':
      return {
        title: 'Nos quedamos sin stock',
        description: 'Esta recompensa se agotó mientras la mirabas. No se descontó ningún punto.',
      };

    case 'INSUFFICIENT_BALANCE':
    case 'INSUFFICIENT_POINTS':
      return {
        title: 'No tenés puntos suficientes',
        description: serverMessage,
      };

    case 'REWARD_INACTIVE':
      return {
        title: 'Esta recompensa no está activa',
        description: serverMessage,
      };

    case 'REWARD_NOT_FOUND':
      return {
        title: 'Esta recompensa ya no existe',
        description: 'Pedimos el canje y el servidor no la encontró. No se descontó ningún punto.',
      };

    case 'DUPLICATE_REFERENCE':
      return {
        title: 'Este canje ya estaba registrado',
        description:
          'Lo procesamos una sola vez, así que no se descontó ningún punto dos veces. Revisá tu historial.',
      };

    case 'FORBIDDEN':
      return {
        title: 'No pudimos identificar tu cuenta',
        description: 'Tu sesión no habilita este canje. Volvé a iniciar sesión e intentá de nuevo.',
      };

    default:
      return {
        title: 'No pudimos completar el canje',
        description: serverMessage,
      };
  }
}

function ConfirmContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { customer, isLoading } = useAuth();

  const rewardId = searchParams.get('reward');

  const [reward, setReward] = useState<Reward | null>(null);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
  const [outcome, setOutcome] = useState<{ balanceAfter: number; spent: number } | null>(null);
  const [failure, setFailure] = useState<{ title: string; description: string } | null>(null);

  /**
   * The in-flight lock.
   *
   * `submitting` state is not a lock: React has not re-rendered when a second
   * click lands in the same tick, so both handlers would see `false` and both
   * would fire. A ref is written synchronously before the request goes out, so
   * the second activation finds it already set and returns without asking the
   * server anything. The `disabled` attribute is then a courtesy for the visual
   * state, not the thing preventing the double spend.
   */
  const inFlight = useRef(false);
  const outcomeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isLoading && !customer) {
      router.replace('/login');
    }
  }, [isLoading, customer, router]);

  const load = useCallback(() => {
    if (!rewardId) {
      setFetching(false);
      return;
    }

    setFetching(true);
    setLoadError(null);

    // The reward is re-read from the catalog rather than carried through the
    // URL. A query parameter is under the visitor's control, so a name or a
    // price read from it would be a value this app invented.
    return Promise.all([api.getRewards(), api.getProfile()])
      .then(([catalog, me]) => {
        setProfile(me);
        setReward(catalog.find((row) => row.id === rewardId) ?? null);
      })
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setFetching(false));
  }, [rewardId]);

  useEffect(() => {
    if (!customer || !rewardId) return;
    void load();
  }, [customer, rewardId, load]);

  /**
   * Focus lands on the outcome once there is one.
   *
   * A redeem changes something the customer cannot see elsewhere on the page,
   * so without this the response would arrive silently while focus stayed on a
   * button that is now disabled.
   */
  useEffect(() => {
    if (outcome || failure) outcomeRef.current?.focus();
  }, [outcome, failure]);

  const redeem = useCallback(async () => {
    if (inFlight.current || !reward) return;

    inFlight.current = true;
    setSubmitting(true);
    setFailure(null);

    try {
      const result = await api.redeemReward({
        reward_id: reward.id,
        points: reward.pointsCost,
        reference_id: newReferenceId(),
      });

      // The server's own post-redeem balance, used as displayed truth. A
      // balance recomputed here would be a second implementation of the
      // arithmetic and would eventually disagree with the row it describes.
      setOutcome({
        balanceAfter: result.data.balance_after,
        spent: result.fulfilled,
      });
      setRedeemed(true);
    } catch (err) {
      setFailure(describeRedeemFailure(err));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }, [reward]);

  if (isLoading || fetching) {
    return (
      <ClubShell backLink={{ href: '/profile/rewards', label: 'Volver al catálogo' }}>
        <ClubStatus variant="loading">
          <span className="club-status__description">Cargando la recompensa…</span>
        </ClubStatus>
      </ClubShell>
    );
  }

  if (!customer) return null;

  // Reached without a reward in the URL, so there is nothing to confirm.
  if (!rewardId) return null;

  if (loadError) {
    return (
      <ClubShell backLink={{ href: '/profile/rewards', label: 'Volver al catálogo' }}>
        <ClubError
          title="No pudimos cargar la recompensa"
          description={loadError}
          action={
            <button type="button" className="btn btn--outline" onClick={() => void load()}>
              Reintentar
            </button>
          }
        />
      </ClubShell>
    );
  }

  if (!reward) {
    return (
      <ClubShell backLink={{ href: '/profile/rewards', label: 'Volver al catálogo' }}>
        <ClubStatus variant="empty">
          <p className="club-status__title">{NOT_FOUND_TITLE}</p>
          <p className="club-status__description">{NOT_FOUND_DESCRIPTION}</p>
          <div className="club-status__action">
            <Link href="/profile/rewards" className="btn btn--primary">
              Ver recompensas
            </Link>
          </div>
        </ClubStatus>
      </ClubShell>
    );
  }

  const currency = profile?.program?.pointsCurrency ?? null;
  const unit = currency ? ` ${currency}` : '';

  return (
    <ClubShell backLink={{ href: '/profile/rewards', label: 'Volver al catálogo' }}>
      <h1 className="title title--sm">Confirmar canje</h1>

      <RewardCard reward={reward} currency={currency} confirmHref="" hideAffordance />

      {/*
        The balance is shown as information only. It is a real value from
        /v1/customers/me, but it never gates the button: the server owns that
        decision, and a pre-check that disabled the control would refuse
        redemptions it has not actually ruled on.
      */}
      {profile ? (
        <p className="confirm-available">
          Tu saldo: {profile.points.toLocaleString('es-CL')}
          {unit}
        </p>
      ) : null}

      <div className="confirm-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void redeem()}
          disabled={submitting || redeemed || reward.stock === 0}
          aria-pressed={redeemed}
        >
          {redeemed ? 'Canjeado' : submitting ? 'Canjeando…' : 'Confirmar canje'}
        </button>
      </div>

      {/*
        One live region for the whole outcome, success or refusal, so the
        customer is told either way and focus lands in the same place. The
        error path is an `alert` because a refusal is the case where leaving
        the customer waiting is the worse mistake.
      */}
      {outcome || failure ? (
        <div ref={outcomeRef} tabIndex={-1} className="confirm-outcome">
          {outcome ? (
            <ClubStatus variant="empty">
              <p className="confirm-icon" aria-hidden="true">
                ✓
              </p>
              <p className="confirm-message">
                Canjeaste <strong>{reward.name}</strong> por{' '}
                <strong>
                  {outcome.spent.toLocaleString('es-CL')}
                  {unit}
                </strong>
                .
              </p>

              <div className="card card--compact confirm-balance">
                <span className="confirm-balance__label">Saldo restante</span>
                <span className="confirm-balance__value">
                  {outcome.balanceAfter.toLocaleString('es-CL')}
                  {unit}
                </span>
              </div>
            </ClubStatus>
          ) : (
            <ClubError
              title={failure?.title ?? ''}
              description={failure?.description ?? ''}
              action={
                <button type="button" className="btn btn--outline" onClick={() => void redeem()}>
                  Intentar de nuevo
                </button>
              }
            />
          )}

          <div className="confirm-actions">
            <Link href="/profile/history" className="btn btn--secondary">
              Ver mi historial
            </Link>
          </div>
        </div>
      ) : null}
    </ClubShell>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense
      fallback={
        <ClubShell backLink={{ href: '/profile/rewards', label: 'Volver al catálogo' }}>
          <ClubStatus variant="loading">
            <span className="club-status__description">Cargando la recompensa…</span>
          </ClubStatus>
        </ClubShell>
      }
    >
      <ConfirmContent />
    </Suspense>
  );
}

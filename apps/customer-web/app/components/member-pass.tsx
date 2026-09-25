import type { CustomerProfile } from '../lib/api';

import { ClubStatus } from './club-status';
import { TierLadder } from './tier-ladder';


const SETUP_TITLE = 'Tu programa se está configurando';
const SETUP_DESCRIPTION =
  'Este local todavía no tiene un programa de puntos activo. En cuanto lo tenga, vas a ver acá tu nivel y cuánto te falta para el siguiente.';

function formatPoints(value: number): string {
  return value.toLocaleString('es-CL');
}

/**
 * Pairs a number with the tenant's own unit label.
 *
 * When the tenant has no program there is no label to attach, so the bare
 * number is returned rather than a guessed unit like "pts".
 */
function withCurrency(value: number, currency: string | null): string {
  const formatted = formatPoints(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

function firstName(fullName: string): string {
  return fullName.split(' ')[0] ?? fullName;
}

function memberSince(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
}

/**
 * The name of the tier the customer is actually in.
 *
 * `currentTierId` is the assignment the backend stored, so its presence is what
 * licenses a tier claim. The name is read from the tenant's own `tiers` array
 * first; the denormalised `currentTier` string is only a fallback for the case
 * where the id resolves against no row in this response.
 */
function currentTierName(profile: CustomerProfile): string | null {
  if (!profile.currentTierId) return null;
  return profile.tiers.find((tier) => tier.id === profile.currentTierId)?.name ?? profile.currentTier;
}

function BalanceFigure({ points, currency }: { points: number; currency: string | null }) {
  return (
    <div className="club-pass__balance">
      <p className="club-pass__balance-label">Tu saldo</p>
      {/* The one large, high-weight number on the page. Everything else is a
          step below it, and this is the only figure that earns that weight. */}
      <p className="club-pass__balance-value">
        {formatPoints(points)}
        {currency ? <span className="club-pass__balance-unit"> {currency}</span> : null}
      </p>
    </div>
  );
}

function MetaRow({ profile, currency }: { profile: CustomerProfile; currency: string | null }) {
  const last30 = profile.pointsLast30Days ?? 0;

  return (
    <dl className="club-pass__meta">
      <div className="club-pass__meta-item">
        <dt>Acumulados</dt>
        <dd>{withCurrency(profile.totalPointsEarned, currency)}</dd>
      </div>
      <div className="club-pass__meta-item">
        <dt>Últimos 30 días</dt>
        <dd>{last30 > 0 ? withCurrency(last30, currency) : '—'}</dd>
      </div>
      <div className="club-pass__meta-item">
        <dt>Miembro desde</dt>
        <dd>{memberSince(profile.createdAt)}</dd>
      </div>
    </dl>
  );
}

function ActivitySkeleton() {
  return (
    <div className="club-pass__activity-skeleton" aria-hidden="true">
      <span className="club-pass__skeleton-line" />
      <span className="club-pass__skeleton-line" />
      <span className="club-pass__skeleton-line" />
    </div>
  );
}

export { ActivitySkeleton, SETUP_DESCRIPTION, SETUP_TITLE };

/**
 * The web pass: who you are, what you have, and what is still ahead.
 *
 * Hierarchy is deliberate. The balance is the single large number; the tier
 * name is a step below it; the remaining figures collapse into one
 * low-emphasis inline meta row. The ladder is the signature element because it
 * is built from the tenant's own configuration and cannot be faked by a
 * generic loyalty screen.
 */
export function MemberPass({ profile }: { profile: CustomerProfile }) {
  const { business, program, tiers, nextTier } = profile;
  const currency = program?.pointsCurrency ?? null;

  // A tenant with no program, or a program with no tiers, is an expected setup
  // state — not an error and not an invitation to imply a progression. Saying
  // so is the honest answer; rendering an empty ladder would not be.
  const programUnavailable = program === null || tiers.length === 0;

  // A tier claim needs BOTH an assignment from the backend and a programme to
  // belong to. `currentTierId` alone is not enough: with no program on the
  // tenant, naming a level would imply a progression that does not exist.
  const tierName = programUnavailable ? null : currentTierName(profile);

  return (
    <section className="club-pass" aria-label="Tu pase">
      <header className="club-pass__header">
        <p className="club-pass__eyebrow">{business ? business.name : 'Club del barrio'}</p>
        <h1 className="club-pass__greeting">Hola, {firstName(profile.fullName)}</h1>
      </header>

      <BalanceFigure points={profile.points} currency={currency} />

      {/* No tier is claimed unless the backend actually assigned one. A balance
          of 0 with no `currentTierId` must not imply a level. */}
      {tierName ? <p className="club-pass__tier">Nivel {tierName}</p> : null}

      <MetaRow profile={profile} currency={currency} />

      {programUnavailable ? (
        <ClubStatus variant="empty">
          <p className="club-status__title">{SETUP_TITLE}</p>
          <p className="club-status__description">{SETUP_DESCRIPTION}</p>
        </ClubStatus>
      ) : (
        <TierLadder
          points={profile.points}
          currentTierId={profile.currentTierId}
          program={program}
          tiers={tiers}
          nextTier={nextTier}
        />
      )}
    </section>
  );
}

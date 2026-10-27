import type { CustomerProfile, CustomerTier } from '../lib/api';
import { formatMemberSince, initials } from '../lib/format';

import { ClubStatus } from './club-status';
import { currentTierName, SETUP_DESCRIPTION, SETUP_TITLE } from './member-pass';
import { resolveHeadline } from './tier-ladder';

/**
 * Progress toward the next tier, counted from zero as the server reports it.
 *
 * Rounded down so the bar never claims more than the balance has reached.
 */
function TierProgress({ points, nextTier, unit }: { points: number; nextTier: CustomerTier; unit: string }) {
  const remaining = Math.max(0, nextTier.minPoints - points);
  const percent = nextTier.minPoints > 0 ? Math.floor((Math.min(points, nextTier.minPoints) / nextTier.minPoints) * 100) : 0;

  return (
    <div className="club-identity-card__tierline">
      <p className="club-identity-card__tierline-text">
        Te faltan {remaining.toLocaleString('es-CL')} {unit} para el nivel {nextTier.name}
      </p>
      <progress
        className="club-identity-card__bar"
        max={nextTier.minPoints}
        value={Math.min(points, nextTier.minPoints)}
        aria-label={`${percent}% hacia ${nextTier.name}`}
      />
    </div>
  );
}

/**
 * Who the customer is, their balance, and the honest distance to the next tier.
 *
 * Tier rules are reused, not restated: the chip comes from `currentTierName`
 * and the headline from `resolveHeadline`, so "Estás en el nivel más alto" is
 * claimed only on the last rung of the tenant's own list. No visit or purchase
 * counts are shown.
 */
export function IdentityCard({ profile }: { profile: CustomerProfile }) {
  const { program, tiers, nextTier } = profile;
  const programUnavailable = program === null || tiers.length === 0;
  const tierName = programUnavailable ? null : currentTierName(profile);
  const headline = programUnavailable ? null : resolveHeadline(tiers, profile.currentTierId, nextTier);

  return (
    <section className="club-identity-card" aria-label="Tu identidad">
      <div className="club-identity-card__top">
        <div className="club-identity-card__avatar" aria-hidden="true">
          {initials(profile.fullName)}
        </div>
        <div className="club-identity-card__body">
          <h1 className="club-identity-card__name">{profile.fullName}</h1>
          <p className="club-identity-card__member-since">
            Miembro desde {formatMemberSince(profile.createdAt)}
          </p>
          {tierName ? <span className="club-identity-card__tier">Nivel {tierName}</span> : null}
        </div>
      </div>

      <p className="club-identity-card__balance">
        <span className="club-identity-card__balance-value">{profile.points.toLocaleString('es-CL')}</span>
        {program?.pointsCurrency ? (
          <span className="club-identity-card__balance-unit"> {program.pointsCurrency}</span>
        ) : null}
      </p>

      {programUnavailable ? (
        <ClubStatus variant="empty">
          <p className="club-status__title">{SETUP_TITLE}</p>
          <p className="club-status__description">{SETUP_DESCRIPTION}</p>
        </ClubStatus>
      ) : headline?.kind === 'gap' ? (
        <TierProgress points={profile.points} nextTier={headline.tier} unit={program.pointsCurrency} />
      ) : headline?.kind === 'top' ? (
        <p className="club-identity-card__tierline-text">Estás en el nivel más alto</p>
      ) : null}
    </section>
  );
}

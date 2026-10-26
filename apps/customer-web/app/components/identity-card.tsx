import type { CustomerProfile } from '../lib/api';
import { formatMovementDate, initials } from '../lib/format';

interface IdentityCardProps {
  profile: CustomerProfile;
}

export function IdentityCard({ profile }: IdentityCardProps) {
  const tierName = profile.currentTierId
    ? (profile.tiers.find((t) => t.id === profile.currentTierId)?.name ?? profile.currentTier)
    : profile.currentTier;

  return (
    <section className="club-identity-card" aria-label="Tu identidad">
      <div className="club-identity-card__avatar" aria-hidden="true">
        {initials(profile.fullName)}
      </div>
      <div className="club-identity-card__body">
        <h2 className="club-identity-card__name">{profile.fullName}</h2>
        {tierName && <span className="club-identity-card__tier">{tierName}</span>}
        <p className="club-identity-card__balance">
          <span className="club-identity-card__balance-value">{profile.points}</span>
          {profile.program?.pointsCurrency && (
            <span className="club-identity-card__balance-unit"> {profile.program.pointsCurrency}</span>
          )}
        </p>
        <p className="club-identity-card__member-since">
          Miembro desde {formatMovementDate(profile.createdAt)}
        </p>
      </div>
    </section>
  );
}

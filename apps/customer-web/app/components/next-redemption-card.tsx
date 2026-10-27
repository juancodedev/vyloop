import Link from 'next/link';

import type { CustomerProfile } from '../lib/api';

/**
 * "Tu próximo canje": a ticket with the reward's price on a perforated stub.
 *
 * It renders the server's decision and nothing else. In priority order:
 *
 * 1. A reward is already affordable: "Ya podés canjear …" and a "Canjear" link.
 * 2. A next reward exists: its name, what is missing, and a progress bar.
 * 3. Neither, the fields are absent (older API), or there is no program to
 *    take a unit from: the card is not rendered at all. No placeholder reward
 *    is ever shown.
 *
 * Every quantity is counted in `program.pointsCurrency`; the reward's name is
 * never used as a unit.
 */
export function NextRedemptionCard({ profile }: { profile: CustomerProfile }) {
  const { program, nextReward, affordableReward, affordableRewardsCount, activeRewardsCount } = profile;
  if (!program) return null;

  const unit = program.pointsCurrency;
  const affordable = (affordableRewardsCount ?? 0) > 0 && affordableReward ? affordableReward : null;

  if (!affordable && !nextReward) return null;

  return (
    <section className="club-redemption" aria-labelledby="club-redemption-title">
      <div className="club-redemption__header">
        <h2 className="club-redemption__heading" id="club-redemption-title">
          Tu próximo canje
        </h2>
        {activeRewardsCount ? (
          <Link className="club-redemption__all" href="/profile/rewards">
            Ver los {activeRewardsCount}
          </Link>
        ) : null}
      </div>

      {affordable ? (
        <div className="club-redemption__ticket">
          <div className="club-redemption__body">
            <p className="club-redemption__title">Ya podés canjear {affordable.name}</p>
            <Link
              className="btn btn--primary club-redemption__redeem"
              href={`/profile/rewards/confirm?reward=${encodeURIComponent(affordable.id)}`}
            >
              Canjear
            </Link>
          </div>
          <p className="club-redemption__stub">
            {affordable.pointsCost} {unit}
          </p>
        </div>
      ) : nextReward ? (
        <div className="club-redemption__ticket">
          <div className="club-redemption__body">
            <p className="club-redemption__title">{nextReward.name}</p>
            <p className="club-redemption__missing">
              Te faltan {nextReward.pointsMissing} {unit}
            </p>
            <progress
              className="club-redemption__bar"
              max={nextReward.pointsCost}
              value={nextReward.pointsCost - nextReward.pointsMissing}
              aria-label={`${nextReward.pointsCost - nextReward.pointsMissing} de ${nextReward.pointsCost} ${unit}`}
            />
          </div>
          <p className="club-redemption__stub">
            {nextReward.pointsCost} {unit}
          </p>
        </div>
      ) : null}
    </section>
  );
}

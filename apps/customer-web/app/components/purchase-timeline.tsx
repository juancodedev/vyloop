import type { CustomerProfile, RecentTransaction } from '../lib/api';
import { formatClp, formatMovementDate } from '../lib/format';

interface PurchaseTimelineProps {
  profile: CustomerProfile;
}

function signFor(type: string): '+' | '−' | '•' {
  if (type === 'points.earned' || type === 'earn') return '+';
  if (type === 'points.redeemed' || type === 'redeem') return '−';
  return '•';
}

export function PurchaseTimeline({ profile }: PurchaseTimelineProps) {
  const transactions = profile.recent_transactions ?? [];

  return (
    <section className="club-purchase-timeline" aria-label="Actividad reciente">
      <h3 className="club-purchase-timeline__title">Actividad reciente</h3>
      {transactions.length === 0 ? (
        <p className="club-purchase-timeline__empty">Sin movimientos todavía.</p>
      ) : (
        <ul className="club-purchase-timeline__list">
          {transactions.map((tx: RecentTransaction) => (
            <li key={tx.id} className="club-purchase-timeline__row">
              <span className="club-purchase-timeline__sign">{signFor(tx.type)}</span>
              <div className="club-purchase-timeline__info">
                <span className="club-purchase-timeline__note">
                  {tx.note ?? (tx.type === 'earn' ? 'Puntos ganados' : 'Canje')}
                  {tx.purchaseAmount ? ` · ${formatClp(tx.purchaseAmount)}` : ''}
                </span>
                <span className="club-purchase-timeline__date">{formatMovementDate(tx.createdAt)}</span>
              </div>
              <span className="club-purchase-timeline__points">{Math.abs(tx.points)}</span>
              <span className="club-purchase-timeline__balance">{tx.balanceAfter}</span>
            </li>
          ))}
        </ul>
      )}
      {profile.nextReward && profile.program ? (
        <p className="club-purchase-timeline__nudge">
          Con {profile.nextReward.pointsMissing} {profile.program.pointsCurrency} más, tu canje{' '}
          {profile.nextReward.name} es tuyo
        </p>
      ) : null}
    </section>
  );
}

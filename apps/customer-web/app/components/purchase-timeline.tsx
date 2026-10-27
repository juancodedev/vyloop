import type { CustomerProfile } from '../lib/api';
import { formatClp, formatMovementDate } from '../lib/format';

/** At most this many rows; the full list lives on `/profile/history`. */
const TIMELINE_LIMIT = 5;

type TimelineItem =
  | {
      id: string;
      kind: 'earn' | 'redeem';
      points: number;
      balanceAfter: number;
      purchaseAmount: number | null;
      note: string | null;
      createdAt: string;
    }
  | { id: string; kind: 'joined'; createdAt: string };

/**
 * Merges the two activity sources into one list, newest first.
 *
 * Transactions carry every points movement. From events only the
 * registration is taken: the earn and redeem events duplicate transactions,
 * and the rest (profile views, QR displays) are internal.
 */
export function buildTimeline(profile: CustomerProfile): TimelineItem[] {
  const fromTransactions: TimelineItem[] = (profile.recent_transactions ?? []).map((tx) => ({
    id: tx.id,
    kind: tx.type === 'redeem' || tx.type === 'points.redeemed' ? 'redeem' : 'earn',
    points: Math.abs(tx.points),
    balanceAfter: tx.balanceAfter,
    purchaseAmount: tx.purchaseAmount ?? null,
    note: tx.note ?? null,
    createdAt: tx.createdAt,
  }));

  const fromEvents: TimelineItem[] = (profile.customer_events ?? [])
    .filter((event) => event.eventType === 'customer.registered')
    .map((event) => ({ id: event.id, kind: 'joined', createdAt: event.createdAt }));

  return [...fromTransactions, ...fromEvents]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, TIMELINE_LIMIT);
}

function titleFor(item: TimelineItem): string {
  if (item.kind === 'joined') return 'Te uniste al club';
  if (item.kind === 'redeem') return `Canjeaste ${item.note ?? 'un premio'}`;
  // A positive amount only: "$0" is never a purchase worth naming.
  if (item.purchaseAmount) return `Compra de ${formatClp(item.purchaseAmount)}`;
  if (item.note) return item.note;
  return 'Puntos ganados';
}

export function PurchaseTimeline({ profile }: { profile: CustomerProfile }) {
  const items = buildTimeline(profile);
  // Without a program there is no unit: drop it rather than guess one.
  const unit = profile.program?.pointsCurrency ?? null;

  return (
    <section className="club-purchase-timeline" aria-labelledby="club-purchase-timeline-title">
      <h2 className="club-purchase-timeline__title" id="club-purchase-timeline-title">
        Actividad reciente
      </h2>
      {items.length === 0 ? (
        <p className="club-purchase-timeline__empty">
          Todavía no hay movimientos. Cuando sumes en el local, aparecen acá.
        </p>
      ) : (
        <ul className="club-purchase-timeline__list">
          {items.map((item) => (
            <li key={item.id} className="club-purchase-timeline__row">
              {/* The glyph is decoration; the points text carries the direction. */}
              <span className="club-purchase-timeline__sign" aria-hidden="true">
                {item.kind === 'earn' ? '+' : item.kind === 'redeem' ? '−' : '•'}
              </span>
              <div className="club-purchase-timeline__info">
                <span className="club-purchase-timeline__note">{titleFor(item)}</span>
                <span className="club-purchase-timeline__date">{formatMovementDate(item.createdAt)}</span>
              </div>
              {item.kind === 'joined' ? null : (
                <div className="club-purchase-timeline__figures">
                  <span className="club-purchase-timeline__points">
                    {item.kind === 'earn' ? '+' : '−'}
                    {item.points.toLocaleString('es-CL')}
                    {unit ? ` ${unit}` : ''}
                  </span>
                  <span className="club-purchase-timeline__balance">
                    saldo {item.balanceAfter.toLocaleString('es-CL')}
                  </span>
                </div>
              )}
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

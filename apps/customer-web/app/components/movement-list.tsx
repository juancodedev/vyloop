import type { Transaction } from '../lib/api';

/**
 * Where a movement's direction comes from.
 *
 * `points_transactions.points` is a magnitude, not a signed delta: the growth
 * worker writes a positive number for an earn AND for a redeem, and expresses
 * the spend through `balance_after` dropping. So the direction is read from
 * `type` and the size from `Math.abs(points)`.
 *
 * Taking the sign from the number instead would relabel every redemption as a
 * gain. Taking the size without the absolute value would render a negative
 * row as a negative quantity, which is not what any writer produces.
 */
type Direction = 'earned' | 'redeemed';

function directionOf(type: string): Direction {
  return type === 'redeem' ? 'redeemed' : 'earned';
}

const DIRECTION_WORDS: Record<Direction, string> = {
  earned: 'Ganaste',
  redeemed: 'Canjeaste',
};

const DEFAULT_LABELS: Record<Direction, string> = {
  earned: 'Puntos acumulados',
  redeemed: 'Canje de recompensa',
};

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

function formatPoints(value: number): string {
  return value.toLocaleString('es-CL');
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('es-CL', DATE_FORMAT);
}

interface MovementRowProps {
  transaction: Transaction;
  /** The tenant's points label, or `null` when no program is configured. */
  currency: string | null;
}

/**
 * One real `points_transactions` row.
 *
 * The direction is carried three times on purpose — by the amount's sign, by
 * the modifier class, and by a spoken label — because colour and glyph alone
 * leave a screen-reader user with no way to tell a gain from a spend.
 */
export function MovementRow({ transaction, currency }: MovementRowProps) {
  const direction = directionOf(transaction.type);
  const earned = direction === 'earned';
  const magnitude = Math.abs(transaction.points);
  const unit = currency ? ` ${currency}` : '';
  const spoken = `${DIRECTION_WORDS[direction]} ${formatPoints(magnitude)}${unit}`;
  const description = transaction.note || DEFAULT_LABELS[direction];

  return (
    <li className="movement">
      <span
        className={`movement__icon ${earned ? 'movement__icon--earned' : 'movement__icon--redeemed'}`}
        aria-hidden="true"
      >
        {earned ? '↑' : '↓'}
      </span>

      <span className="movement__body">
        <span className="movement__description">{description}</span>
        <span className="movement__date">{formatDate(transaction.created_at)}</span>
      </span>

      <span className="movement__figures">
        <span
          className={`movement__points ${earned ? 'movement__points--earned' : 'movement__points--redeemed'}`}
          aria-hidden="true"
        >
          {earned ? '+' : '−'}
          {formatPoints(magnitude)}
        </span>
        <span className="club-sr-only">{spoken}</span>
        <span className="movement__balance">
          Saldo: {formatPoints(transaction.balance_after)}
          {unit}
        </span>
      </span>
    </li>
  );
}

interface MovementListProps {
  transactions: Transaction[];
  currency: string | null;
  /** Accessible name for the list, so it is reachable by landmark. */
  label: string;
}

/** The ordered list of movements. Ordering is the server's, newest first. */
export function MovementList({ transactions, currency, label }: MovementListProps) {
  return (
    <ul className="card card--compact card--noshadow movement-list" aria-label={label}>
      {transactions.map((transaction) => (
        <MovementRow key={transaction.id} transaction={transaction} currency={currency} />
      ))}
    </ul>
  );
}

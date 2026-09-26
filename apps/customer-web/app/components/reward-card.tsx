import Link from 'next/link';

import type { Reward } from '../lib/api';

interface RewardCardProps {
  reward: Reward;
  /**
   * The tenant's own points label, from `loyalty_programs.points_currency`.
   * `null` when the tenant has no program configured, in which case the cost is
   * shown as a bare number rather than a guessed unit.
   */
  currency: string | null;
  /** Where this reward's confirmation step lives. */
  confirmHref: string;
  /**
   * Hides the redeem affordance on the confirmation step itself, where the card
   * is there to describe the reward and the confirm button below is the action.
   * Rendering a "Canjear" link that points back at the current page would offer
   * the user a second way to do the thing they are already doing.
   */
  hideAffordance?: boolean;
}

function formatPoints(value: number): string {
  return value.toLocaleString('es-CL');
}

/**
 * The three stock states, kept apart on purpose.
 *
 * `0` and `null` mean opposite things and collapsing them is a real bug in each
 * direction: treating `0` as "untracked" offers a redeem the server will
 * refuse, and treating `null` as sold out refuses one the server will honour.
 * `null` is the absence of a number, not a number of zero, and the UI says so
 * in words rather than showing an empty badge.
 */
type StockState =
  | { kind: 'tracked'; remaining: number }
  | { kind: 'sold-out' }
  | { kind: 'untracked' };

function resolveStock(stock: number | null | undefined): StockState {
  if (stock === null || stock === undefined) return { kind: 'untracked' };
  if (stock <= 0) return { kind: 'sold-out' };
  return { kind: 'tracked', remaining: stock };
}

function StockBadge({ state }: { state: StockState }) {
  if (state.kind === 'sold-out') {
    return (
      <span className="reward-card__stock reward-card__stock--empty">Agotado</span>
    );
  }

  if (state.kind === 'untracked') {
    // Not "0 left" and not a blank: the merchant does not count this reward.
    return (
      <span className="reward-card__stock reward-card__stock--untracked">
        Stock no controlado
      </span>
    );
  }

  return (
    <span className="reward-card__stock reward-card__stock--ok">
      Quedan {state.remaining}
    </span>
  );
}

/**
 * One real reward row from the catalog.
 *
 * Every value on this card comes from the reward object the server sent. There
 * is no fallback name, no placeholder price and no derived availability: a
 * reward that arrives without an image, a description or a category simply
 * renders fewer rows rather than inventing one.
 *
 * The affordance navigates to the confirmation step. Redeeming itself is a
 * separate, explicit gesture there, so browsing the catalog can never spend
 * anything.
 */
export function RewardCard({ reward, currency, confirmHref, hideAffordance = false }: RewardCardProps) {
  const stock = resolveStock(reward.stock);
  const headingId = `reward-${reward.id}`;

  return (
    <article className="card reward-card" aria-labelledby={headingId}>
      {reward.imageUrl ? (
        <div className="reward-card__image-wrap">
          <img src={reward.imageUrl} alt="" className="reward-card__image" loading="lazy" />
        </div>
      ) : null}

      <div className="reward-card__body">
        {reward.category ? (
          <span className="reward-card__category">{reward.category}</span>
        ) : null}

        <h2 className="reward-card__name" id={headingId}>
          {reward.name}
        </h2>

        {reward.description ? (
          <p className="reward-card__desc">{reward.description}</p>
        ) : null}

        <div className="reward-card__meta">
          <span className="reward-card__cost">
            {formatPoints(reward.pointsCost)}
            {currency ? ` ${currency}` : ''}
          </span>

          <StockBadge state={stock} />
        </div>
      </div>

      {hideAffordance ? null : stock.kind === 'sold-out' ? (
        // A real disabled button, not a link styled to look unavailable: there
        // is nowhere to go, and the reason is already stated in the badge.
        <button type="button" className="btn btn--primary reward-card__btn" disabled>
          Agotado
        </button>
      ) : (
        <Link
          href={confirmHref}
          className="btn btn--primary reward-card__btn"
          aria-label={`Canjear ${reward.name}`}
        >
          Canjear
        </Link>
      )}
    </article>
  );
}

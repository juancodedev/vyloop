import type { CustomerProgram, CustomerTier } from '../lib/api';

interface TierLadderProps {
  /** Current balance. Used only to mark which rungs are already reached. */
  points: number;
  currentTierId: string | undefined;
  program: CustomerProgram;
  /** The tenant's own tiers, in canonical display order. */
  tiers: CustomerTier[];
  /**
   * Server-derived. `null` means the customer is at or above the top tier, and
   * this component states that plainly. It is never recomputed here.
   */
  nextTier: CustomerTier | null;
}

const LADDER_LABEL = 'Niveles del programa';

function formatPoints(value: number): string {
  return value.toLocaleString('es-CL');
}

/**
 * The customer's real distance to the next rung, in the tenant's own currency.
 *
 * Both operands come straight from the response: the target threshold is
 * `nextTier.minPoints` and the starting point is the balance. Nothing about
 * WHICH tier comes next is decided here — that rule lives on the server.
 */
function GapMessage({
  nextTier,
  points,
  currency,
}: {
  nextTier: CustomerTier;
  points: number;
  currency: string;
}) {
  const remaining = Math.max(0, nextTier.minPoints - points);

  return (
    <p className="club-ladder__gap">
      Te faltan <strong className="club-ladder__gap-value">{formatPoints(remaining)}</strong>{' '}
      {currency} para llegar a <strong className="club-ladder__gap-tier">{nextTier.name}</strong>
    </p>
  );
}

function Rung({
  tier,
  isCurrent,
  isNext,
  isReached,
  currency,
}: {
  tier: CustomerTier;
  isCurrent: boolean;
  isNext: boolean;
  isReached: boolean;
  currency: string;
}) {
  const state = isCurrent ? 'current' : isNext ? 'next' : isReached ? 'reached' : 'locked';
  const stateLabel = isCurrent
    ? 'Tu nivel actual'
    : isNext
      ? 'Siguiente nivel'
      : isReached
        ? 'Alcanzado'
        : 'Todavía no alcanzado';

  return (
    <li
      className={`club-ladder__rung club-ladder__rung--${state}`}
      aria-current={isCurrent ? 'true' : undefined}
    >
      <span className="club-ladder__rung-marker" aria-hidden="true" />

      <span className="club-ladder__rung-copy">
        <span className="club-ladder__rung-name">{tier.name}</span>
        <span className="club-ladder__rung-threshold">
          {formatPoints(tier.minPoints)} {currency}
        </span>
      </span>

      <span className="club-ladder__rung-state">{stateLabel}</span>
    </li>
  );
}

/**
 * The signature element: a ladder of the tenant's OWN named tiers.
 *
 * A generic loyalty UI cannot produce this because it has to read the
 * tenant's configuration to know the rung names at all. Everything rendered
 * here is a value the server sent; this component adds no thresholds of its
 * own and invents no level names.
 *
 * Callers must not render this when the tenant has no program or no tiers —
 * an empty ladder would imply a progression that does not exist yet.
 */
export function TierLadder({ points, currentTierId, program, tiers, nextTier }: TierLadderProps) {
  return (
    <section className="club-ladder" aria-labelledby="club-ladder-title">
      <h3 className="club-ladder__title" id="club-ladder-title">
        Tu nivel
      </h3>

      {nextTier ? (
        <GapMessage nextTier={nextTier} points={points} currency={program.pointsCurrency} />
      ) : (
        // The server returned null, which is authoritative: it means no tier
        // sits above this balance. Saying so is reporting, not optimism.
        <p className="club-ladder__gap club-ladder__gap--top">
          Llegaste al nivel más alto de {program.name}.
        </p>
      )}

      <ol className="club-ladder__rungs" aria-label={LADDER_LABEL}>
        {tiers.map((tier) => (
          <Rung
            key={tier.id}
            tier={tier}
            currency={program.pointsCurrency}
            isCurrent={tier.id === currentTierId}
            isNext={nextTier?.id === tier.id}
            isReached={tier.minPoints <= points}
          />
        ))}
      </ol>
    </section>
  );
}

export { LADDER_LABEL as TIER_LADDER_LABEL };

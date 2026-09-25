import type { CustomerProgram, CustomerTier } from '../lib/api';

interface TierLadderProps {
  /** Current balance. Used only to mark which rungs are already reached. */
  points: number;
  currentTierId: string | undefined;
  program: CustomerProgram;
  /** The tenant's own tiers, in canonical display order. */
  tiers: CustomerTier[];
  /**
   * Server-derived: the first tier whose `minPoints` the balance has not
   * passed, or `null` when there is none. Never recomputed here.
   *
   * A `null` is necessary but NOT sufficient to claim the customer reached the
   * top — see `resolveHeadline`. It is also consistent with tiers the merchant
   * has ordered incoherently.
   */
  nextTier: CustomerTier | null;
}

const LADDER_LABEL = 'Niveles del programa';

const UNRESOLVED_COPY = 'No vemos un nivel siguiente en tu programa por ahora.';

function formatPoints(value: number): string {
  return value.toLocaleString('es-CL');
}

/**
 * What the ladder can honestly say above the rungs.
 *
 * `gap`   — the server named the next rung, so there is one.
 * `top`   — nothing above the balance AND the customer's own rung is the last
 *           one on the ladder. Only this combination licenses a milestone.
 * `none`  — the server found no next rung, but the customer's rung is not the
 *           last one, so a rung still sits above them. Claiming the top here
 *           would contradict the ladder printed directly underneath.
 */
type LadderHeadline =
  | { kind: 'gap'; tier: CustomerTier }
  | { kind: 'top' }
  | { kind: 'none' };

/**
 * Decides whether a top-of-programme claim is supported by the data.
 *
 * `nextTier === null` on its own is NOT sufficient. The server answers a
 * narrower question — "is there a tier whose threshold the balance has not
 * passed?" — and a merchant can order tiers so that the answer is null while
 * rungs still sit above the customer's assigned level. Reading only the null
 * produced a page that claimed the highest level and simultaneously listed a
 * reached rung below it, in one screen.
 *
 * So the milestone needs both halves to agree: nothing ahead by threshold, and
 * nothing above by position. Anything less gets a sentence that claims no
 * milestone, which is true in every such case.
 *
 * This does not re-derive WHICH tier is next. That is still the server's
 * `nextTier`, rendered as given. This only decides whether a celebratory claim
 * is safe to make.
 */
function resolveHeadline(
  tiers: CustomerTier[],
  currentTierId: string | undefined,
  nextTier: CustomerTier | null,
): LadderHeadline {
  if (nextTier) return { kind: 'gap', tier: nextTier };
  if (!currentTierId) return { kind: 'none' };

  const currentIndex = tiers.findIndex((tier) => tier.id === currentTierId);
  const onLastRung = currentIndex !== -1 && currentIndex === tiers.length - 1;

  return onLastRung ? { kind: 'top' } : { kind: 'none' };
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
 *
 * Rungs are marked reached purely by `minPoints <= points`, which stays true
 * even when the merchant has mis-ordered the ladder. That is deliberate: it is
 * how an incoherent configuration becomes visible instead of being papered
 * over by a client-side cleanup.
 */
export function TierLadder({ points, currentTierId, program, tiers, nextTier }: TierLadderProps) {
  const headline = resolveHeadline(tiers, currentTierId, nextTier);

  return (
    <section className="club-ladder" aria-labelledby="club-ladder-title">
      <h3 className="club-ladder__title" id="club-ladder-title">
        Tu nivel
      </h3>

      {headline.kind === 'gap' ? (
        <GapMessage
          nextTier={headline.tier}
          points={points}
          currency={program.pointsCurrency}
        />
      ) : headline.kind === 'top' ? (
        <p className="club-ladder__gap club-ladder__gap--top">
          Llegaste al nivel más alto de {program.name}.
        </p>
      ) : (
        // No milestone is claimed here. The ladder below still shows every
        // rung and which ones are reached, so a merchant looking at this can
        // see that their own ordering is what leaves the customer with no
        // next level — we neither invent a milestone nor hide the cause.
        <p className="club-ladder__gap club-ladder__gap--unresolved">{UNRESOLVED_COPY}</p>
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

import { createDb, loyaltyPrograms, membershipTiers, customers, rewards, pointsTransactions, checkins } from '@vyloop/db';
import { publish } from '@vyloop/event-bus';
import { eq, and, count, sql, or, isNull, lte, gte, gt, desc } from 'drizzle-orm';
import { Hono } from 'hono';
// import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, buildPointsAssignedEvent, buildRewardRedeemedEvent, withRls, resolveEffectiveCustomer, isCustomerRole, requireOperatorRole, schedulePassReconcile } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

// ============================================================================
// Loyalty Program Config
// ============================================================================

// ---------------------------------------------------------------------------
// The accumulation rule
// ---------------------------------------------------------------------------

/**
 * How a program turns what a customer did into points.
 *
 * Two strategies inside one engine, not two models: `visit` counts, `purchase`
 * converts money. `docs/17-Estrategia-Competitiva.md` §7.5 settles who holds the
 * rule — "A. El Growth, con la regla en config del tenant" — so the merchant
 * controls their program by editing configuration rather than by us forking
 * code. That decision is what makes `purchase` possible here at all: if the POS
 * computed the points, a TUU integration and a Mercado Pago one would each ship
 * a different program.
 */
export const EARN_BY_VALUES = ['visit', 'purchase'] as const;
export type EarnBy = (typeof EARN_BY_VALUES)[number];

/** What a program earns by when it has never been configured. */
export const DEFAULT_EARN_BY: EarnBy = 'visit';

/**
 * `earnRate` past this is a typo, not a promotion.
 *
 * It is a multiplier on a customer's lifetime accrual, so an absurd value does
 * not merely mis-price one sale — it inflates every balance the moment it lands,
 * and the number is what every Google Wallet pass then renders. The column is
 * `numeric(10,4)`, so 1000 is the widest sane reading of "points per visit" or
 * "points per $1.000".
 */
export const MAX_EARN_RATE = 1000;

/**
 * The money unit past this is a typo.
 *
 * 10 million pesos "per point" would pay out one point on a large purchase, which
 * is a number nobody means. Kept well inside the column's `numeric(12,2)` so an
 * absurd unit cannot round into an absurd one at the database.
 */
export const MAX_EARN_UNIT_AMOUNT = 10_000_000;

/** Stable, specific codes. Callers branch on these rather than parsing prose. */
export const INVALID_EARN_RATE = 'INVALID_EARN_RATE';
export const INVALID_EARN_BY = 'INVALID_EARN_BY';
export const INVALID_EARN_UNIT_AMOUNT = 'INVALID_EARN_UNIT_AMOUNT';

/**
 * Read a rate the program can actually be run with, or fall back to 1.
 *
 * Two jobs, and the second is the one that protects balances:
 *
 *   1. Validation on write. `Number('abc')` is `NaN`, and a `NaN` written into
 *      `points_transactions.points` produces a balance nobody can spend, with no
 *      error raised anywhere in the request. A zero or negative rate is the same
 *      defect wearing a plausible number: `0` earns nothing forever, and a
 *      negative rate *subtracts* from the customer's balance on every sale.
 *   2. Tolerating rows written before this guard existed. The write path is not
 *      the only way a bad value reaches the column — it is the way the API can
 *      do it. Falling back to 1.0 keeps the ledger integral and the sale
 *      completable, which is strictly better than refusing the sale over a
 *      cosmetic misconfiguration, and strictly better than writing `NaN`.
 *
 * `undefined` means "the caller sent no rate", which is different from a sent
 * rate of `undefined` and must not be judged by this. Callers check for that
 * first.
 */
export function resolveEarnRate(value: unknown): number {
  const rate = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_EARN_RATE) {
    return 1;
  }
  return rate;
}

/** Is this a rate a program can be run with? The same rule `resolveEarnRate` applies. */
export function isUsableEarnRate(value: unknown): boolean {
  const rate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_EARN_RATE;
}

/**
 * The money amount one point-group is worth, or `null` when it is unusable.
 *
 * Separate from `resolveEarnRate` because the fallback differs: a rate falls back
 * to 1 because 1 point per unit is the cheapest sane program, but a money unit
 * has no such safe default — paying out against the wrong unit pays real money's
 * worth of points, so the caller refuses the request instead of guessing.
 */
export function parseEarnUnitAmount(value: unknown): number | null {
  const unit = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(unit) || unit <= 0 || unit > MAX_EARN_UNIT_AMOUNT) {
    return null;
  }
  return unit;
}

export function isEarnBy(value: unknown): value is EarnBy {
  return typeof value === 'string' && (EARN_BY_VALUES as readonly string[]).includes(value);
}

/**
 * The one formula that turns a qualifying sale into points.
 *
 * ## Why this is a function and not left inline
 *
 * Because there is now more than one caller that has to run it, and the second
 * one is not optional. `POST /v1/loyalty/points/assign` runs it for the integrated
 * POS and the manual scanner. `POST /v1/checkins` runs it for the merchant's own
 * terminal reporting a sale it already completed — and that path cannot call the
 * other route, because the terminal sends a `payment_id` and a money amount and
 * has no idea a loyalty program exists. Two copies of this expression would be two
 * rules, and the drift between them would surface as a merchant's preview
 * disagreeing with their customer's balance.
 *
 * It lives beside `resolveEarnRate` / `parseEarnUnitAmount` / `isEarnBy` rather
 * than in `helpers.ts` because those are its other three inputs and they are all
 * here: moving only this one would separate the rule from the guards that keep it
 * finite, which is the opposite of what extracting it was for.
 *
 * ## What the three inputs already are, and why this does not resolve them
 *
 * All three arrive resolved, and that is the point of the signature:
 *
 *   base           — the qualifying count (`visit`) or the units of money bought
 *                    (`purchase`). Resolving it needs the tenant's mechanic, and
 *                    the two mechanics read different fields, so the caller that
 *                    holds the field has to choose.
 *   earnRate       — `resolveEarnRate` has already run. A raw `earnRate` can be
 *                    `NaN` from a row the write path predates, and `NaN`
 *                    multiplied in here lands in
 *                    `points_transactions.points`: a balance nobody can spend,
 *                    with no error raised anywhere in the request.
 *   tierMultiplier — same reason, read from a column this worker did not write.
 *
 * So this is deliberately the smallest thing that can hold the rule: three numbers
 * in, one number out, no I/O and no database. Anything it could resolve for itself
 * would be a second place where the answer could differ.
 *
 * ## Why the declaration has this exact shape
 *
 * The expression is transcribed into the dashboard, and two contract tests read
 * *this file* to check it: `loyalty-points.contract.test.ts` and
 * `pos-earn-mechanic.contract.test.ts`. Both do it by matching the declaration
 * below and comparing what follows the `=` against their own transcription, so
 * the *spelling* is load-bearing as well as the arithmetic: renaming the
 * constant, splitting the expression across lines, or inlining it as an argument
 * would leave both tests matching nothing.
 *
 * Which is worth stating plainly, because it is a trap rather than a rule: this
 * comment must not itself quote that declaration. Both tests take the FIRST
 * match in the file, so a copy of the pattern written here in the prose would be
 * the thing they matched, and both would report a fragment of this sentence
 * instead of the formula. That is exactly what happened when this function was
 * first extracted.
 *
 * ## Why flooring
 *
 * Flooring rounds in the merchant's favour, which is the direction that does not
 * generate a support ticket. A fraction of a point is not currency and neither
 * side can spend it, so the only question is who absorbs the rounding — and it is
 * not the customer.
 */
export function computeEarnedPoints(
  base: number,
  earnRate: number,
  tierMultiplier: number,
): number {
  const effectivePoints = Math.floor(base * earnRate * tierMultiplier);
  return effectivePoints;
}

/**
 * GET /v1/loyalty/config
 *
 * Read the loyalty program configuration for the current business.
 * Returns the program record or a default skeleton if none exists.
 *
 * The default skeleton is a real program, not a placeholder: it names the
 * accumulation rule and the money unit, because this response is what the
 * merchant-facing screen renders its promise from. An absent rule here is what
 * let that screen claim "1 punto por cada $1.000" for a program with no money
 * anywhere in it.
 */
router.get('/v1/loyalty/config', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  if (!program) {
    return c.json({
      data: {
        earn_rate: '1.0',
        earn_by: DEFAULT_EARN_BY,
        earn_unit_amount: '1000.00',
        program_name: 'Programa de beneficios',
        is_active: true,
      },
    });
  }

  return c.json({
    data: {
      earn_rate: program.earnRate,
      earn_by: program.earnBy ?? DEFAULT_EARN_BY,
      earn_unit_amount: program.earnUnitAmount ?? '1000.00',
      program_name: program.name,
      points_currency: program.pointsCurrency,
      min_redeem_points: program.minRedeemPoints,
      points_expiry_days: program.pointsExpiryDays,
      is_active: program.isActive,
    },
  });
});

/**
 * PUT /v1/loyalty/config
 *
 * Upsert the loyalty program configuration (earn_rate, program_name).
 */
router.put('/v1/loyalty/config', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body, before the program is read, before anything is written.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const body = await c.req.json<{
    earn_rate?: string | number;
    earn_by?: string;
    earn_unit_amount?: string | number;
    program_name?: string;
  }>();

  // -----------------------------------------------------------------------
  // Validate the accumulation rule before any write
  // -----------------------------------------------------------------------
  // Both branches of this handler write, so the guard has to sit in front of
  // both rather than inside the update branch: a program created with an
  // unusable rate is a program the earn route cannot run.
  if (body.earn_rate !== undefined && !isUsableEarnRate(body.earn_rate)) {
    return c.json(
      {
        error: {
          code: INVALID_EARN_RATE,
          message: `earn_rate must be a number greater than 0 and at most ${MAX_EARN_RATE}`,
        },
      },
      400,
    );
  }

  if (body.earn_by !== undefined && !isEarnBy(body.earn_by)) {
    return c.json(
      {
        error: {
          code: INVALID_EARN_BY,
          message: `earn_by must be one of: ${EARN_BY_VALUES.join(', ')}`,
        },
      },
      400,
    );
  }

  // Switching to `purchase` without saying what a unit of money is would start
  // paying out against the $1.000 default the merchant never chose. Requiring
  // the unit in the same request is the only way that default can never be
  // mistaken for a decision.
  if (body.earn_by === 'purchase' && body.earn_unit_amount === undefined) {
    return c.json(
      {
        error: {
          code: INVALID_EARN_UNIT_AMOUNT,
          message:
            'earn_unit_amount is required when earn_by is "purchase": it is the money amount, in pesos, that earn_rate points are worth',
        },
      },
      400,
    );
  }

  if (
    body.earn_unit_amount !== undefined &&
    parseEarnUnitAmount(body.earn_unit_amount) === null
  ) {
    return c.json(
      {
        error: {
          code: INVALID_EARN_UNIT_AMOUNT,
          message: `earn_unit_amount must be a number greater than 0 and at most ${MAX_EARN_UNIT_AMOUNT} pesos`,
        },
      },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const [existing] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  if (existing) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (body.earn_rate !== undefined) updateData.earnRate = String(body.earn_rate);
    if (body.earn_by !== undefined) updateData.earnBy = body.earn_by;
    if (body.earn_unit_amount !== undefined) {
      updateData.earnUnitAmount = String(body.earn_unit_amount);
    }
    if (body.program_name !== undefined) updateData.name = body.program_name;

    const [updated] = await db
      .update(loyaltyPrograms)
      .set(updateData)
      .where(eq(loyaltyPrograms.id, existing.id))
      .returning();

    return c.json({
      data: {
        earn_rate: updated.earnRate,
        earn_by: updated.earnBy,
        earn_unit_amount: updated.earnUnitAmount,
        program_name: updated.name,
      },
    });
  }

  // Insert new program config
  const [inserted] = await db
    .insert(loyaltyPrograms)
    .values({
      businessId,
      name: body.program_name ?? 'Programa de beneficios',
      earnRate: body.earn_rate !== undefined ? String(body.earn_rate) : '1.0',
      ...(body.earn_by !== undefined ? { earnBy: body.earn_by } : {}),
      ...(body.earn_unit_amount !== undefined
        ? { earnUnitAmount: String(body.earn_unit_amount) }
        : {}),
    })
    .returning();

  return c.json(
    {
      data: {
        earn_rate: inserted.earnRate,
        earn_by: inserted.earnBy,
        earn_unit_amount: inserted.earnUnitAmount,
        program_name: inserted.name,
      },
    },
    201,
  );
});

// ============================================================================
// Membership Tiers CRUD
// ============================================================================

/**
 * GET /v1/loyalty/tiers
 *
 * List all membership tiers for the current business, ordered by display_order.
 */
router.get('/v1/loyalty/tiers', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const tiers = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.businessId, businessId))
    .orderBy(membershipTiers.displayOrder);

  return c.json({ data: tiers });
});

/**
 * The slice of a tier that decides where it sits in the ladder.
 *
 * `name` travels with it only so a conflict can be reported in terms the
 * merchant can act on.
 */
export interface TierOrdering {
  name: string;
  minPoints: number;
  displayOrder: number;
}

export interface TierOrderingConflict {
  /** The tier that asks for fewer points than the tier it sorts after. */
  name: string;
  minPoints: number;
  displayOrder: number;
  /** The already-placed tier that the one above contradicts. */
  conflictsWith: string;
  conflictingMinPoints: number;
  conflictingDisplayOrder: number;
}

/** Stable, specific code. Callers can branch on this without parsing prose. */
const TIER_ORDERING_CONFLICT = 'TIER_ORDERING_CONFLICT';

/**
 * Find the first rung that breaks the ladder, or `null` when the ladder holds.
 *
 * The ordering here is exactly the one `GET /v1/loyalty/tiers` and the customer
 * app render by: `(displayOrder ASC, minPoints ASC)`. A ladder is coherent when
 * `minPoints` is non-decreasing in that order — that is precisely the condition
 * under which a rung with a lower threshold can still appear after one with a
 * higher threshold, which is what made the customer pass claim the top level
 * while listing a reached rung underneath it.
 *
 * Non-decreasing, not strictly increasing: two tiers sharing a threshold is a
 * legitimate alias and leaves the sequence valid. Only a real decrease fails.
 *
 * Takes the *whole resulting set*, not the candidate alone, so a single rule
 * governs both create and update. The caller is responsible for the tenant
 * scope and for leaving the tier being updated out of `tiers`.
 */
export function findTierOrderingConflict(
  tiers: readonly TierOrdering[],
): TierOrderingConflict | null {
  const ordered = tiers
    .map((tier) => ({
      ...tier,
      minPoints: Number(tier.minPoints ?? 0),
      displayOrder: Number(tier.displayOrder ?? 0),
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder || a.minPoints - b.minPoints);

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];

    if (current.minPoints < previous.minPoints) {
      return {
        name: current.name,
        minPoints: current.minPoints,
        displayOrder: current.displayOrder,
        conflictsWith: previous.name,
        conflictingMinPoints: previous.minPoints,
        conflictingDisplayOrder: previous.displayOrder,
      };
    }
  }

  return null;
}

/**
 * Turn a conflict into a sentence the caller can act on: which tier, which
 * number, and the one it collides with.
 *
 * Only ever names tiers from the tenant's own set — the comparison is scoped
 * before it reaches here, so this cannot surface another tenant's data.
 */
function describeTierOrderingConflict(conflict: TierOrderingConflict): string {
  return (
    `Tier "${conflict.name}" asks for ${conflict.minPoints} points at display_order ` +
    `${conflict.displayOrder}, so it sorts after "${conflict.conflictsWith}" ` +
    `(${conflict.conflictingMinPoints} points, display_order ${conflict.conflictingDisplayOrder}) ` +
    `while requiring fewer points. Tiers ordered by (display_order, min_points) must never ` +
    `decrease in min_points. Raise "${conflict.name}" to at least ` +
    `${conflict.conflictingMinPoints} points, or move it earlier in display_order.`
  );
}

/**
 * POST /v1/loyalty/tiers
 *
 * Create a new membership tier.
 *
 * The tenant's ladder must stay coherent: the new tier is placed into the
 * existing ones and the whole set is checked, so a rung cannot be written that
 * asks for fewer points than the rung displayed before it.
 */
router.post('/v1/loyalty/tiers', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body and before the ladder is read: the ladder is the tenant's
  // own merchandising, which a customer token has no business observing.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const body = await c.req.json<{
    name: string;
    min_points: number;
    multiplier: number;
    benefits?: unknown[];
    display_order?: number;
  }>();

  if (!body.name || body.min_points === undefined || body.multiplier === undefined) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name, min_points, and multiplier are required' } },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Find the loyalty program for this business
  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  if (!program) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Loyalty program not found. Configure it first.' } },
      404,
    );
  }

  // Tenant-scoped: only this business's tiers are ever compared. The candidate
  // is folded into that set and the whole set is validated, so the check is
  // identical to the one PUT runs.
  const existingTiers = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.businessId, businessId));

  const conflict = findTierOrderingConflict([
    ...existingTiers,
    {
      name: body.name,
      minPoints: body.min_points,
      displayOrder: body.display_order ?? 0,
    },
  ]);

  if (conflict) {
    return c.json(
      { error: { code: TIER_ORDERING_CONFLICT, message: describeTierOrderingConflict(conflict) } },
      400,
    );
  }

  const [inserted] = await db
    .insert(membershipTiers)
    .values({
      businessId,
      programId: program.id,
      name: body.name,
      minPoints: body.min_points,
      multiplier: String(body.multiplier),
      benefits: body.benefits ?? [],
      displayOrder: body.display_order ?? 0,
    })
    .returning();

  return c.json({ data: inserted }, 201);
});

/**
 * PUT /v1/loyalty/tiers/:id
 *
 * Update an existing membership tier.
 *
 * The tenant's ladder must stay coherent. The candidate is the merged result —
 * the body overlaid on the stored tier — not the raw request, so a change to
 * `min_points` is judged against the value that will actually be written.
 */
router.put('/v1/loyalty/tiers/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the id is even looked up, so a 403 here cannot be told apart from
  // the 404 an unknown tier would have produced.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    min_points?: number;
    multiplier?: number;
    benefits?: unknown[];
    display_order?: number;
  }>();

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Verify tier exists and belongs to this business
  const [existing] = await db
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, id), eq(membershipTiers.businessId, businessId)))
    .limit(1);

  if (!existing) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Tier not found' } },
      404,
    );
  }

  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) updateData.name = body.name;
  if (body.min_points !== undefined) updateData.minPoints = body.min_points;
  if (body.multiplier !== undefined) updateData.multiplier = String(body.multiplier);
  if (body.benefits !== undefined) updateData.benefits = body.benefits;
  if (body.display_order !== undefined) updateData.displayOrder = body.display_order;

  if (Object.keys(updateData).length === 0) {
    return c.json({ data: existing });
  }

  // Tenant-scoped, and the tier being updated is excluded: leaving it in would
  // make a name-only PUT collide with its own threshold and fail.
  const siblingTiers = await db
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.businessId, businessId));

  const conflict = findTierOrderingConflict([
    ...siblingTiers.filter((tier) => tier.id !== existing.id),
    {
      name: body.name ?? existing.name,
      minPoints: body.min_points ?? existing.minPoints,
      displayOrder: body.display_order ?? existing.displayOrder,
    },
  ]);

  if (conflict) {
    return c.json(
      { error: { code: TIER_ORDERING_CONFLICT, message: describeTierOrderingConflict(conflict) } },
      400,
    );
  }

  const [updated] = await db
    .update(membershipTiers)
    .set(updateData)
    .where(eq(membershipTiers.id, id))
    .returning();

  return c.json({ data: updated });
});

/**
 * DELETE /v1/loyalty/tiers/:id
 *
 * Delete a membership tier.
 * Guard: Cannot delete a tier that has customers assigned.
 * Guard: Cannot delete the lowest tier (min_points = 0).
 */
router.delete('/v1/loyalty/tiers/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the id is looked up, so a 403 cannot be told apart from the 404 an
  // unknown tier would have produced, and before the customer count that a
  // would-be delete reports on.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Verify tier exists and belongs to this business
  const [existing] = await db
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, id), eq(membershipTiers.businessId, businessId)))
    .limit(1);

  if (!existing) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Tier not found' } },
      404,
    );
  }

  // Protect the lowest tier (min_points = 0)
  if (existing.minPoints === 0) {
    return c.json(
      { error: { code: 'PROTECTED_TIER', message: 'Cannot delete the lowest tier. Set a different base tier first.' } },
      409,
    );
  }

  // Check if any customers are assigned to this tier
  const [customerCount] = await db
    .select({ total: count() })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.currentTierId, id)));

  if ((customerCount?.total ?? 0) > 0) {
    return c.json(
      { error: { code: 'TIER_HAS_CUSTOMERS', message: 'Cannot delete tier with active members.' } },
      409,
    );
  }

  await db.delete(membershipTiers).where(eq(membershipTiers.id, id));

  return c.body(null, 204);
});

// ============================================================================
// Points Assign
// ============================================================================

/**
 * POST /v1/loyalty/points/assign
 *
 * Assign points to a customer.
 *
 * Atomic: balance_after = previous balance + the points this route computes.
 * Dedup: referenceId unique per customer → 409
 * After success, publishes a PointsAssigned event.
 *
 * ## Who computes the points: this route, from the tenant's rule
 *
 * `docs/17-Estrategia-Competitiva.md` §7.5 settles the open question as "A. El
 * Growth, con la regla en config del tenant" — the merchant controls their
 * program. So which body field is the *input* depends on the program's
 * `earn_by`, and the two are not interchangeable:
 *
 *   earn_by = 'visit'    → the caller sends `points`: a qualifying count. There
 *                           is no amount to convert, and inventing one would be a
 *                           lie about what the cashier saw.
 *   earn_by = 'purchase' → the caller sends `amount_pesos`, and the points are
 *                           derived here: floor(amount / unit × earnRate × tier).
 *                           A `points` value in the body is refused rather than
 *                           trusted, because a caller-supplied count next to a
 *                           money amount is precisely the hole §7.5 describes —
 *                           whoever sends it decides the customer's balance.
 *
 * Both formulas floor. Flooring a money conversion rounds in the merchant's
 * favour, which is the direction that does not generate a support ticket.
 */
router.post('/v1/loyalty/points/assign', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body, before the earn rate is resolved, and above all before the
  // INSERT. `points` is only ever validated as >= 1, so a customer reaching this
  // line could mint an arbitrary balance and then spend it on `redeem`. The
  // whole path has to be unreachable, not just unprofitable.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const body = await c.req.json<{
    customer_id: string;
    points?: number;
    amount_pesos?: string | number;
    branch_id?: string;
    note?: string;
    reference_id: string;
  }>();

  // `customer_id` and `reference_id` are required under either mechanic. The
  // third field is not, and asserting it here would assert the wrong one: which
  // field the program consumes is a fact about the tenant's config, so it can
  // only be judged after the program is read below.
  if (!body.customer_id || !body.reference_id) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'customer_id and reference_id are required' } },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // -----------------------------------------------------------------------
  // Resolve the accumulation rule from loyalty program config
  // -----------------------------------------------------------------------
  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  const earnBy = isEarnBy(program?.earnBy) ? program.earnBy : DEFAULT_EARN_BY;
  // Never `Number(program?.earnRate)` directly: `NaN` from a rate the write path
  // predates would reach `points_transactions.points` and produce a balance no
  // customer can spend and no redemption can move.
  const earnRate = resolveEarnRate(program?.earnRate ?? '1.0');

  /**
   * What this request is worth, expressed in the program's unit and *before* the
   * rate and the tier bonus are applied. It is the single input the shared
   * formula below multiplies, so the two mechanics differ only in how this
   * number is arrived at:
   *
   *   visit    → the caller's qualifying count, used as-is. There is no amount
   *              to convert: with a manual scanner the honest fact is "a visit
   *              happened", not "the customer spent $4.500".
   *   purchase → the money amount divided by the tenant's unit, so `base` is how
   *              many units of `earn_rate` the amount bought.
   */
  let base: number;

  if (earnBy === 'purchase') {
    const amount = parseEarnUnitAmount(body.amount_pesos);

    if (amount === null) {
      return c.json(
        {
          error: {
            code: body.amount_pesos === undefined ? 'AMOUNT_REQUIRED' : 'INVALID_AMOUNT',
            message:
              'This program earns by purchase, so amount_pesos is required and must be a number greater than 0. Points are derived from it by the program rule, not taken from the request.',
          },
        },
        400,
      );
    }

    const unit = parseEarnUnitAmount(program?.earnUnitAmount ?? '1000.00');
    if (unit === null) {
      // A purchase program whose unit cannot be read. Refusing the sale is the
      // honest answer: paying out against a guessed unit pays real money's worth
      // of points, and no fallback unit is safe by default.
      return c.json(
        {
          error: {
            code: INVALID_EARN_UNIT_AMOUNT,
            message:
              'This program earns by purchase but its earn_unit_amount is unusable. Set it to the money amount, in pesos, that earn_rate points are worth.',
          },
        },
        409,
      );
    }

    base = amount / unit;
  } else {
    // A visit program has no money rule. If an amount arrived alongside, silently
    // dropping it would credit the count the caller happened to also send and
    // report a number the merchant's own rule never produced.
    if (body.amount_pesos !== undefined) {
      return c.json(
        {
          error: {
            code: 'VISIT_COUNT_REQUIRED',
            message:
              'This program earns by visit, so it has no money rule. Send the qualifying count as points, and switch the program to earn_by "purchase" to earn from a purchase amount.',
          },
        },
        400,
      );
    }

    const points = Number(body.points);
    if (!Number.isInteger(points) || points < 1) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'This program earns by visit, so points is required and must be a positive integer',
          },
        },
        400,
      );
    }

    base = points;
  }

  // -----------------------------------------------------------------------
  // Resolve tier multiplier from customer's current tier
  // -----------------------------------------------------------------------
  let tierMultiplier = 1.0;

  // Get the customer's current tier (if any)
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, body.customer_id)))
    .limit(1);

  if (customer?.currentTierId) {
    const [tier] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, customer.currentTierId))
      .limit(1);

    if (tier) {
      // Same reason as `earnRate`: `Number('N/A')` is `NaN`, and the tier bonus is
      // multiplied straight into the ledger row.
      tierMultiplier = resolveEarnRate(tier.multiplier);
    }
  }

  // One formula, one place — and it is now literally one place. This route used
  // to hold the arithmetic inline, which made it unreusable: the second caller
  // (`POST /v1/checkins`, for a merchant's own terminal reporting a completed
  // sale) would have had to copy the expression, and two copies of a points rule
  // is two rules.
  //
  // `earnRate` and `tierMultiplier` are both read from columns this route did not
  // write, and `resolveEarnRate` on each keeps them finite and positive, so the
  // guard below is the last line before a `NaN` would be stored as
  // `points_transactions.points`. The expression itself and why it is pinned by
  // the dashboard's contract test are documented in `computeEarnedPoints`.
  const effectivePoints = computeEarnedPoints(base, earnRate, tierMultiplier);
  if (!Number.isFinite(effectivePoints)) {
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'The loyalty program rule produced a non-finite points value',
        },
      },
      500,
    );
  }

  // -----------------------------------------------------------------------
  // Atomic insert with balance calculation
  // -----------------------------------------------------------------------
  try {
    const result = await db.execute(sql`
      INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note)
      VALUES (
        ${businessId}::uuid,
        ${body.customer_id}::uuid,
        'earn',
        ${effectivePoints}::integer,
        COALESCE(
          (SELECT balance_after FROM points_transactions WHERE customer_id = ${body.customer_id}::uuid ORDER BY created_at DESC LIMIT 1),
          0
        ) + ${effectivePoints}::integer,
        ${body.reference_id},
        ${body.note ?? null}
      )
      RETURNING id, business_id, customer_id, type, points, balance_after, reference_id, note, created_at
    `);

    const tx = result.rows?.[0];
    if (!tx) {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Failed to create transaction' } },
        500,
      );
    }

    // -----------------------------------------------------------------------
    // Publish PointsAssigned event
    // -----------------------------------------------------------------------
    const event = buildPointsAssignedEvent(
      body.customer_id,
      businessId,
      effectivePoints,
      tierMultiplier,
      Number(tx.balance_after),
      body.reference_id,
    );

    await publish(c.env.DOMAIN_EVENTS_QUEUE, event);

    // The balance moved, so the pass has to learn that it moved. Handed off here
    // rather than awaited, and placed after the event publish so the only thing
    // between the customer and the 201 is the work being *given away* — never a
    // Google round trip. Before the INSERT it would project a number the ledger
    // does not hold yet, and that number is the one a cashier reads aloud.
    schedulePassReconcile(c, { tenantId: businessId, customerId: body.customer_id });

    return c.json({ data: tx }, 201);
  } catch (err: unknown) {
    const error = err as { message?: string; code?: string };
    // Detect unique constraint violation on (customer_id, reference_id)
    if (error.message?.includes('uq_points_tx_reference') || error.code === '23505') {
      return c.json(
        { error: { code: 'DUPLICATE_REFERENCE', message: 'A transaction with this reference_id already exists for this customer' } },
        409,
      );
    }
    throw err;
  }
});

// ============================================================================
// Points Transactions History
// ============================================================================

/**
 * GET /v1/loyalty/points/transactions
 *
 * Paginated transaction history scoped by X-Business-Id.
 * Supports ?customer_id=, ?type=earn|redeem, ?page=, ?limit= filters.
 *
 * `customer_id` is optional, and who it may name depends on the role. A
 * customer is always narrowed to their own record — derived from the token,
 * never from the query string — so omitting the parameter means "mine", not
 * "everyone in this tenant". Naming someone else is a 403. An operator may
 * still name any customer, and naming none still lists the whole tenant.
 */
router.get('/v1/loyalty/points/transactions', async (c) => {
  const auth = extractAuthHeaders(c);
  const { businessId } = auth;
  const typeFilter = c.req.query('type');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const effective = await resolveEffectiveCustomer(db, auth, c.req.query('customer_id'));
  if (!effective.ok) {
    return c.json({ error: { code: effective.code, message: effective.message } }, effective.status);
  }
  const customerId = effective.customerId;

  // Build WHERE conditions
  const conditions: ReturnType<typeof and>[] = [
    eq(pointsTransactions.businessId, businessId),
  ];

  if (customerId) {
    conditions.push(eq(pointsTransactions.customerId, customerId));
  }

  if (typeFilter === 'earn' || typeFilter === 'redeem') {
    conditions.push(eq(pointsTransactions.type, typeFilter));
  }

  const where = and(...conditions);

  // Count total + fetch page in parallel
  const [totalResult, items] = await Promise.all([
    db.select({ total: count() }).from(pointsTransactions).where(where),
    db
      .select({
        id: pointsTransactions.id,
        customer_id: pointsTransactions.customerId,
        type: pointsTransactions.type,
        points: pointsTransactions.points,
        balance_after: pointsTransactions.balanceAfter,
        reference_id: pointsTransactions.referenceId,
        note: pointsTransactions.note,
        created_at: pointsTransactions.createdAt,
      })
      .from(pointsTransactions)
      .where(where)
      .orderBy(desc(pointsTransactions.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
  ]);

  const total = Number(totalResult[0]?.total ?? 0);

  return c.json({
    data: items,
    meta: { total, page, per_page: limit },
  });
});

// ============================================================================
// Rewards Catalog CRUD
// ============================================================================

/**
 * POST /v1/loyalty/rewards
 *
 * Create a new reward in the catalog.
 * Name must be unique per business.
 */
router.post('/v1/loyalty/rewards', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body and before the duplicate-name read, so the catalog cannot
  // be used to learn which names are taken.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const body = await c.req.json<{
    name: string;
    description?: string;
    points_cost: number;
    category?: string;
    stock?: number | null;
    auto_grant_threshold?: number | null;
    valid_from?: string;
    valid_until?: string;
    image_url?: string;
  }>();

  if (!body.name || body.points_cost === undefined) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name and points_cost are required' } },
      400,
    );
  }

  if (!Number.isInteger(body.points_cost) || body.points_cost < 1) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'points_cost must be a positive integer' } },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Check duplicate name
  const [existing] = await db
    .select({ id: rewards.id })
    .from(rewards)
    .where(and(eq(rewards.businessId, businessId), eq(rewards.name, body.name)))
    .limit(1);

  if (existing) {
    return c.json(
      { error: { code: 'DUPLICATE_REWARD_NAME', message: 'A reward with this name already exists' } },
      409,
    );
  }

  const [inserted] = await db
    .insert(rewards)
    .values({
      businessId,
      name: body.name,
      description: body.description ?? null,
      pointsCost: body.points_cost,
      category: body.category ?? null,
      stock: body.stock ?? null,
      autoGrantThreshold: body.auto_grant_threshold ?? null,
      validFrom: body.valid_from ? new Date(body.valid_from) : null,
      validUntil: body.valid_until ? new Date(body.valid_until) : null,
      imageUrl: body.image_url ?? null,
    })
    .returning();

  return c.json({ data: inserted }, 201);
});

/**
 * GET /v1/loyalty/rewards
 *
 * List rewards for the current business.
 * Supports ?category= and ?active=true filters.
 * Returns paginated results with meta.
 */
router.get('/v1/loyalty/rewards', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const category = c.req.query('category');
  const active = c.req.query('active');
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(c.req.query('per_page') ?? '20', 10) || 20));

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Build where conditions
  const conditions: ReturnType<typeof and>[] = [eq(rewards.businessId, businessId)];

  if (category) {
    conditions.push(eq(rewards.category, category));
  }

  if (active === 'true') {
    conditions.push(
      or(
        isNull(rewards.validFrom),
        lte(rewards.validFrom, sql`now()`),
      ),
      or(
        isNull(rewards.validUntil),
        gte(rewards.validUntil, sql`now()`),
      ),
      or(
        isNull(rewards.stock),
        gt(rewards.stock, 0),
      ),
    );
  }

  const where = and(...conditions);

  // Count total
  const [totalResult] = await db
    .select({ total: count() })
    .from(rewards)
    .where(where);

  const total = Number(totalResult?.total ?? 0);

  // Fetch page
  const items = await db
    .select()
    .from(rewards)
    .where(where)
    .orderBy(desc(rewards.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);

  return c.json({
    data: items,
    meta: { total, page, per_page: perPage },
  });
});

/**
 * GET /v1/loyalty/rewards/:id
 *
 * Get a single reward by id.
 */
router.get('/v1/loyalty/rewards/:id', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const id = c.req.param('id');

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const [reward] = await db
    .select()
    .from(rewards)
    .where(and(eq(rewards.id, id), eq(rewards.businessId, businessId)))
    .limit(1);

  if (!reward) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Reward not found' } },
      404,
    );
  }

  return c.json({ data: reward });
});

/**
 * PUT /v1/loyalty/rewards/:id
 *
 * Update an existing reward.
 * Name uniqueness enforced per business.
 */
router.put('/v1/loyalty/rewards/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the id is looked up, so a 403 cannot be told apart from the 404 an
  // unknown reward would have produced.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    points_cost?: number;
    category?: string | null;
    stock?: number | null;
    auto_grant_threshold?: number | null;
    valid_from?: string | null;
    valid_until?: string | null;
    image_url?: string | null;
  }>();

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Verify reward exists and belongs to this business
  const [existing] = await db
    .select()
    .from(rewards)
    .where(and(eq(rewards.id, id), eq(rewards.businessId, businessId)))
    .limit(1);

  if (!existing) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Reward not found' } },
      404,
    );
  }

  // Name uniqueness check (if name changed)
  if (body.name !== undefined && body.name !== existing.name) {
    const [nameCollision] = await db
      .select({ id: rewards.id })
      .from(rewards)
      .where(and(eq(rewards.businessId, businessId), eq(rewards.name, body.name)))
      .limit(1);

    if (nameCollision) {
      return c.json(
        { error: { code: 'DUPLICATE_REWARD_NAME', message: 'A reward with this name already exists' } },
        409,
      );
    }
  }

  const updateData: Record<string, unknown> = {};
  if (body.name !== undefined) updateData.name = body.name;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.points_cost !== undefined) updateData.pointsCost = body.points_cost;
  if (body.category !== undefined) updateData.category = body.category;
  if (body.stock !== undefined) updateData.stock = body.stock;
  if (body.auto_grant_threshold !== undefined) updateData.autoGrantThreshold = body.auto_grant_threshold;
  if (body.valid_from !== undefined) updateData.validFrom = body.valid_from ? new Date(body.valid_from) : null;
  if (body.valid_until !== undefined) updateData.validUntil = body.valid_until ? new Date(body.valid_until) : null;
  if (body.image_url !== undefined) updateData.imageUrl = body.image_url;

  if (Object.keys(updateData).length === 0) {
    return c.json({ data: existing });
  }

  updateData.updatedAt = new Date();

  const [updated] = await db
    .update(rewards)
    .set(updateData)
    .where(eq(rewards.id, id))
    .returning();

  return c.json({ data: updated });
});

/**
 * DELETE /v1/loyalty/rewards/:id
 *
 * Soft-delete a reward by setting deleted_at.
 */
router.delete('/v1/loyalty/rewards/:id', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the id is looked up, so a 403 cannot be told apart from the 404 an
  // unknown reward would have produced.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Verify reward exists and belongs to this business
  const [existing] = await db
    .select()
    .from(rewards)
    .where(and(eq(rewards.id, id), eq(rewards.businessId, businessId)))
    .limit(1);

  if (!existing) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Reward not found' } },
      404,
    );
  }

  await db
    .update(rewards)
    .set({ deletedAt: new Date() })
    .where(eq(rewards.id, id));

  return c.json({ data: { id } });
});

// ============================================================================
// Rewards Redeem
// ============================================================================

/**
 * POST /v1/loyalty/rewards/redeem
 *
 * Redeem loyalty points for a reward.
 *
 * - Catalog validation: if `reward_id` provided, validates reward is active,
 *   in-stock, within valid dates, and customer has enough points.
 * - Atomic stock deduction: stock decremented in same transaction as points
 *   when reward_id is present.
 * - Balance check: returns 409 INSUFFICIENT_BALANCE if not enough points
 *   and partial is false.
 * - Partial redeem: when partial: true and points > balance, consumes all
 *   available points and reports partial fulfillment.
 * - Dedup: referenceId unique per customer → 409
 * - After success, publishes a RewardRedeemed event with reward_id.
 * - Ownership: `customer_id` is optional and role-aware. A customer redeems
 *   against their own balance only — resolved from the token, never from the
 *   body — so naming another customer is a 403 and no transaction is written.
 *   An operator may still name any customer in the tenant, which is what the
 *   dashboard POS does with a scanned customer.
 */
router.post('/v1/loyalty/rewards/redeem', async (c) => {
  const auth = extractAuthHeaders(c);
  const { businessId } = auth;
  const body = await c.req.json<{
    customer_id?: string;
    points: number;
    reward_id?: string;
    reward_name?: string;
    partial?: boolean;
    reference_id: string;
  }>();

  // A customer may omit `customer_id` — it then means "my own record", so it
  // is only required of an operator, who has no other way to say whose
  // balance to spend.
  const customerIdMissing = !isCustomerRole(auth) && !body.customer_id;
  if (customerIdMissing || !body.points || !body.reference_id) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'customer_id, points, and reference_id are required' } },
      400,
    );
  }

  if (body.points < 1) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'points must be a positive integer' } },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Ownership before anything is read about a reward or written about a
  // balance: the reward catalog is tenant-scoped, but the balance is not, and
  // a 403 here must leave no transaction behind.
  const effective = await resolveEffectiveCustomer(db, auth, body.customer_id);
  if (!effective.ok) {
    return c.json({ error: { code: effective.code, message: effective.message } }, effective.status);
  }
  // Non-null by construction: an operator who named no customer was rejected
  // above, and a customer always resolves to their own row.
  const customerId = effective.customerId as string;

  // -----------------------------------------------------------------------
  // Validate reward catalog (if reward_id provided)
  // -----------------------------------------------------------------------
  let resolvedRewardId: string | undefined;
  let resolvedRewardName: string | undefined = body.reward_name;

  if (body.reward_id) {
    const [reward] = await db
      .select()
      .from(rewards)
      .where(and(eq(rewards.id, body.reward_id), eq(rewards.businessId, businessId)))
      .limit(1);

    if (!reward || reward.deletedAt) {
      return c.json(
        { error: { code: 'REWARD_NOT_FOUND', message: 'Reward not found' } },
        404,
      );
    }

    // Validate active dates
    if (reward.validFrom && new Date(reward.validFrom) > new Date()) {
      return c.json(
        { error: { code: 'REWARD_INACTIVE', message: 'Reward is not yet active' } },
        409,
      );
    }
    if (reward.validUntil && new Date(reward.validUntil) < new Date()) {
      return c.json(
        { error: { code: 'REWARD_INACTIVE', message: 'Reward has expired' } },
        409,
      );
    }

    // Validate stock
    if (reward.stock !== null && reward.stock <= 0) {
      return c.json(
        { error: { code: 'REWARD_OUT_OF_STOCK', message: 'Reward is out of stock' } },
        409,
      );
    }

    // Validate points match
    if (body.points < reward.pointsCost) {
      return c.json(
        { error: { code: 'INSUFFICIENT_POINTS', message: `This reward requires ${reward.pointsCost} points` } },
        409,
      );
    }

    resolvedRewardId = reward.id;
    resolvedRewardName = reward.name;
  }

  // -----------------------------------------------------------------------
  // Get current balance
  // -----------------------------------------------------------------------
  const balanceResult = await db.execute(sql`
    SELECT COALESCE(
      (SELECT balance_after FROM points_transactions WHERE customer_id = ${customerId}::uuid ORDER BY created_at DESC LIMIT 1),
      0
    ) AS balance
  `);

  const currentBalance = Number(balanceResult.rows?.[0]?.balance ?? 0);

  // -----------------------------------------------------------------------
  // Determine actual redeem amount
  // -----------------------------------------------------------------------
  let redeemPoints: number;
  let isPartial = false;

  if (body.points <= currentBalance) {
    redeemPoints = body.points;
  } else if (body.partial === true) {
    redeemPoints = currentBalance;
    isPartial = true;
  } else {
    return c.json(
      {
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Customer has ${currentBalance} points but ${body.points} are required`,
        },
      },
      409,
    );
  }

  // If balance is already zero and partial, there's nothing to redeem
  if (redeemPoints <= 0) {
    return c.json(
      { error: { code: 'INSUFFICIENT_BALANCE', message: 'Customer has no points to redeem' } },
      409,
    );
  }

  // -----------------------------------------------------------------------
  // Atomic insert with balance deduction (+ stock deduction if reward_id)
  // -----------------------------------------------------------------------
  try {
    // When reward_id is provided, wrap both ops in a transaction
    const performRedeem = async () => {
      if (resolvedRewardId) {
        return await db.transaction(async (tx) => {
          const txResult = await tx.execute(sql`
            INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note)
            VALUES (
              ${businessId}::uuid,
              ${customerId}::uuid,
              'redeem',
              ${redeemPoints}::integer,
              COALESCE(
                (SELECT balance_after FROM points_transactions WHERE customer_id = ${customerId}::uuid ORDER BY created_at DESC LIMIT 1),
                0
              ) - ${redeemPoints}::integer,
              ${body.reference_id},
              ${resolvedRewardName ?? null}
            )
            RETURNING id, business_id, customer_id, type, points, balance_after, reference_id, note, created_at
          `);

          // Atomic stock decrement — no-op if already out of stock
          await tx.execute(sql`
            UPDATE rewards SET stock = stock - 1 WHERE id = ${resolvedRewardId}::uuid AND stock > 0
          `);

          return txResult;
        });
      }

      // No reward_id — keep existing simple flow
      return await db.execute(sql`
        INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note)
        VALUES (
          ${businessId}::uuid,
          ${customerId}::uuid,
          'redeem',
          ${redeemPoints}::integer,
          COALESCE(
            (SELECT balance_after FROM points_transactions WHERE customer_id = ${customerId}::uuid ORDER BY created_at DESC LIMIT 1),
            0
          ) - ${redeemPoints}::integer,
          ${body.reference_id},
          ${resolvedRewardName ?? null}
        )
        RETURNING id, business_id, customer_id, type, points, balance_after, reference_id, note, created_at
      `);
    };

    const result = await performRedeem();
    const tx = result.rows?.[0];
    if (!tx) {
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Failed to create transaction' } },
        500,
      );
    }

    const balanceAfter = Number(tx.balance_after);

    // -----------------------------------------------------------------------
    // Publish RewardRedeemed event
    // -----------------------------------------------------------------------
    const event = buildRewardRedeemedEvent(
      customerId,
      businessId,
      redeemPoints,
      balanceAfter,
      body.reference_id,
      isPartial,
      resolvedRewardName,
      resolvedRewardId,
    );

    await publish(c.env.DOMAIN_EVENTS_QUEUE, event);

    // Same shape as the earn path, and placed for the same reasons — with one
    // extra constraint this route has and the earn route does not: the ledger
    // write above may have run inside `db.transaction`, and it is this line's
    // job to sit strictly *after* it. A projection fired from inside that
    // transaction would ask the wallet to read a balance the transaction can
    // still roll back, so a redemption that fails to commit would leave Google's
    // pass holding a number the ledger never agreed to — and unlike a stale
    // balance, that one is wrong in the direction that lets a customer spend
    // points they no longer have. `await performRedeem()` above has already
    // resolved, so this is after the commit on both branches: the transactional
    // one and the plain one.
    //
    // Redemption is also where an over-limit balance must stop being pushed, and
    // the reason is the earn path's reason inverted: spending is the only
    // operation that can drive a balance to a number no pass can render, and
    // that refusal belongs to the wallet's `reconcilePass`, which is why this
    // hands it a customer id and nothing else.
    schedulePassReconcile(c, { tenantId: businessId, customerId });

    return c.json(
      {
        data: tx,
        partial: isPartial,
        fulfilled: redeemPoints,
        requested: body.points,
      },
      201,
    );
  } catch (err: unknown) {
    const error = err as { message?: string; code?: string };
    // Detect unique constraint violation on (customer_id, reference_id)
    if (error.message?.includes('uq_points_tx_reference') || error.code === '23505') {
      return c.json(
        { error: { code: 'DUPLICATE_REFERENCE', message: 'A transaction with this reference_id already exists for this customer' } },
        409,
      );
    }
    throw err;
  }
});

// ============================================================================
// A sale that already happened
// ============================================================================

/** Stable, specific codes. Callers branch on these rather than parsing prose. */
export const MEMBER_CODE_NOT_FOUND = 'MEMBER_CODE_NOT_FOUND';
export const INVALID_MEMBER_CODE = 'INVALID_MEMBER_CODE';
export const INVALID_AMOUNT_CENTS = 'INVALID_AMOUNT_CENTS';

/**
 * Resolve a scanned `member_code` to a customer of *this* business.
 *
 * Tenant-scoped on the same column the unique index is scoped on, and that is the
 * whole reason the credential's scope is sufficient: `member_code` is unique per
 * business (`uq_customers_business_member_code`), so `business_id` is not a
 * convenience filter here, it is what makes the lookup unambiguous. A terminal
 * holding merchant A's credential cannot name merchant B's pass, because the code
 * it would have to guess is not in A's index.
 *
 * `deletedAt` is excluded for the reason `resolveOwnCustomer` excludes it: a
 * withdrawn membership must not keep accruing points. Reading it here rather than
 * trusting the caller also means the two passes endpoints and the checkin writer
 * cannot disagree about whether a customer exists.
 *
 * `currentTierId` comes back in the same read because the earn rule needs it and
 * this is the row already in hand — the tier is resolved at the moment of the
 * sale, which is the property that makes the server the authority rather than the
 * POS that previewed it.
 */
async function resolveMemberCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  memberCode: string,
): Promise<{ id: string; currentTierId: string | null } | undefined> {
  const [customer] = await db
    .select({ id: customers.id, currentTierId: customers.currentTierId })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        eq(customers.memberCode, memberCode),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  return customer as { id: string; currentTierId: string | null } | undefined;
}

/**
 * POST /v1/passes/resolve
 *
 * "Does this code belong to someone?" — the question a cashier asks at the till.
 *
 * ## The rule that shapes this route
 *
 * **Our failure must never cost a merchant a sale.** A 500 on this screen means
 * we denied a customer their coffee because our side had a problem, and that is
 * not a tolerable bug class: it is our outage becoming their lost revenue. So the
 * answer is always "keep charging". A `known: false` is *information* — the
 * cashier can proceed, just without attributing the sale — and not a veto.
 *
 * Which is why this creates nothing, holds no state, and answers 200 for both
 * outcomes. It is a lookup dressed up as a route because a POST is what a
 * terminal's scan reader naturally produces, not because there is anything to
 * write.
 *
 * `business_id` comes from the header and never from the body. It is the
 * credential's scope that stops one terminal resolving another merchant's pass,
 * and a body field would be the caller choosing its own scope.
 */
router.post('/v1/passes/resolve', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{ member_code?: unknown }>();

  // A missing or non-string code is answered as "unknown" rather than refused,
  // and the distinction is deliberate: refusing is a veto, and the rule above says
  // this route does not veto. Nothing is looked up, so nothing can leak either.
  if (typeof body.member_code !== 'string' || body.member_code.length === 0) {
    return c.json({ data: { known: false } });
  }

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const customer = await resolveMemberCode(db, businessId, body.member_code);

  if (!customer) {
    return c.json({ data: { known: false } });
  }

  // `fullName` is the real column, not an invented `display_name`. It is
  // nullable, so the field is passed through as-is rather than defaulted: a
  // customer with no name on file is a gap in our data, and papering over it with
  // a placeholder the cashier reads aloud is worse than an empty field.
  const [profile] = await db
    .select({ fullName: customers.fullName })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customer.id)))
    .limit(1);

  return c.json({
    data: {
      known: true,
      customer_id: customer.id,
      display_name: profile?.fullName ?? null,
    },
  });
});

/**
 * Credit the points a completed sale earned, and record them on the checkin.
 *
 * ## Why this is separate from the route
 *
 * Because it has to run from two places: the first write of a checkin, and a
 * retry that found an earlier row with `points IS NULL`. Putting it here is what
 * makes those two paths the same code rather than two implementations that agree
 * today.
 *
 * ## Why it can leave `points` NULL instead of failing
 *
 * Because a half-finished credit is recoverable and a lost sale is not. Every
 * reason this returns without crediting — an unusable earn rule on the program —
 * leaves the checkin row in place with `points IS NULL`, which is a queryable
 * backlog. The alternative, refusing the whole request, would throw away a sale
 * that genuinely happened over a configuration problem on our side, which is the
 * exact trade the non-negotiable rule forbids.
 *
 * `reference_id` is the `payment_id` on the terminal path, which is what makes
 * the second layer free: `uq_points_tx_reference` over
 * `(customer_id, reference_id)` is the ledger's own dedupe, and the event is
 * already named when it arrives.
 *
 * On the manual path there is no `payment_id`, so the checkin's own id is used as
 * the reference. That is not equivalent dedupe and does not pretend to be: two
 * manual entries for one sale are two sales in the ledger, exactly as documented
 * on the table. Using the checkin id at least keeps the reference present and
 * unique, so the ledger row is attributable rather than anonymous.
 */
async function creditCheckin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  c: Context<{ Bindings: Bindings }>,
  args: {
    businessId: string;
    customer: { id: string; currentTierId: string | null };
    checkinId: string;
    amountCents: number;
    paymentId: string | null;
    // `string | null` rather than optional: both callers pass a value that may be
    // absent, and `exactOptionalPropertyTypes` is on in this package, so an
    // optional property would reject the explicit `undefined` they hand it.
    note: string | null;
  },
): Promise<{ points: number | null; balanceAfter: number | null }> {
  const { businessId, customer, checkinId, amountCents, paymentId } = args;

  const referenceId = paymentId ?? checkinId;

  // -----------------------------------------------------------------------
  // The tenant's accumulation rule
  // -----------------------------------------------------------------------
  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  const earnBy = isEarnBy(program?.earnBy) ? program.earnBy : DEFAULT_EARN_BY;
  const earnRate = resolveEarnRate(program?.earnRate ?? '1.0');

  let tierMultiplier = 1.0;
  if (customer.currentTierId) {
    const [tier] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, customer.currentTierId))
      .limit(1);

    // Same reason as `earnRate`: `Number('N/A')` is `NaN`, and the tier bonus is
    // multiplied straight into the ledger row.
    if (tier) {
      tierMultiplier = resolveEarnRate(tier.multiplier);
    }
  }

  /**
   * What this sale is worth in the program's unit, before the rate and the tier.
   *
   * `purchase` is the mechanic that reads money, and `amount_cents` is
   * authoritative — the figure the payment rail actually settled. It arrives in
   * cents because that is what a rail reports; the tenant's unit is in pesos
   * because that is what a merchant configures, so the /100 is a unit conversion
   * rather than a judgement about the amount.
   *
   * `visit` is the default, and the arithmetic above is not a rounding of the
   * money: a completed sale is one qualifying visit, because "a visit is a count,
   * not a peso amount" is the decision the earn mechanic already settled
   * (`docs/18-Trabajo-Pendiente.md`, "Resuelto — bajo `visit`"). Deriving the
   * count from `amount_cents` here would be the POS bug that made half of every
   * `.50` menu un-saleable.
   *
   * A `purchase` program whose unit cannot be read returns `null` rather than
   * guessing. Paying out against a guessed unit pays real money's worth of
   * points, and the sale is already recorded either way.
   */
  let base: number | null;

  if (earnBy === 'purchase') {
    const unit = parseEarnUnitAmount(program?.earnUnitAmount ?? '1000.00');
    base = unit === null ? null : amountCents / 100 / unit;
  } else {
    base = 1;
  }

  const points = base === null ? null : computeEarnedPoints(base, earnRate, tierMultiplier);

  if (points === null || !Number.isFinite(points) || points < 1) {
    console.error(
      `[growth] Checkin ${checkinId} in tenant ${businessId} was recorded but no points were ` +
        `credited: the program earns by purchase and its earn_unit_amount is unusable, or the ` +
        `rule produced no points. The row keeps points NULL, which is the pending-credit backlog.`,
    );
    return { points: null, balanceAfter: null };
  }

  // -----------------------------------------------------------------------
  // The ledger write
  // -----------------------------------------------------------------------
  // Raw SQL for the same reason `POST /v1/loyalty/points/assign` uses it:
  // `balance_after` has to be read from the previous row of the same customer in
  // the same statement, or two concurrent sales would both read the same balance
  // and one of them would be lost.
  //
  // There is one state in which the INSERT throws, no INSERT lands, and the points
  // are still owed on this checkin: the ledger already holds the reference, so the
  // money moved on an earlier attempt and only the checkin was left behind. That
  // branch falls through to the same update rather than returning early, which is
  // why `balanceAfter` is declared here and read after the `try`: it stays `null`
  // on that path, because this attempt did not observe a balance and reporting one
  // we did not read is the same defect as reporting points we did not earn.
  let balanceAfter: number | null = null;

  try {
    const result = await db.execute(sql`
      INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note)
      VALUES (
        ${businessId}::uuid,
        ${customer.id}::uuid,
        'earn',
        ${points}::integer,
        COALESCE(
          (SELECT balance_after FROM points_transactions WHERE customer_id = ${customer.id}::uuid ORDER BY created_at DESC LIMIT 1),
          0
        ) + ${points}::integer,
        ${referenceId},
        ${args.note}
      )
      RETURNING id, business_id, customer_id, type, points, balance_after, reference_id, note, created_at
    `);

    const tx = result.rows?.[0];
    if (!tx) {
      console.error(
        `[growth] The ledger insert for checkin ${checkinId} returned no row. ` +
          `The checkin keeps points NULL and the credit is pending.`,
      );
      return { points: null, balanceAfter: null };
    }

    balanceAfter = Number(tx.balance_after);

    await publish(
      c.env.DOMAIN_EVENTS_QUEUE,
      buildPointsAssignedEvent(
        customer.id,
        businessId,
        points,
        tierMultiplier,
        balanceAfter,
        referenceId,
      ),
    );

    // The balance moved, so the pass has to learn that it moved. Handed off rather
    // than awaited for the reason documented on `schedulePassReconcile`: a Google
    // round trip must never be on a sale's critical path.
    schedulePassReconcile(c, { tenantId: businessId, customerId: customer.id });
  } catch (err: unknown) {
    const error = err as { message?: string; code?: string };

    if (error.message?.includes('uq_points_tx_reference') || error.code === '23505') {
      // The ledger already has this reference. That means a *previous* attempt
      // credited it and then died before writing `points` back onto the checkin —
      // which is exactly the partial failure this route is shaped around. The
      // credit is not repeated; the checkin is simply brought up to date, and the
      // customer ends with one credit, not two.
      console.error(
        `[growth] Checkin ${checkinId} already has a ledger row for reference ${referenceId}; ` +
          `the credit landed on an earlier attempt and only the checkin was left behind.`,
      );
    } else {
      throw err;
    }
  }

  // The credit is on the ledger, one way or the other. Recording it on the checkin
  // is what turns "pending" into "done", and it is deliberately a separate
  // statement from the insert above: this one is idempotent by nature — writing
  // the same points twice changes nothing — whereas the ledger row is not.
  await db
    .update(checkins)
    .set({ points })
    .where(eq(checkins.id, checkinId));

  return { points, balanceAfter };
}

/**
 * POST /v1/checkins
 *
 * Record a sale that has already been paid for, and credit what it earned.
 *
 * ## The shape of the flow, and why
 *
 * This is the second half of a two-endpoint contract, and it happens at a
 * different moment than `/v1/passes/resolve`: that one answers "is this pass
 * real?" at the till before the money moves, this one records the fact *after* it
 * settles. They are not one endpoint because they are not one moment, and merging
 * them would force the cashier's scan to be the same thing as the payment.
 *
 * ## The retry is the load-bearing part
 *
 * A terminal that retries after a partial failure must **finish** crediting, not
 * merely decline to double-credit. So:
 *
 *   - `ON CONFLICT DO NOTHING` on `(business_id, payment_id)` makes the insert
 *     idempotent at the database, not at the application, so two concurrent
 *     retries of the same payment cannot both win.
 *   - When the insert inserted nothing, the existing row is read back, and
 *     `points IS NULL` is the observable signal that the sale is recorded and the
 *     credit is still owed. That row gets credited now.
 *   - A row that already carries points is left completely untouched and answered
 *     200.
 *
 * Without the third step the gap is a loss rather than a delay, and it would be a
 * loss the merchant cannot even see: the terminal's message was the only evidence
 * that an attribution had happened.
 *
 * ## Why a resolved customer is a 404 and not a skip
 *
 * There is nothing to record. The sale happened, but with no member there is no
 * identity to attribute it to, and inventing one — the nearest customer, or a
 * placeholder row — would put points on somebody's balance for a purchase they
 * did not make. The 404 tells the terminal that its attribution did not land,
 * which is the only useful thing it can do with the answer.
 *
 * ## Why the validation is narrow
 *
 * `amount_cents` must be a positive integer and nothing more. It is not checked
 * against the cart, because there is no cart here: the merchant's system owns the
 * product identity and we deliberately hold no catalogue to disagree with it.
 * `items` is stored as sent and never parsed into a total.
 */
router.post('/v1/checkins', async (c) => {
  const auth = extractAuthHeaders(c);
  const { businessId } = auth;
  const body = await c.req.json<{
    payment_id?: string;
    member_code?: unknown;
    amount_cents?: unknown;
    items?: unknown;
    note?: string;
  }>();

  if (typeof body.member_code !== 'string' || body.member_code.length === 0) {
    return c.json(
      {
        error: {
          code: INVALID_MEMBER_CODE,
          message: 'member_code is required and must be a non-empty string',
        },
      },
      400,
    );
  }

  // An integer, and positive. Not validated against anything else: the amount is
  // authoritative and there is no cart on our side to contradict it.
  if (typeof body.amount_cents !== 'number' || !Number.isInteger(body.amount_cents) || body.amount_cents < 1) {
    return c.json(
      {
        error: {
          code: INVALID_AMOUNT_CENTS,
          message: 'amount_cents is required and must be an integer greater than 0, in cents',
        },
      },
      400,
    );
  }

  // Optional, and only when it is a non-empty string. Absent is the manual path
  // and is a legitimate state — `payment_id` is NULL there and the unique index
  // does not collide, which is documented on the table rather than worked around.
  const paymentId =
    typeof body.payment_id === 'string' && body.payment_id.length > 0 ? body.payment_id : null;

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const customer = await resolveMemberCode(db, businessId, body.member_code);

  if (!customer) {
    // Nothing written. A sale with no member has no identity to attach to, and
    // guessing one would credit somebody else's balance.
    return c.json(
      {
        error: {
          code: MEMBER_CODE_NOT_FOUND,
          message: 'No active customer in this business has that member_code.',
        },
      },
      404,
    );
  }

  // -----------------------------------------------------------------------
  // The insert, idempotent at the database
  // -----------------------------------------------------------------------
  // `ON CONFLICT DO NOTHING` rather than a read-then-write: the check has to be
  // the unique index's, decided by Postgres in the same statement, or two
  // concurrent retries of one payment would both insert and the second would fail
  // as an unhandled error rather than answering 200.
  const [inserted] = await db
    .insert(checkins)
    .values({
      businessId,
      customerId: customer.id,
      // The scanned string, kept verbatim even though `customerId` is resolved
      // from it: it is the audit trail of what the terminal actually received, and
      // the only thing that can still answer that question once a code is
      // reassigned.
      memberCode: body.member_code,
      paymentId,
      amountCents: body.amount_cents,
      items: (body.items ?? null) as never,
      note: body.note ?? null,
      // Explicitly NULL: this is the "credit pending" signal a retry reads, and
      // `creditCheckin` is what fills it in.
      points: null,
    })
    .onConflictDoNothing({ target: [checkins.businessId, checkins.paymentId] })
    .returning();

  if (inserted) {
    const credited = await creditCheckin(db, c, {
      businessId,
      customer,
      checkinId: inserted.id,
      amountCents: body.amount_cents,
      paymentId,
      note: body.note ?? null,
    });

    // 201 rather than 200: this is the response that tells the terminal, without
    // a word of prose, that its message is the one that opened the record.
    return c.json({ data: { ...inserted, points: credited.points } }, 201);
  }

  // -----------------------------------------------------------------------
  // The insert lost. Read back the row that is already there.
  // -----------------------------------------------------------------------
  // Only reachable when `payment_id` is present — with a NULL it cannot collide,
  // and the row above always exists.
  const [existing] = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.businessId, businessId), eq(checkins.paymentId, paymentId!)))
    .limit(1);

  if (!existing) {
    // The insert conflicted and the row is somehow unreadable. Reported rather
    // than treated as success, because answering 200 here would tell the terminal
    // its sale is recorded when we cannot say that.
    return c.json(
      {
        error: {
          code: 'CONFLICT_WITHOUT_ROW',
          message: 'A checkin already exists for this payment_id but could not be read back.',
        },
      },
      500,
    );
  }

  if (existing.points !== null) {
    // Already credited. Untouched — not re-credited, not re-published, not
    // re-projected. A retry is a statement that we may have failed, not a request
    // to do the work twice.
    return c.json({ data: existing }, 200);
  }

  // The row is there and the credit never landed. That is the partial failure this
  // endpoint exists to finish, so finish it.
  const retried = await creditCheckin(db, c, {
    businessId,
    customer,
    checkinId: existing.id,
    amountCents: existing.amountCents,
    paymentId,
    // The note recorded the first time, not one invented now: a retry reports the
    // same sale, and the ledger row for it should carry what that sale said.
    note: existing.note ?? null,
  });

  return c.json({ data: { ...existing, points: retried.points } }, 200);
});

export default router;

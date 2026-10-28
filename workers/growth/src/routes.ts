import type { Queue } from '@cloudflare/workers-types';
import { createDb, loyaltyPrograms, membershipTiers, customers, rewards, rewardBranches, pointsTransactions, checkins, settledPayments, tenants, posTerminals, hashPassword, branches, customerEvents } from '@vyloop/db';
import { publish, createEnvelope, CUSTOMER_CHECKED_IN } from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { getRequestId } from '@vyloop/request-context';
import { eq, and, count, sql, or, isNull, lte, gte, gt, desc, inArray, notInArray } from 'drizzle-orm';
import { Hono } from 'hono';
// import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';

import type { Bindings } from './helpers';
import { extractAuthHeaders, buildPointsAssignedEvent, buildRewardRedeemedEvent, withRls, resolveEffectiveCustomer, isDeletedCustomer, isCustomerRole, requireOperatorRole, requireCounterSubject, schedulePassReconcile } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * The bindings this worker reads, including the payment rail's shared secret.
 *
 * `Bindings` comes from `helpers.ts`, which this change does not touch, so the
 * one binding it needs is declared here — next to the route that reads it, which
 * is also where the reader is looking when they ask what a binding is for.
 *
 * `PAYMENT_WEBHOOK_SECRET` is **not** declared in `wrangler.jsonc`, and there is
 * no widget, account or key behind it: Mercado Pago has not issued one, and no
 * credential exists anywhere in this repository for this endpoint to authenticate
 * against. That is the same state `RESEND_API_KEY` and `TURNSTILE_SECRET_KEY` are
 * in on the gateway, and it fails the same way — 503 with nothing recorded, which
 * is the only behaviour that makes the missing step visible. A plausible literal in
 * the config would satisfy every test and every deployment while refusing every
 * real delivery for a reason nobody could find, which is the `SCHEMA_REGISTRY` bug
 * at a different key.
 *
 * Declared optional and read as possibly-absent rather than required, so the type
 * cannot be satisfied by a config that has it and a runtime that does not.
 */
export interface PaymentWebhookEnv {
  PAYMENT_WEBHOOK_SECRET?: string | undefined;
}

/**
 * The queue the delivery events travel on.
 *
 * `vyloop-notification-deliveries` — the queue the communication worker
 * consumes, and the one a `CustomerCheckedIn` is published to. A customer
 * checked in at a venue is the fact a proximity campaign is built from, and
 * the campaign lives in the communication worker.
 *
 * It is declared here, beside the route that publishes to it, rather than in
 * `helpers.ts`, which this unit does not touch. The binding itself is the
 * parent's to add: `workers/growth/wrangler.jsonc` and the `Bindings` in
 * `helpers.ts` have to name it before a deployment has it.
 *
 * Declared optional, and read as possibly-absent, for the reason
 * `PAYMENT_WEBHOOK_SECRET` above is: the type must not be satisfiable by a
 * configuration that has the binding and a runtime that does not. A missing
 * binding is logged, and the sale is not failed over it.
 */
export interface DeliveryQueueEnv {
  DELIVERY_QUEUE?: Queue;
}

export type GrowthEnv = Bindings & PaymentWebhookEnv & DeliveryQueueEnv;

const router = new Hono<{ Bindings: GrowthEnv }>();

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
 * POS and the manual scanner. `POST /v1/loyalty/checkins` runs it for the merchant's own
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
  // Only purchase programs carry a sale amount; visits and adjustments have
  // none. Recorded so the profile timeline can show what was spent.
  let purchaseAmount: number | null = null;

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
    purchaseAmount = amount;
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

  // A deleted account keeps its row and its ledger, so the INSERT below would
  // still land on it. It is answered as not found, the way every read of a
  // deleted customer is: nobody owns that balance any more.
  if (customer?.deletedAt) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
  }

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
  // (`POST /v1/loyalty/checkins`, for a merchant's own terminal reporting a completed
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
    // `SELECT ... WHERE`, not `VALUES`: the deleted check above is a read, and a
    // delete committing after it would otherwise still be credited. The
    // sub-select locks the customer row `FOR SHARE`, so a concurrent
    // anonymisation either commits first (this re-reads `deleted_at` and
    // inserts nothing) or waits for this credit to commit. An unknown customer
    // reads as NULL and is let through to the foreign key, as before.
    const result = await db.execute(sql`
      INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note, purchase_amount)
      SELECT
        ${businessId}::uuid,
        ${body.customer_id}::uuid,
        'earn',
        ${effectivePoints}::integer,
        COALESCE(
          (SELECT balance_after FROM points_transactions WHERE customer_id = ${body.customer_id}::uuid ORDER BY created_at DESC LIMIT 1),
          0
        ) + ${effectivePoints}::integer,
        ${body.reference_id},
        ${body.note ?? null},
        ${purchaseAmount}
      WHERE (
        SELECT deleted_at IS NULL FROM customers
        WHERE id = ${body.customer_id}::uuid AND business_id = ${businessId}::uuid
        FOR SHARE
      ) IS DISTINCT FROM false
      RETURNING id, business_id, customer_id, type, points, balance_after, reference_id, note, purchase_amount, created_at
    `);

    const tx = result.rows?.[0];
    // The guarded INSERT selected nothing: the customer was deleted after the
    // read above. Same answer as a deleted customer found by that read.
    if (!tx && customer && !customer.deletedAt) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
    }
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
      getRequestId(c),
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
        purchase_amount: pointsTransactions.purchaseAmount,
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
 * Validate a `branch_ids` body field against the caller's own venues.
 *
 * Returns the de-duplicated ids, or a message for the 422. Every id must name a
 * branch of *this* business: a reward scoped to another tenant's venue would
 * either be invisible to that tenant or, worse, readable through a join. The
 * check runs before any write so a rejected request leaves nothing behind.
 *
 * An empty array is valid and means "no venue scope", which is the same thing
 * as omitting the field: the reward is available everywhere.
 */
async function resolveBranchScope(
  db: ReturnType<typeof createDb>,
  businessId: string,
  branchIds: unknown,
): Promise<{ ok: true; ids: string[] } | { ok: false; message: string }> {
  if (!Array.isArray(branchIds)) {
    return { ok: false, message: 'branch_ids must be an array of branch ids' };
  }
  if (branchIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    return { ok: false, message: 'branch_ids must contain non-empty branch ids' };
  }
  const ids = [...new Set(branchIds as string[])];
  if (ids.length === 0) return { ok: true, ids };

  const owned = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.businessId, businessId), inArray(branches.id, ids)));

  if (owned.length !== ids.length) {
    return { ok: false, message: 'branch_ids must name venues of this business' };
  }
  return { ok: true, ids };
}

/**
 * Replace a reward's venue scope with exactly `ids`.
 *
 * Insert first, delete second. The other order has a window where the reward
 * has no rows, and "no rows" means "available at every venue" — a failure
 * between the two statements would silently widen a scoped reward to the whole
 * business. This order can only ever leave a superset, which is still scoped.
 */
async function replaceBranchScope(
  db: ReturnType<typeof createDb>,
  businessId: string,
  rewardId: string,
  ids: string[],
): Promise<void> {
  if (ids.length > 0) {
    await db
      .insert(rewardBranches)
      .values(ids.map((branchId) => ({ rewardId, branchId, businessId })))
      .onConflictDoNothing();
    await db
      .delete(rewardBranches)
      .where(
        and(
          eq(rewardBranches.rewardId, rewardId),
          notInArray(rewardBranches.branchId, ids),
        ),
      );
    return;
  }
  await db.delete(rewardBranches).where(eq(rewardBranches.rewardId, rewardId));
}

/** The venue scope of many rewards, in one read rather than one per reward. */
async function branchScopeByReward(
  db: ReturnType<typeof createDb>,
  rewardIds: string[],
): Promise<Map<string, string[]>> {
  const scopes = new Map<string, string[]>();
  if (rewardIds.length === 0) return scopes;

  const rows = await db
    .select({ rewardId: rewardBranches.rewardId, branchId: rewardBranches.branchId })
    .from(rewardBranches)
    .where(inArray(rewardBranches.rewardId, rewardIds));

  for (const row of rows) {
    const list = scopes.get(row.rewardId) ?? [];
    list.push(row.branchId);
    scopes.set(row.rewardId, list);
  }
  return scopes;
}

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
    branch_ids?: string[];
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

  // Before the duplicate-name read: a request with a foreign venue is refused
  // without telling the caller which names are taken.
  let scope: string[] = [];
  if (body.branch_ids !== undefined) {
    const resolved = await resolveBranchScope(db, businessId, body.branch_ids);
    if (!resolved.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: resolved.message } }, 422);
    }
    scope = resolved.ids;
  }

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

  // The id is generated here rather than by the column default so the scope
  // rows can be written in the same request without a second round trip to read
  // the generated id back.
  const rewardId = crypto.randomUUID();

  const [inserted] = await db
    .insert(rewards)
    .values({
      id: rewardId,
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

  if (scope.length > 0) {
    try {
      await db
        .insert(rewardBranches)
        .values(scope.map((branchId) => ({ rewardId, branchId, businessId })));
    } catch (error) {
      // Without the scope the reward would read as "available everywhere",
      // which is a different promise to the one the caller asked for. Removing
      // the row is the only way back to "nothing was created".
      await db.delete(rewards).where(eq(rewards.id, rewardId));
      throw error;
    }
  }

  return c.json({ data: { ...inserted, branch_ids: scope } }, 201);
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

  // One read for the whole page. A query per reward would turn a 20-item page
  // into 21 round trips, which on a Worker is 21 chances to be slow.
  const scopes = await branchScopeByReward(
    db,
    items.map((item) => item.id),
  );

  return c.json({
    data: items.map((item) => ({ ...item, branch_ids: scopes.get(item.id) ?? [] })),
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

  const scopes = await branchScopeByReward(db, [reward.id]);

  return c.json({ data: { ...reward, branch_ids: scopes.get(reward.id) ?? [] } });
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
    branch_ids?: string[];
  }>();

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Validate before the reward is even looked up, so an unknown reward and a
  // foreign venue both come back as the same 422/404 pair the caller expects
  // and no write can happen after a rejected scope.
  let scope: string[] | undefined;
  if (body.branch_ids !== undefined) {
    const resolved = await resolveBranchScope(db, businessId, body.branch_ids);
    if (!resolved.ok) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: resolved.message } }, 422);
    }
    scope = resolved.ids;
  }

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

  // A request that only changes the venue scope is a valid update: it must not
  // be swallowed by the "nothing to update" shortcut.
  if (Object.keys(updateData).length === 0 && scope === undefined) {
    // Same shape as every other branch: the caller reads `branch_ids` off this
    // response, and a no-op must not be the one reply that lacks it.
    const scopes = await branchScopeByReward(db, [id]);
    return c.json({ data: { ...existing, branch_ids: scopes.get(id) ?? [] } });
  }

  if (scope !== undefined) {
    await replaceBranchScope(db, businessId, id, scope);
  }

  if (Object.keys(updateData).length === 0) {
    const scopes = await branchScopeByReward(db, [id]);
    return c.json({ data: { ...existing, branch_ids: scopes.get(id) ?? [] } });
  }

  updateData.updatedAt = new Date();

  const [updated] = await db
    .update(rewards)
    .set(updateData)
    .where(eq(rewards.id, id))
    .returning();

  const scopes = await branchScopeByReward(db, [id]);

  return c.json({ data: { ...updated, branch_ids: scopes.get(id) ?? [] } });
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

  // An operator names the customer by id and is honoured as sent, so a deleted
  // account — whose row and ledger stay — would otherwise still be spendable from
  // the POS. A customer token never reaches this: `resolveOwnCustomer` already
  // excludes a deleted row and answered 403 above.
  if (!isCustomerRole(auth) && (await isDeletedCustomer(db, businessId, customerId))) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } }, 404);
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
      getRequestId(c),
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
export const INVALID_BRANCH_ID = 'INVALID_BRANCH_ID';
export const BRANCH_NOT_FOUND = 'BRANCH_NOT_FOUND';

/**
 * The shape of a uuid.
 *
 * The same expression the schema registry validates a uuid with, copied
 * rather than shared: the registry is a different package with a different
 * dependency, and a validator that both sides can call is a dependency
 * neither of them can audit alone.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the venue a sale happened at.
 *
 * `null` means "the caller did not say", and that is a legitimate state: the
 * venue is optional, and a sale without one is still a sale. A malformed id
 * is a different thing — it is refused, because the column is a uuid and a
 * malformed one is a database error rather than an empty result.
 */
function parseBranchId(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return { ok: false };
  }

  return { ok: true, value };
}

/**
 * Build a `CustomerCheckedIn` event envelope.
 *
 * The payload carries the customer's **global** id — the convention every
 * customer event follows, and the id a delivery resolves — and the venue and
 * the check-in it happened in.
 */
function buildCustomerCheckedInEvent(
  customerGlobalId: string,
  businessId: string,
  branchId: string,
  checkinId: string,
): EventEnvelope {
  return createEnvelope(
    CUSTOMER_CHECKED_IN,
    { business_id: businessId, timestamp: new Date().toISOString() },
    {
      customer_id: customerGlobalId,
      business_id: businessId,
      branch_id: branchId,
      checkin_id: checkinId,
    },
  );
}

/**
 * Record that a customer was at a venue, and tell the world.
 *
 * Two writes, in this order, and both of them are the record rather than a
 * side effect of it:
 *
 *   1. A row in `customer_events`. This is the fact a proximity campaign's
 *      audience is built from — there is no other record of a customer having
 *      been at a place — so it is written whether or not anybody is listening
 *      on the queue today.
 *   2. The event on the delivery queue, which is what lets a consumer act on
 *      the interaction as it happens.
 *
 * A missing queue binding is logged rather than thrown. A sale that genuinely
 * happened must not fail because a binding is absent from a deployment: the
 * row is the record, and the event is the notification about it.
 */
async function recordVenueInteraction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  c: Context<{ Bindings: GrowthEnv }>,
  args: {
    businessId: string;
    customer: { id: string; globalId: string };
    branchId: string;
    checkinId: string;
  },
): Promise<void> {
  const { businessId, customer, branchId, checkinId } = args;

  await db.insert(customerEvents).values({
    businessId,
    // The internal id: `customer_events.customer_id` references `customers.id`.
    customerId: customer.id,
    eventType: 'customer.checked_in',
    branchId,
    payload: { checkin_id: checkinId },
  });

  const queue = c.env?.DELIVERY_QUEUE;

  if (!queue) {
    console.error(
      `[growth] No DELIVERY_QUEUE binding, so the check-in at branch ${branchId} in tenant ` +
        `${businessId} was recorded but not published. The customer_events row is the record.`,
    );
    return;
  }

  await publish(
    queue,
    buildCustomerCheckedInEvent(customer.globalId, businessId, branchId, checkinId),
  );
}

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
 *
 * `globalId` comes back for the same reason and for one more: it is the id
 * every customer event carries, and the interaction a sale at a venue records
 * is published with it.
 */
async function resolveMemberCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  memberCode: string,
): Promise<{ id: string; globalId: string; currentTierId: string | null } | undefined> {
  const [customer] = await db
    .select({
      id: customers.id,
      globalId: customers.globalId,
      currentTierId: customers.currentTierId,
    })
    .from(customers)
    .where(
      and(
        eq(customers.businessId, businessId),
        eq(customers.memberCode, memberCode),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  return customer as
    | { id: string; globalId: string; currentTierId: string | null }
    | undefined;
}

/**
 * POST /v1/loyalty/passes/resolve
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
router.post('/v1/loyalty/passes/resolve', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body, before the lookup, before anything is written. A counter is
  // the only subject whose scan we answer: a customer could otherwise learn
  // whether an arbitrary `member_code` is a member of this tenant, and a merchant
  // dashboard session could answer it on a tenant it merely administers.
  const gate = requireCounterSubject(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
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
        getRequestId(c),
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
 * POST /v1/loyalty/checkins
 *
 * Record a sale that has already been paid for, and credit what it earned.
 *
 * ## The shape of the flow, and why
 *
 * This is the second half of a two-endpoint contract, and it happens at a
 * different moment than `/v1/loyalty/passes/resolve`: that one answers "is this pass
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
router.post('/v1/loyalty/checkins', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body, before `createDb`, before `withRls`. Without this the route
  // had no guard at all: the public customer token could report a completed sale
  // for any `member_code` and have the tenant's earn rule turn `amount_cents` into
  // spendable points. An operator is refused here too — the manual path it would
  // want is `POST /v1/loyalty/points/assign`, which the dashboard already calls.
  const gate = requireCounterSubject(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const body = await c.req.json<{
    payment_id?: string;
    member_code?: unknown;
    amount_cents?: unknown;
    items?: unknown;
    note?: string;
    branch_id?: unknown;
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

  // The venue the sale happened at, when the caller says so.
  //
  // Optional: a sale without a venue is a sale, and the route accepts it
  // exactly as it accepted one before the column existed. A malformed id is
  // refused rather than carried into the query, because the column is a uuid
  // and a malformed one is a database error rather than an empty result.
  const branchId = parseBranchId(body.branch_id);

  if (!branchId.ok) {
    return c.json(
      {
        error: {
          code: INVALID_BRANCH_ID,
          message: 'branch_id must be a uuid when it is present',
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

  // The venue has to belong to this tenant. The answer for a venue of another
  // business is the same as the answer for a venue that does not exist: a 403
  // would say "it exists, and it is not yours", and the existence of another
  // tenant's venue is not this caller's to learn.
  let branch: { id: string } | undefined;

  if (branchId.value !== null) {
    const [found] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, branchId.value), eq(branches.businessId, businessId)))
      .limit(1);

    if (!found) {
      return c.json(
        {
          error: {
            code: BRANCH_NOT_FOUND,
            message: 'No branch with that id belongs to this business.',
          },
        },
        404,
      );
    }

    branch = found;
  }

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
      // The venue the sale happened at, when the caller said so. NULL when it
      // did not: the column is nullable, and a sale without a venue is a sale.
      branchId: branch?.id ?? null,
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
    // -----------------------------------------------------------------------
    // The interaction with the venue
    // -----------------------------------------------------------------------
    // A sale **at a venue** is an interaction with that venue, and it is the
    // only record there is of a customer having been somewhere. Without it,
    // "the customers who were at this venue" cannot be answered at all, and a
    // campaign aimed at a venue has nobody to reach.
    //
    // It is written in the same request as the check-in, and only on the path
    // where the check-in was actually recorded: a retry of a payment that is
    // already on file did not happen a second time, and counting it again
    // would inflate the interaction.
    //
    // A sale with no venue writes no interaction and publishes nothing: there
    // was no interaction with a place.
    if (branch) {
      await recordVenueInteraction(db, c, {
        businessId,
        customer,
        branchId: branch.id,
        checkinId: inserted.id,
      });
    }

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

// ============================================================================
// The terminal's own credential
// ============================================================================

/**
 * Bytes of entropy in a terminal secret. 32.
 *
 * `crypto.getRandomValues` rather than `crypto.randomUUID()` for three reasons,
 * in order of how much each one costs if it is wrong:
 *
 *   1. **128 bits is what a UUID carries.** `randomUUID()` is a CSPRNG draw of
 *      exactly that width, so a UUID secret is four times smaller than the 512
 *      bits below. Nothing here needs the UUID's shape — the terminal's identity
 *      is the row's `id`, which the database generates.
 *   2. **UUIDs are visible everywhere else in this data model.** `pos_terminals.id`
 *      is a uuid, every `users.id` and `customers.id` is a uuid, and the token's
 *      subject carries one. A credential that is spelled like every other
 *      identifier in the system invites the reader to treat it as one: to log it
 *      at a lower level, to paste it into an id field, to accept it somewhere a
 *      secret is not meant to travel.
 *   3. **A UUID's shape is legible.** Four hyphen-separated groups of fixed width
 *      is enough to tell a real one from a guess, which is exactly the
 *      distinction a credential must not make easy.
 *
 * 32 bytes hex-encoded is 64 hex characters, so the secret is a 68-character
 * string including its prefix. That is far past anything a human types or a
 * dictionary enumerates, and it is the same class of value the token exchange's
 * PBKDF2 protects — which is the point: the exchange is *always* a 100k-iteration
 * hash, so a weak secret buys an attacker nothing by skipping it, and a strong
 * one is what makes that cost tolerable for a terminal booting on flaky wifi.
 *
 * The prefix is `vylt_`, chosen over the `vyl_` of the unwired
 * `workers/identity/src/api-keys.ts` so that a secret pasted from one of the two
 * systems into the other is refused rather than silently becoming a credential.
 * That dead module is a separate, SHA-256, prefix-rotated design; `pos_terminals`
 * is PBKDF2 and not prefix-rotated, and the two never met.
 */
const TERMINAL_SECRET_BYTES = 32;
const TERMINAL_SECRET_PREFIX = 'vylt_';

/**
 * Mint a terminal's plaintext secret.
 *
 * Never logged, never stored, never returned by any route other than the one
 * that mints it. `hashPassword`'s own docblock forbids logging its return
 * value, and the rule is the same for this: a secret in a log line is a secret in
 * a log aggregator, in a support ticket, and in whatever backup that line is in.
 */
function generateTerminalSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TERMINAL_SECRET_BYTES));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${TERMINAL_SECRET_PREFIX}${hex}`;
}

/**
 * The columns a terminal's row is ever read back as, in the shape the API
 * speaks.
 *
 * One projection for the three routes, and `key_hash` is **not in it**. That is
 * the whole reason this type exists rather than three `select()` calls: the hash
 * is the one field that must never reach a response, and a list written as
 * `select()` plus a hand-picked copy is one edit away from shipping it. The
 * listing names its columns at the query; the create and revoke responses map
 * this shape.
 */
function terminalResponse(row: {
  id: string;
  name: string;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    // Echoed under the name the exchange route takes, so a client can feed this
    // response straight into `POST /v1/auth/pos/token` without renaming anything.
    terminal_id: row.id,
    name: row.name,
    last_seen_at: row.lastSeenAt,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
  };
}

/**
 * POST /v1/loyalty/terminals
 *
 * Register a merchant's payment terminal and mint its credential.
 *
 * ## Guard: `requireOperatorRole`, and why a till may not do this
 *
 * Registering hardware is an operator action, which is what that guard is for.
 * It refuses both a customer **and** a counter subject with the same code and
 * the same message, and that second half is the part worth stating: without it a
 * till could register another till. A counter holds one scoped credential, and
 * what it may do with it is `passes/resolve` and `checkins` — reporting a sale
 * that happened. Minting a *new* credential is not that, it is fleet
 * administration, and a token that authenticates a single till should not be
 * able to grow the fleet. The guard already denies counters everywhere else it
 * matters (`points/assign`), so this is the same question asked in the third
 * place it applied.
 *
 * ## The secret is returned exactly once, because that is the only time it exists
 *
 * `pos_terminals.key_hash` is `hashPassword`'s `saltHex:hashHex` — PBKDF2, the
 * same scheme and the same storage format as `users.password_hash`, because
 * `POST /v1/auth/pos/token` verifies against it with `verifyPassword` and a
 * plain SHA-256 would be incompatible with a route that is already deployed.
 * The plaintext is therefore not recoverable by anyone, including us: there is no
 * endpoint that reads it, and there must never be one.
 *
 * That is the whole reason the response carries it and no other does. If it were
 * lost, the terminal is re-registered and the old row revoked — which is what
 * revoke exists for.
 */
router.post('/v1/loyalty/terminals', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the body, before `createDb`, before the secret exists. A guard that
  // ran after the hash would have spent 100k PBKDF2 iterations on a request it
  // was going to refuse.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  // From the credential's scope, never from the body. There is no `business_id`
  // field on this route and adding one would let a caller choose its own tenant.
  const { businessId } = auth;
  const body = await c.req.json<{ name?: unknown }>();

  // Trimmed and then length-checked, so `"   "` is refused the same way a missing
  // name is. A blank name is not a cosmetic problem: it is the only human label a
  // merchant has for the till they are about to revoke.
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name is required and must be a non-empty string' } },
      400,
    );
  }

  const secret = generateTerminalSecret();
  // Hashed before the insert and never written anywhere else. The `saltHex:hashHex`
  // string is deliberately not logged, per `hashPassword`'s own docblock.
  const keyHash = await hashPassword(secret);

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // Named columns in the RETURNING clause as well as in the response: the row that
  // comes back from the database should not even hold the hash for the mapping
  // below to have to remember to skip.
  const [inserted] = await db
    .insert(posTerminals)
    .values({ businessId, name, keyHash })
    .returning({
      id: posTerminals.id,
      name: posTerminals.name,
      lastSeenAt: posTerminals.lastSeenAt,
      revokedAt: posTerminals.revokedAt,
      createdAt: posTerminals.createdAt,
    });

  return c.json(
    {
      data: {
        ...terminalResponse(inserted),
        business_id: businessId,
        // The one and only time this value exists outside the merchant.
        secret,
        // Said in the response rather than only in this docblock, because the one
        // person who needs to know is whoever is reading the 201 in the dashboard:
        // copy it now, or revoke this row and register a new terminal.
        secret_shown_once: true,
      },
    },
    201,
  );
});

/**
 * GET /v1/loyalty/terminals
 *
 * List this business's terminals.
 *
 * **No `key_hash`, and no way to ask for one.** The columns are named at the
 * query, so the hash never leaves Postgres for this route — a `select()` with the
 * fields picked afterwards would work until the first careless edit, and the
 * whole defence is that there is nothing to leak rather than a filter that could
 * be forgotten.
 *
 * `business_id` is the credential's scope, so this lists one merchant's till and
 * never another's, and `created_at` descending because the newest till is the one
 * an operator is looking for.
 */
router.get('/v1/loyalty/terminals', async (c) => {
  const auth = extractAuthHeaders(c);
  // Not an open read like `GET /v1/loyalty/tiers`: this is a credential inventory,
  // not merchandising. A customer has no business seeing which hardware a tenant
  // runs, and a counter has no business seeing it either.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  const items = await db
    .select({
      id: posTerminals.id,
      name: posTerminals.name,
      lastSeenAt: posTerminals.lastSeenAt,
      revokedAt: posTerminals.revokedAt,
      createdAt: posTerminals.createdAt,
    })
    .from(posTerminals)
    .where(eq(posTerminals.businessId, businessId))
    .orderBy(desc(posTerminals.createdAt));

  return c.json({ data: items.map(terminalResponse) });
});

/**
 * POST /v1/loyalty/terminals/:id/revoke
 *
 * Kill a terminal's credential.
 *
 * ## Soft, on purpose
 *
 * `revoked_at` is set; the row is never deleted. Two reasons, and the second is
 * the one that makes the column worth having:
 *
 *   1. `checkins.payment_id` reconciliation resolves against a terminal's
 *      identity, and a hard delete would take that with it — a revoked till
 *      would become a till whose past sales cannot be attributed.
 *   2. An operator has to be able to see that a till existed and was killed,
 *      rather than infer from its absence that it never did. That is the
 *      difference between "we turned this one off on Tuesday" and "we have never
 *      heard of it".
 *
 * The effect is immediate and needs no other step: `POST /v1/auth/pos/token`
 * checks `revoked_at` on **every** exchange, so the next renewal fails, and any
 * token already issued keeps working for at most its one-hour life — which is the
 * same bound every other credential here has.
 *
 * Revoking an already-revoked terminal is accepted and simply re-stamps the
 * column. It is not a conflict: there is no state to protect here, and a 409
 * would only teach operators to route around it.
 */
router.post('/v1/loyalty/terminals/:id/revoke', async (c) => {
  const auth = extractAuthHeaders(c);
  // Before the id is read, for the reason every other `requireOperatorRole` route
  // does it: a 403 that could be told apart from the 404 below is an existence
  // oracle for the tenant's hardware list.
  const gate = requireOperatorRole(auth);
  if (!gate.ok) {
    return c.json({ error: { code: gate.code, message: gate.message } }, gate.status);
  }
  const { businessId } = auth;
  const id = c.req.param('id');

  const db = createDb(c.env.DATABASE_URL);
  await withRls(db, businessId);

  // **404, and not a refusal** — the same answer `PUT /v1/loyalty/tiers/:id` and
  // `PUT /v1/loyalty/rewards/:id` give, and for the same reason. `POST
  // /v1/auth/pos/token` collapses three failures into one 401 because it is
  // *public*: an attacker there is probing ids from outside the system entirely,
  // and the id space is not theirs to enumerate. This route is not public, and
  // its caller is already an operator of one tenant — so the risk being managed
  // is not "can a stranger learn that id exists" but "can one merchant learn that
  // another merchant has a till with that id", which the tenant predicate answers
  // completely: a row that is not this business's never matches, so the 404 is
  // byte-for-byte what an id nobody has produces. A 403 here would add a second
  // answer to say *more* about a row we deliberately cannot see.
  const [updated] = await db
    .update(posTerminals)
    .set({ revokedAt: new Date() })
    .where(and(eq(posTerminals.id, id), eq(posTerminals.businessId, businessId)))
    .returning({
      id: posTerminals.id,
      name: posTerminals.name,
      lastSeenAt: posTerminals.lastSeenAt,
      revokedAt: posTerminals.revokedAt,
      createdAt: posTerminals.createdAt,
    });

  if (!updated) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Terminal not found' } },
      404,
    );
  }

  return c.json({ data: { ...terminalResponse(updated), business_id: businessId } });
});

// ============================================================================
// The payment rail's webhook
// ============================================================================

/**
 * Where a payment rail delivers a settlement notification.
 *
 * Declared here, where the route is registered, and re-exported by `index.ts`
 * because `index.ts` is the file that has to exempt it from auth — the same
 * arrangement `workers/wallet` uses for `WALLET_CALLBACK_PATH`, and for the same
 * reason: a public exemption that does not name the route it exempts it for is a
 * hole, and a hole with a stale name does not fail loudly.
 *
 * The gateway declares the same string independently, because `apps/gateway` must
 * not take a runtime dependency on the service behind it.
 * `apps/gateway/src/worker-public-path-auth.contract.test.ts` asserts the two
 * copies agree **and** that the worker exempts the path, because "the gateway
 * thinks it is public" and "the worker lets it through" are two separate facts
 * and only the pair of them is a reachable route.
 */
export const PAYMENT_WEBHOOK_PATH = '/v1/loyalty/webhooks/payments';

/** The header the rail is assumed to carry its signature in. */
export const PAYMENT_WEBHOOK_SIGNATURE_HEADER = 'X-Vyloop-Signature';

/** Stable, specific codes. Callers branch on these rather than parsing prose. */
export const PAYMENT_WEBHOOK_SIGNATURE_REQUIRED = 'PAYMENT_WEBHOOK_SIGNATURE_REQUIRED';
export const PAYMENT_WEBHOOK_SIGNATURE_INVALID = 'PAYMENT_WEBHOOK_SIGNATURE_INVALID';
export const PAYMENT_WEBHOOK_SECRET_UNAVAILABLE = 'PAYMENT_WEBHOOK_SECRET_UNAVAILABLE';
export const PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED = 'PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED';
export const PAYMENT_WEBHOOK_UNKNOWN_MERCHANT = 'PAYMENT_WEBHOOK_UNKNOWN_MERCHANT';
export const PAYMENT_WEBHOOK_INVALID_PAYLOAD = 'PAYMENT_WEBHOOK_INVALID_PAYLOAD';

/**
 * The exact byte string that gets signed.
 *
 * ## THE ASSUMPTION, STATED PLAINLY
 *
 * **This scheme is UNCONFIRMED against Mercado Pago's documentation.** It could
 * not be verified during the session that wrote it. What follows is a common and
 * defensible shape — a separator-delimited timestamp and the raw body, HMAC'd with
 * a shared secret — but it is *an* HMAC scheme, not *the* HMAC scheme, and it must
 * be checked against the rail's real documentation before this endpoint is pointed
 * at anything real. Pointing it at a live rail with this scheme produces a receiver
 * that refuses every delivery with `PAYMENT_WEBHOOK_SIGNATURE_INVALID`, which is
 * the correct failure mode (it fails closed) but reads exactly like a misconfigured
 * secret.
 *
 * This function exists so that being wrong is one edit and one test rather than a
 * change to the verification path. It is asserted directly, by name, in
 * `index.test.ts` — so the assumption is a **failing test** if it ever has to change,
 * not a silent divergence between what is signed and what a rail signs.
 *
 * ## What is deliberately not in the message
 *
 * The path. The timestamp, then a `.`, then the raw body. Some schemes prefix the
 * path or the request id to bind a signature to one endpoint; if this rail's does,
 * that is a different function body and the same one place to change it.
 *
 * A timestamp belongs in the message so a captured delivery can be replayed at
 * most until the rail rotates the secret — but **this route does not check the
 * timestamp**. A signature being fresh is not the property that makes a replay
 * safe here, and it is a separate decision with a separate failure mode (clock
 * skew drops real deliveries). `settled_payments.payment_id` is the primary key,
 * so a replay is idempotent at the database anyway: it re-records nothing.
 */
export function paymentWebhookSignedMessage(body: string, timestamp: string): string {
  return `${timestamp}.${body}`;
}

/**
 * Verify a delivery's HMAC-SHA256 signature.
 *
 * ## Never throws, and never falls back to accepting
 *
 * Every failure is a named code. There is no "verify failed, carry on" path and
 * no unsigned branch: a receiver that accepts when it cannot check is not a
 * receiver, it is a public write endpoint with a logging step. So the three
 * refusals are kept **distinct from each other**, because they are three
 * different operational problems — an operator has not configured the secret, a
 * client is not signing, a client is signing with the wrong key — and collapsing
 * them into one code would make the first two indistinguishable from an attack.
 *
 * ## Constant time, and why it is not `===`
 *
 * The digest is verified with `crypto.subtle.verify`, which is the primitive
 * designed for this: it compares the MAC internally without a timing signal that
 * depends on how many leading bytes matched. `hexA === hexB` on two digests is
 * not equivalent — an early-exit string comparison leaks, byte by byte, how much
 * of a forgery was correct, and a signature check is exactly where an attacker
 * benefits from that oracle. `index.test.ts` asserts this function does not
 * compare digests with `===`.
 *
 * Note this is *not* the wallet's verification: `workers/wallet/src/callbacks.ts`
 * uses `crypto.subtle.verify` against Google's **asymmetric** ECv2 keys, and a
 * public-key primitive cannot be reused for a shared secret. See
 * `callback-handler.ts:14` for that flow, whose order — verify, resolve tenant,
 * claim nonce — this mirrors.
 */
export type PaymentWebhookVerification =
  | { ok: true }
  | { ok: false; status: 401 | 503; code: string; message: string };

export async function verifyPaymentWebhookSignature(input: {
  body: string;
  /** Lowercased header name, as Hono's `header()` takes it. */
  signatureHeader: string;
  /** Lowercased header name for the timestamp that is part of the signed message. */
  timestampHeader: string;
  /** Raw header values, or `undefined` when the header was absent. */
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string | undefined;
}): Promise<PaymentWebhookVerification> {
  const { body, signature, timestamp, secret } = input;

  // Fails closed on an unconfigured secret, and *first*: a receiver with no secret
  // must refuse rather than treat every delivery as unverified-but-harmless. This
  // is the state the route is in today in every environment, and it is reported
  // rather than worked around — an absent secret is a missing deployment step, and
  // `src/support.ts` answers 503 for its keys in exactly the same shape.
  if (secret === undefined || secret === '') {
    return {
      ok: false,
      status: 503,
      code: PAYMENT_WEBHOOK_SECRET_UNAVAILABLE,
      message:
        'The payment webhook secret is not configured, so no delivery can be authenticated. Nothing was recorded.',
    };
  }

  // Never accept an unsigned payload. A missing signature is refused with its own
  // code rather than as "invalid": it is the signature of an integration that was
  // never pointed at this endpoint correctly, and it wants a different fix from a
  // forgery.
  if (signature === undefined || signature === '') {
    return {
      ok: false,
      status: 401,
      code: PAYMENT_WEBHOOK_SIGNATURE_REQUIRED,
      message: `This endpoint accepts deliveries from the payment rail only, and a delivery must carry its ${input.signatureHeader} signature.`,
    };
  }

  if (timestamp === undefined || timestamp === '') {
    return {
      ok: false,
      status: 401,
      code: PAYMENT_WEBHOOK_SIGNATURE_REQUIRED,
      message: `A delivery must carry the ${input.timestampHeader} timestamp its signature was computed over.`,
    };
  }

  const presented = decodeHex(signature);
  if (presented === undefined) {
    return {
      ok: false,
      status: 401,
      code: PAYMENT_WEBHOOK_SIGNATURE_INVALID,
      message: 'The signature is not a hex-encoded HMAC-SHA256 digest.',
    };
  }

  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // The comparison itself. Everything above is a shape check; this is the one that
  // decides, and it is the one that has to be constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    presented,
    utf8(paymentWebhookSignedMessage(body, timestamp)),
  );

  if (!valid) {
    return {
      ok: false,
      status: 401,
      code: PAYMENT_WEBHOOK_SIGNATURE_INVALID,
      message: 'The signature does not match this delivery. Nothing was recorded.',
    };
  }

  return { ok: true };
}

/**
 * A byte array backed by a plain `ArrayBuffer`.
 *
 * Not a stylistic annotation, and copied from `workers/wallet/src/callbacks.ts` for
 * the reason recorded there: since TypeScript 5.7 `Uint8Array` is generic over its
 * buffer, and WebCrypto's `BufferSource` accepts only the `ArrayBuffer` variant — so
 * a `Uint8Array<ArrayBufferLike>` is rejected at `verify` even though it is
 * byte-for-byte correct. Pinning the helper keeps the error at the helper rather
 * than at each call site.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** UTF-8 bytes of the signed message. */
function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/**
 * Hex to bytes, or `undefined` for anything that is not hex.
 *
 * A hand-rolled parser rather than `Buffer.from(sig, 'hex')` because `Buffer`
 * silently truncates at the first invalid character — `'ab!!'` decodes to one byte
 * instead of failing, which would compare a truncated MAC against a real digest and
 * report `false` for a *length* reason while looking like a signature mismatch.
 *
 * Nor `Buffer`: this runs on Workers, and a verification routine should not depend
 * on `nodejs_compat` being enabled in order to be correct.
 */
function decodeHex(value: string): Bytes | undefined {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return undefined;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Resolve the payload's merchant reference to a tenant.
 *
 * ## Why the tenant is resolved and never read from the body
 *
 * Every other route in this worker takes `business_id` from the credential and
 * never from the request — that is the tenant-isolation boundary, stated the same
 * way in `callback-handler.ts` and in `requireOperatorRole`. This route has no
 * credential to inherit it from, so the boundary has to be a *lookup*: the body
 * names a merchant reference, and `tenants.slug` is the only column that can turn
 * that name into an id. A body field called `business_id` would be the caller
 * choosing its own scope, and this endpoint is public by construction.
 *
 * Matching on `slug` rather than `name` because `slug` carries a unique index and
 * `name` does not. A reference that resolves to two tenants must not pick one.
 *
 * An unknown reference is a 404 rather than a refusal, and the distinction from the
 * codes above is deliberate: the signature has already been verified by the time
 * this runs, so the caller holds the shared secret and is not an unauthenticated
 * prober — there is no existence oracle to withhold here, and an operator who has
 * misconfigured the rail needs "no merchant has that reference", not a generic
 * refusal they cannot act on.
 */
async function resolveMerchantReference(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  reference: string,
): Promise<{ id: string; name: string } | undefined> {
  const [tenant] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, reference))
    .limit(1);

  return tenant as { id: string; name: string } | undefined;
}

/**
 * POST /v1/loyalty/webhooks/payments
 *
 * Record that a payment settled. Nothing else.
 *
 * ## What this endpoint can find out, and what it can never do
 *
 * It **does not credit points, does not create a checkin, and does not resolve a
 * customer.** Those are the three things it must not do, and each is refused by
 * construction rather than by a check: there is no `member_code` on this payload,
 * `creditCheckin` is not imported by this handler, and the only table it writes is
 * `settled_payments`. A terminal reports money and the tenant's earn rule decides
 * what that is worth — a payment rail knows neither the pass that was scanned nor
 * the rule that would price it.
 *
 * ## THE LIMITATION, STATED WHERE AN OPERATOR WILL READ IT
 *
 * **A payment webhook detects a lost attribution; it cannot repair one.**
 *
 * The webhook carries the payment and the amount. It does **not** carry the fact
 * that a loyalty pass was scanned — only the terminal knows that. So when
 * `scripts/check-payment-reconciliation.mjs` finds a settled payment with no
 * checkin, it knows **that** an attribution was lost, not **whose**. Repair
 * requires the terminal to resend `POST /v1/loyalty/checkins`, or a human to ask
 * the cashier. There is no repair button here, and building one would mean
 * guessing a customer from a payment, which would put points on somebody's balance
 * for a purchase they may not have made.
 *
 * This sentence is here, in the endpoint's own documentation, because the endpoint
 * is where somebody arrives intending to build that button.
 *
 * ## Why it is public, and what replaces the JWT
 *
 * A payment rail is a third party with no Vyloop account and no business id to
 * send. What authenticates the delivery is the signature above — checked before
 * this handler parses anything, and before any database is opened. `EXACT_PUBLIC_
 * PATHS` in `apps/gateway/src/index.ts` and `PUBLIC_PATHS` in this worker's
 * `index.ts` are both required for this route to be reachable, and
 * `worker-public-path-auth.contract.test.ts` fails if either is missing.
 *
 * ## Why a Vyloop credential is refused here, with this route's own code
 *
 * `PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED`, not the middleware's generic
 * `UNAUTHORIZED`. That is the whole reason this check is a few lines of header
 * reading instead of `extractAuthHeaders`: `UNAUTHORIZED` is what a *missing
 * gateway header* answers, so a customer or a counter who got it would have no way
 * to tell that the route was never theirs, and the obvious next move would be to
 * start sending a JWT. The code has to say what is true — this route is for the
 * payment rail, and a Vyloop credential does not belong on it.
 *
 * Both header families are checked: the gateway-injected `X-*` identity (a direct
 * call at this worker, or a gateway that injects anyway) and `Authorization` (what
 * a credential holder actually holds). The same refusal for either, so the
 * response cannot be used to enumerate which kind of subject was sent.
 */
router.post(PAYMENT_WEBHOOK_PATH, async (c) => {
  // Before the body, before `createDb`, and before the signature check: a caller
  // who brought a credential to a route that has no use for one is told so without
  // this route doing any work on their behalf.
  const presentedIdentity =
    c.req.header('X-User-Id') ?? c.req.header('X-Business-Id') ?? c.req.header('X-User-Role');
  if (presentedIdentity !== undefined || c.req.header('Authorization') !== undefined) {
    return c.json(
      {
        error: {
          code: PAYMENT_WEBHOOK_CREDENTIAL_NOT_ALLOWED,
          message:
            "This endpoint is for the merchant's payment rail, which authenticates with a webhook signature and not a Vyloop credential. Reporting a sale is POST /v1/loyalty/checkins.",
        },
      },
      403,
    );
  }

  // The raw body, read once and used for both the signature and the parse. A
  // re-serialised body would not be the bytes that were signed, which is the
  // failure mode a JSON-parse-then-verify receiver always has.
  const raw = await c.req.text();

  const verified = await verifyPaymentWebhookSignature({
    body: raw,
    signatureHeader: PAYMENT_WEBHOOK_SIGNATURE_HEADER,
    timestampHeader: 'X-Vyloop-Timestamp',
    signature: c.req.header(PAYMENT_WEBHOOK_SIGNATURE_HEADER.toLowerCase()),
    timestamp: c.req.header('X-Vyloop-Timestamp'),
    secret: c.env.PAYMENT_WEBHOOK_SECRET,
  });

  if (!verified.ok) {
    return c.json({ error: { code: verified.code, message: verified.message } }, verified.status);
  }

  let body: {
    merchant_reference?: unknown;
    payment_id?: unknown;
    amount_cents?: unknown;
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json(
      {
        error: {
          code: PAYMENT_WEBHOOK_INVALID_PAYLOAD,
          message: 'The body is not valid JSON.',
        },
      },
      400,
    );
  }

  if (
    typeof body.merchant_reference !== 'string' ||
    body.merchant_reference.length === 0 ||
    typeof body.payment_id !== 'string' ||
    body.payment_id.length === 0 ||
    typeof body.amount_cents !== 'number' ||
    !Number.isInteger(body.amount_cents) ||
    body.amount_cents < 1
  ) {
    // One code for every malformed shape, because the caller is a payment rail and
    // not a person reading a message: it retries or it does not, and the branch
    // that matters is signed-versus-not.
    return c.json(
      {
        error: {
          code: PAYMENT_WEBHOOK_INVALID_PAYLOAD,
          message:
            'merchant_reference (non-empty string), payment_id (non-empty string) and amount_cents (integer greater than 0) are required.',
        },
      },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL);

  // Read before the tenant-scoped session is armed, because `tenants` is the root
  // table and has no `business_id` to scope against. This is the only read that
  // happens outside the tenant's scope, and it is a lookup of the reference the
  // signature already authenticated.
  const tenant = await resolveMerchantReference(db, body.merchant_reference);

  if (!tenant) {
    return c.json(
      {
        error: {
          code: PAYMENT_WEBHOOK_UNKNOWN_MERCHANT,
          message: 'No merchant has that reference. Nothing was recorded.',
        },
      },
      404,
    );
  }

  await withRls(db, tenant.id);

  // Idempotent at the database, decided by the primary key in the same statement
  // — the same arrangement as `POST /v1/loyalty/checkins`, and for the same
  // reason: a rail retries with backoff, and a read-then-write would let two
  // concurrent retries of one settlement both proceed.
  const [recorded] = await db
    .insert(settledPayments)
    .values({
      paymentId: body.payment_id,
      businessId: tenant.id,
      amountCents: body.amount_cents,
    })
    .onConflictDoNothing({ target: settledPayments.paymentId })
    .returning();

  // Snake_case on the way out, because this is a wire contract for a third party
  // and every other route on this worker answers with the database's own column
  // names. Drizzle's `.returning()` keys the row by the *camelCase property* names,
  // so a bare `data: row` would make this the only endpoint on the platform that
  // renames its columns in the response -- and the caller would have to know which
  // endpoint it is talking to.
  const asWire = (row: typeof recorded) =>
    row === undefined
      ? undefined
      : {
          payment_id: row.paymentId,
          business_id: row.businessId,
          amount_cents: row.amountCents,
          received_at: row.receivedAt,
        };

  // 200 rather than 201 on a duplicate, and the body is the row we already have.
  // A retry must be able to tell "recorded" from "I am recorded", and must not
  // have to distinguish them.
  if (!recorded) {
    const [existing] = await db
      .select()
      .from(settledPayments)
      .where(eq(settledPayments.paymentId, body.payment_id))
      .limit(1);

    if (!existing) {
      // The insert conflicted and the row is unreadable. Reported rather than
      // claimed as success: a 200 here would tell the rail a settlement is recorded
      // when we cannot say that.
      return c.json(
        {
          error: {
            code: 'CONFLICT_WITHOUT_ROW',
            message: 'A settled payment already exists for this payment_id but could not be read back.',
          },
        },
        500,
      );
    }

    return c.json({ data: asWire(existing) }, 200);
  }

  return c.json({ data: asWire(recorded) }, 201);
});

export default router;

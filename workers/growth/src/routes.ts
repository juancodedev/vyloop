import { createDb, loyaltyPrograms, membershipTiers, customers, rewards } from '@vyloop/db';
import { publish } from '@vyloop/event-bus';
import { eq, and, count, sql, or, isNull, lte, gte, gt, desc } from 'drizzle-orm';
import { Hono } from 'hono';
// import { HTTPException } from 'hono/http-exception';

import type { Bindings } from './helpers';
import { extractAuthHeaders, buildPointsAssignedEvent, buildRewardRedeemedEvent, withRls } from './helpers';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = new Hono<{ Bindings: Bindings }>();

// ============================================================================
// Loyalty Program Config
// ============================================================================

/**
 * GET /v1/loyalty/config
 *
 * Read the loyalty program configuration for the current business.
 * Returns the program record or a default skeleton if none exists.
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
        program_name: 'Programa de beneficios',
        is_active: true,
      },
    });
  }

  return c.json({
    data: {
      earn_rate: program.earnRate,
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
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{
    earn_rate?: string | number;
    program_name?: string;
  }>();

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
    if (body.program_name !== undefined) updateData.name = body.program_name;

    const [updated] = await db
      .update(loyaltyPrograms)
      .set(updateData)
      .where(eq(loyaltyPrograms.id, existing.id))
      .returning();

    return c.json({ data: { earn_rate: updated.earnRate, program_name: updated.name } });
  }

  // Insert new program config
  const [inserted] = await db
    .insert(loyaltyPrograms)
    .values({
      businessId,
      name: body.program_name ?? 'Programa de beneficios',
      earnRate: body.earn_rate !== undefined ? String(body.earn_rate) : '1.0',
    })
    .returning();

  return c.json(
    { data: { earn_rate: inserted.earnRate, program_name: inserted.name } },
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
 * POST /v1/loyalty/tiers
 *
 * Create a new membership tier.
 */
router.post('/v1/loyalty/tiers', async (c) => {
  const { businessId } = extractAuthHeaders(c);
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
 */
router.put('/v1/loyalty/tiers/:id', async (c) => {
  const { businessId } = extractAuthHeaders(c);
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
  const { businessId } = extractAuthHeaders(c);
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
 * Atomic: balance_after = previous balance + (points × earn_rate × tier_multiplier)
 * Dedup: referenceId unique per customer → 409
 * After success, publishes a PointsAssigned event.
 */
router.post('/v1/loyalty/points/assign', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{
    customer_id: string;
    points: number;
    branch_id?: string;
    note?: string;
    reference_id: string;
  }>();

  if (!body.customer_id || !body.points || !body.reference_id) {
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

  // -----------------------------------------------------------------------
  // Resolve earn rate from loyalty program config
  // -----------------------------------------------------------------------
  const [program] = await db
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.businessId, businessId))
    .limit(1);

  const earnRate = Number(program?.earnRate ?? '1.0');

  // -----------------------------------------------------------------------
  // Resolve tier multiplier from customer's current tier
  // -----------------------------------------------------------------------
  let tierMultiplier = 1.0;

  // Get the customer's current tier (if any)
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.globalId, body.customer_id)))
    .limit(1);

  if (customer?.currentTierId) {
    const [tier] = await db
      .select()
      .from(membershipTiers)
      .where(eq(membershipTiers.id, customer.currentTierId))
      .limit(1);

    if (tier) {
      tierMultiplier = Number(tier.multiplier);
    }
  }

  const effectivePoints = Math.floor(body.points * earnRate * tierMultiplier);

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
// Rewards Catalog CRUD
// ============================================================================

/**
 * POST /v1/loyalty/rewards
 *
 * Create a new reward in the catalog.
 * Name must be unique per business.
 */
router.post('/v1/loyalty/rewards', async (c) => {
  const { businessId } = extractAuthHeaders(c);
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
  const { businessId } = extractAuthHeaders(c);
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
  const { businessId } = extractAuthHeaders(c);
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
 */
router.post('/v1/loyalty/rewards/redeem', async (c) => {
  const { businessId } = extractAuthHeaders(c);
  const body = await c.req.json<{
    customer_id: string;
    points: number;
    reward_id?: string;
    reward_name?: string;
    partial?: boolean;
    reference_id: string;
  }>();

  if (!body.customer_id || !body.points || !body.reference_id) {
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
      (SELECT balance_after FROM points_transactions WHERE customer_id = ${body.customer_id}::uuid ORDER BY created_at DESC LIMIT 1),
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
              ${body.customer_id}::uuid,
              'redeem',
              ${redeemPoints}::integer,
              COALESCE(
                (SELECT balance_after FROM points_transactions WHERE customer_id = ${body.customer_id}::uuid ORDER BY created_at DESC LIMIT 1),
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
          ${body.customer_id}::uuid,
          'redeem',
          ${redeemPoints}::integer,
          COALESCE(
            (SELECT balance_after FROM points_transactions WHERE customer_id = ${body.customer_id}::uuid ORDER BY created_at DESC LIMIT 1),
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
      body.customer_id,
      businessId,
      redeemPoints,
      balanceAfter,
      body.reference_id,
      isPartial,
      resolvedRewardName,
      resolvedRewardId,
    );

    await publish(c.env.DOMAIN_EVENTS_QUEUE, event);

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

export default router;

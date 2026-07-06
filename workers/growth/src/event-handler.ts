import type { Message } from '@cloudflare/workers-types';
import { createDb, customers, membershipTiers, loyaltyPrograms, rewards, rewardGrants } from '@vyloop/db';
import type { EventEnvelope } from '@vyloop/event-bus';
import { publish } from '@vyloop/event-bus';
import { eq, and, lte, desc, sql, isNotNull } from 'drizzle-orm';

import type { Bindings } from './helpers';
import { withRls, buildRewardAutoGrantedEvent } from './helpers';

// ---------------------------------------------------------------------------
// Queue consumer dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle a single domain event from the queue.
 *
 * Called by the `consume()` wrapper from @vyloop/event-bus, which handles
 * ack/retry semantics. Events not matching a known type are logged and
 * acked to avoid blocking the queue.
 */
export async function handleEvent(
  event: EventEnvelope,
  message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  switch (event.type) {
    case 'CustomerRegistered':
      return handleCustomerRegistered(event, message, env);
    case 'PointsAssigned':
      return handlePointsAssigned(event, message, env);
    default:
      console.warn(`[growth] Unknown event type: ${event.type} — acking and skipping`);
      return;
  }
}

// ---------------------------------------------------------------------------
// CustomerRegistered handler
// ---------------------------------------------------------------------------

/**
 * Handle a CustomerRegistered event.
 *
 * 1. Resolve the customer's internal `id` from their `global_id`
 * 2. Find the lowest tier (min_points = 0) for this business
 * 3. If no tier exists, create a Bronze tier (min_points = 0, multiplier = 1.0)
 * 4. Insert a wallet initialization row (points_transactions) with 0 balance
 * 5. Assign the lowest tier as `currentTierId` on the customer record
 *
 * Idempotency: the (customer_id, reference_id) unique constraint on
 * points_transactions prevents double-wallet creation. Duplicate events
 * are silently treated as no-ops, and the tier assignment is re-applied
 * safely.
 */
async function handleCustomerRegistered(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    full_name: string;
    business_id: string;
  };
  const businessId = event.header.business_id;
  const customerGlobalId = payload.customer_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // -----------------------------------------------------------------------
  // Resolve the customer's internal id from global_id
  // -----------------------------------------------------------------------
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(eq(customers.businessId, businessId), eq(customers.globalId, customerGlobalId)),
    )
    .limit(1);

  if (!customer) {
    console.warn(
      `[growth] Customer with global_id ${customerGlobalId} not found in business ${businessId} — skipping CustomerRegistered`,
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Find the lowest tier (min_points = 0) for this business
  // -----------------------------------------------------------------------
  const [lowestTier] = await db
    .select()
    .from(membershipTiers)
    .where(
      and(eq(membershipTiers.businessId, businessId), eq(membershipTiers.minPoints, 0)),
    )
    .orderBy(membershipTiers.displayOrder)
    .limit(1);

  let tierId: string;

  if (!lowestTier) {
    // -------------------------------------------------------------------
    // No tier exists — create a Bronze tier
    // -------------------------------------------------------------------
    const [program] = await db
      .select({ id: loyaltyPrograms.id })
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.businessId, businessId))
      .limit(1);

    if (!program) {
      console.warn(
        `[growth] No loyalty program found for business ${businessId} — cannot create tier for CustomerRegistered`,
      );
      return;
    }

    const [createdTier] = await db
      .insert(membershipTiers)
      .values({
        businessId,
        programId: program.id,
        name: 'Bronze',
        minPoints: 0,
        multiplier: '1.0',
        benefits: [],
        displayOrder: 0,
      })
      .returning();

    tierId = createdTier.id;
    console.log(`[growth] Created Bronze tier for business ${businessId}`);
  } else {
    tierId = lowestTier.id;
  }

  // -----------------------------------------------------------------------
  // Upsert wallet with 0 balance (idempotent via unique constraint)
  // -----------------------------------------------------------------------
  try {
    await db.execute(sql`
      INSERT INTO points_transactions (business_id, customer_id, type, points, balance_after, reference_id, note)
      VALUES (
        ${businessId}::uuid,
        ${customer.id}::uuid,
        'earn',
        0,
        0,
        'wallet-init',
        'Wallet initialization via CustomerRegistered'
      )
      RETURNING id
    `);

    console.log(`[growth] Wallet initialized for customer ${customer.id}`);
  } catch (err: unknown) {
    const error = err as { message?: string; code?: string };
    // Idempotency: duplicate (customer_id, reference_id) → second event is a no-op
    if (error.message?.includes('uq_points_tx_reference') || error.code === '23505') {
      console.log(`[growth] Customer ${customer.id} already has wallet — continuing`);
    } else {
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Assign lowest tier as currentTierId (idempotent; safe to re-apply)
  // -----------------------------------------------------------------------
  await db
    .update(customers)
    .set({ currentTierId: tierId })
    .where(eq(customers.id, customer.id));

  console.log(`[growth] Customer ${customer.id} assigned to tier ${tierId}`);
}

// ---------------------------------------------------------------------------
// PointsAssigned handler
// ---------------------------------------------------------------------------

/**
 * Handle a PointsAssigned event.
 *
 * 1. Re-read the customer's total wallet balance from points_transactions
 * 2. Find the highest tier where min_points ≤ balance
 * 3. If currentTierId has changed (only upgrade, never downgrade), update it
 *
 * The orderBy min_points DESC ensures we pick the tier with the highest
 * requirement that the customer still meets.
 *
 * No-downgrade guarantee: if the computed tier has a lower or equal min_points
 * requirement than the customer's current tier, the update is skipped.
 */
async function handlePointsAssigned(
  event: EventEnvelope,
  _message: Message<EventEnvelope>,
  env: Bindings,
): Promise<void> {
  const payload = event.payload as {
    customer_id: string;
    points_assigned: number;
    points_multiplier: number;
    total_points: number;
    reference_id: string;
    assignment_id: string;
  };
  const businessId = event.header.business_id;
  const customerId = payload.customer_id;

  const db = createDb(env.DATABASE_URL);
  await withRls(db, businessId);

  // -----------------------------------------------------------------------
  // Re-read the customer's current balance
  // -----------------------------------------------------------------------
  const balanceResult = await db.execute(sql`
    SELECT COALESCE(
      (SELECT balance_after FROM points_transactions WHERE customer_id = ${customerId}::uuid ORDER BY created_at DESC LIMIT 1),
      0
    ) AS balance
  `);

  const currentBalance = Number(balanceResult.rows?.[0]?.balance ?? 0);

  // -----------------------------------------------------------------------
  // Get the customer record to find current tier
  // -----------------------------------------------------------------------
  const [customer] = await db
    .select({ id: customers.id, currentTierId: customers.currentTierId })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customerId)))
    .limit(1);

  if (!customer) {
    console.warn(
      `[growth] Customer ${customerId} not found in business ${businessId} — skipping PointsAssigned`,
    );
    return;
  }

  // -----------------------------------------------------------------------
  // Find the highest tier whose min_points ≤ balance
  // -----------------------------------------------------------------------
  const [highestTier] = await db
    .select()
    .from(membershipTiers)
    .where(
      and(
        eq(membershipTiers.businessId, businessId),
        lte(membershipTiers.minPoints, currentBalance),
      ),
    )
    .orderBy(desc(membershipTiers.minPoints))
    .limit(1);

  // -----------------------------------------------------------------------
  // Evaluate tier upgrade (only upgrade, never downgrade)
  // -----------------------------------------------------------------------
  if (highestTier && customer.currentTierId !== highestTier.id) {
    let isUpgrade = true;

    if (customer.currentTierId) {
      const [currentTier] = await db
        .select({ minPoints: membershipTiers.minPoints })
        .from(membershipTiers)
        .where(eq(membershipTiers.id, customer.currentTierId))
        .limit(1);

      // Downgrade guard: skip if the new tier's requirement is lower or equal
      if (currentTier && highestTier.minPoints <= currentTier.minPoints) {
        isUpgrade = false;
        console.log(
          `[growth] Customer ${customerId} tier unchanged — ${highestTier.name} is not an upgrade from current tier`,
        );
      }
    }

    if (isUpgrade) {
      await db
        .update(customers)
        .set({ currentTierId: highestTier.id })
        .where(eq(customers.id, customer.id));

      console.log(
        `[growth] Customer ${customerId} upgraded to tier ${highestTier.name} (minPoints: ${highestTier.minPoints}, balance: ${currentBalance})`,
      );
    }
  } else if (!highestTier) {
    console.log(
      `[growth] Customer ${customerId} — no eligible tier found (balance: ${currentBalance})`,
    );
  }

  // -----------------------------------------------------------------------
  // Auto-reward hook: check threshold-based rewards after points update
  // -----------------------------------------------------------------------
  if (currentBalance > 0) {
    const autoRewards = await db
      .select()
      .from(rewards)
      .where(
        and(
          eq(rewards.businessId, businessId),
          isNotNull(rewards.autoGrantThreshold),
          lte(rewards.autoGrantThreshold, currentBalance),
        ),
      );

    for (const reward of autoRewards) {
      // Check idempotency: skip if already granted to this customer
      const [existingGrant] = await db
        .select({ id: rewardGrants.id })
        .from(rewardGrants)
        .where(
          and(
            eq(rewardGrants.customerId, customer.id),
            eq(rewardGrants.rewardId, reward.id),
          ),
        )
        .limit(1);

      if (existingGrant) {
        console.log(
          `[growth] Auto-reward ${reward.name} already granted to customer ${customer.id} — skipping`,
        );
        continue;
      }

      // Insert grant record
      await db
        .insert(rewardGrants)
        .values({
          businessId,
          customerId: customer.id,
          rewardId: reward.id,
          balanceAfter: currentBalance,
        })
        .returning();

      console.log(
        `[growth] Auto-reward "${reward.name}" granted to customer ${customer.id} (threshold: ${reward.autoGrantThreshold}, balance: ${currentBalance})`,
      );

      // Publish RewardAutoGranted event
      const event = buildRewardAutoGrantedEvent(
        customer.id,
        businessId,
        reward.id,
        reward.name,
        currentBalance,
      );

      await publish(env.DOMAIN_EVENTS_QUEUE, event);
    }
  }
}

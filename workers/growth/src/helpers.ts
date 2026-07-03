import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId } from '@vyloop/db';
import {
  POINTS_ASSIGNED,
  REWARD_REDEEMED,
  createEnvelope,
} from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthHeaders {
  userId: string;
  businessId: string;
  userRole: string;
}

export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;
  SCHEMA_REGISTRY: KVNamespace;
}

export type AppEnv = { Bindings: Bindings; Variables: { auth: AuthHeaders } };

// ---------------------------------------------------------------------------
// Auth header extraction
// ---------------------------------------------------------------------------

/**
 * Extract X-User-Id, X-Business-Id, X-User-Role from request headers.
 * Throws 403 if any header is missing.
 *
 * These headers are injected by the gateway auth-inject middleware after
 * JWT validation.
 */
export function extractAuthHeaders(c: Context): AuthHeaders {
  const userId = c.req.header('X-User-Id');
  const businessId = c.req.header('X-Business-Id');
  const userRole = c.req.header('X-User-Role');

  if (!userId || !businessId || !userRole) {
    throw new HTTPException(403, { message: 'Missing authentication headers' });
  }

  return { userId, businessId, userRole };
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * Build a PointsAssigned event envelope for the domain events queue.
 *
 * The payload follows the PointsAssigned schema registered in the
 * schema registry.
 */
export function buildPointsAssignedEvent(
  customerId: string,
  businessId: string,
  points: number,
  pointsMultiplier: number,
  balanceAfter: number,
  referenceId: string,
): EventEnvelope {
  const payload = {
    customer_id: customerId,
    points_assigned: points,
    points_multiplier: pointsMultiplier,
    total_points: balanceAfter,
    reference_id: referenceId,
    assignment_id: crypto.randomUUID(),
  };

  return createEnvelope(
    POINTS_ASSIGNED,
    { business_id: businessId, timestamp: new Date().toISOString() },
    payload,
  );
}

/**
 * Build a RewardRedeemed event envelope for the domain events queue.
 *
 * The payload follows the RewardRedeemed schema registered in the
 * schema registry.
 */
export function buildRewardRedeemedEvent(
  customerId: string,
  businessId: string,
  pointsRedeemed: number,
  totalPointsAfter: number,
  referenceId: string,
  partial: boolean,
  rewardName?: string,
): EventEnvelope {
  const payload: Record<string, unknown> = {
    customer_id: customerId,
    points_redeemed: pointsRedeemed,
    total_points_after: totalPointsAfter,
    reference_id: referenceId,
    partial,
    redemption_id: crypto.randomUUID(),
  };

  if (rewardName !== undefined) {
    payload.reward_name = rewardName;
  }

  return createEnvelope(
    REWARD_REDEEMED,
    { business_id: businessId, timestamp: new Date().toISOString() },
    payload,
  );
}

// ---------------------------------------------------------------------------
// RLS helper
// ---------------------------------------------------------------------------

/**
 * Set the `app.current_business_id` session variable for RLS isolation.
 *
 * Call this at the start of every request that touches tenant-scoped tables.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withRls(db: any, businessId: string): Promise<void> {
  await db.execute(setCurrentBusinessId(businessId));
}

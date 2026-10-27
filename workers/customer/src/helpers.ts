import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId } from '@vyloop/db';
import { CUSTOMER_REGISTERED, createEnvelope } from '@vyloop/event-bus';
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
 * JWT validation. The customer worker also strips them from the raw request
 * as defense-in-depth before they reach route handlers.
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
// Operator guard
// ---------------------------------------------------------------------------

const CUSTOMER_ROLE = 'customer';

/** Stable, specific code. Callers branch on this rather than parsing prose. */
export const OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED';

export type OperatorRoleGuard =
  | { ok: true }
  | { ok: false; status: 403; code: string; message: string };

/**
 * Refuse the customer app's token on a route that serves the merchant's staff.
 *
 * ## Why this is a deny-list and not an allow-list
 *
 * It denies exactly one role, `customer`, and lets everything else through. That
 * looks permissive and is deliberate: `users.role` defaults to `'cashier'`
 * (`packages/db/src/schema.ts`), and the cashier is the person this endpoint
 * exists for. An allow-list would have to enumerate every staff role the product
 * will ever grow, and the day it missed one the POS would break for the staff
 * member standing in front of the customer rather than fail closed somewhere
 * harmless.
 *
 * The same guard in `workers/wallet/src/helpers.ts` protects Google's program
 * record. It is duplicated rather than imported because two workers sharing a
 * helper is how one of them ends up changing behaviour the other depends on.
 *
 * What this does *not* claim to be: an authorization decision. It answers "is
 * this the customer app or staff?", and the answer to "which staff?" is the
 * dashboard's problem, not this worker's. The surface is deliberately small —
 * one customer at a time, never a list — which is what makes the permissive
 * role acceptable here.
 */
export function requireOperatorRole(auth: AuthHeaders): OperatorRoleGuard {
  if (auth.userRole === CUSTOMER_ROLE) {
    return {
      ok: false,
      status: 403,
      code: OPERATOR_ROLE_REQUIRED,
      message:
        'This endpoint is for the business staff at the counter. Your own profile is at GET /v1/customers/me.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * Build a CustomerRegistered event envelope for the domain events queue.
 *
 * The payload follows the CustomerRegistered schema registered in the
 * schema registry: { customer_id, full_name, business_id }.
 */
export function buildCustomerRegisteredEvent(
  customer: { globalId: string; fullName: string | null },
  businessId: string,
  requestId?: string,
) {
  const payload = {
    customer_id: customer.globalId,
    full_name: customer.fullName ?? '',
    business_id: businessId,
  };

  return createEnvelope(
    CUSTOMER_REGISTERED,
    { business_id: businessId, timestamp: new Date().toISOString(), ...(requestId ? { request_id: requestId } : {}) },
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
 * With the Neon HTTP driver this sends a `SET LOCAL` statement to the
 * database — effective for the current transaction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function withRls(db: any, businessId: string): Promise<void> {
  await db.execute(setCurrentBusinessId(businessId));
}

// ---------------------------------------------------------------------------
// Reward progress
// ---------------------------------------------------------------------------

export interface ActiveReward {
  id: string;
  name: string;
  pointsCost: number;
}

export interface RewardStep extends ActiveReward {
  pointsMissing: number;
}

export interface RewardProgress {
  nextReward: RewardStep | null;
  affordableReward: RewardStep | null;
  affordableRewardsCount: number;
  activeRewardsCount: number;
}

/**
 * The customer's position against the tenant's active rewards.
 *
 * Owned by the server, next to `nextTier`, so the client only renders: the
 * next reward is the cheapest one the balance does not reach yet, the
 * affordable reward is the cheapest one it does, and ties go to the name.
 * `rewards` must already be the tenant's ACTIVE rewards; activeness is a SQL
 * filter in the route, not something this function can see.
 */
export function deriveRewardProgress(rewards: ActiveReward[], balance: number): RewardProgress {
  const ordered = [...rewards].sort(
    (a, b) => a.pointsCost - b.pointsCost || a.name.localeCompare(b.name),
  );
  const affordable = ordered.filter((r) => r.pointsCost <= balance);
  const next = ordered.find((r) => r.pointsCost > balance);
  const cheapestAffordable = affordable[0];

  return {
    nextReward: next ? { ...next, pointsMissing: next.pointsCost - balance } : null,
    affordableReward: cheapestAffordable ? { ...cheapestAffordable, pointsMissing: 0 } : null,
    affordableRewardsCount: affordable.length,
    activeRewardsCount: ordered.length,
  };
}

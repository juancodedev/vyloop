import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId, customers } from '@vyloop/db';
import {
  POINTS_ASSIGNED,
  REWARD_REDEEMED,
  REWARD_AUTO_GRANTED,
  createEnvelope,
} from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import { and, eq, isNull } from 'drizzle-orm';
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
// Customer ownership
// ---------------------------------------------------------------------------

/**
 * The role the customer app's token carries. Scopes `rewards:read` /
 * `rewards:redeem` to the holder's own loyalty record.
 */
const CUSTOMER_ROLE = 'customer';

/** Stable, specific code. Callers can branch on this without parsing prose. */
export const CUSTOMER_ID_MISMATCH = 'CUSTOMER_ID_MISMATCH';
export const CUSTOMER_SELF_NOT_FOUND = 'CUSTOMER_SELF_NOT_FOUND';

/**
 * Is this the customer app's own token?
 *
 * The single owner of that question. A route deciding it any other way is how
 * the read and redeem paths end up disagreeing about whose data they are
 * allowed to touch.
 */
export function isCustomerRole(auth: AuthHeaders): boolean {
  return auth.userRole === CUSTOMER_ROLE;
}

/** Stable, specific code. Callers can branch on this without parsing prose. */
export const OPERATOR_ROLE_REQUIRED = 'OPERATOR_ROLE_REQUIRED';

export type OperatorRoleGuard = { ok: true } | { ok: false; status: 403; code: string; message: string };

/**
 * Refuse the customer app's token on a route that configures the loyalty
 * program rather than spending the customer's own points.
 *
 * Rewriting the program, the tier ladder, the earn rate or the reward catalog
 * is a merchant decision, and the customer app has no surface for making one.
 * What made that an authorization defect rather than a missing feature is
 * `POST /v1/loyalty/points/assign`: `points` is validated only as `>= 1`, so a
 * customer could mint an arbitrary balance and then spend it through the one
 * route that is legitimately theirs. Every operator-only write is refused here
 * rather than only the one that was exploited, so the next route added does not
 * have to remember.
 *
 * Deliberately the *same* answer whatever the request would otherwise have
 * done. The guard reads nothing, so it cannot tell an absent program from a
 * present one, a missing tier from an existing one, or a taken reward name from
 * a free one — there is no existence oracle to probe the tenant with, and
 * nothing is written on the way out.
 *
 * The counterpart to `isCustomerRole`, not a second source of truth about the
 * role: it denies by asking that question rather than by re-reading
 * `X-User-Role` or holding a list of operator roles. `issueToken` types `role`
 * as a free-form string, so an allow-list would have to invent a vocabulary the
 * issuer does not define and would refuse every role added after this was
 * written.
 */
export function requireOperatorRole(auth: AuthHeaders): OperatorRoleGuard {
  if (isCustomerRole(auth)) {
    return {
      ok: false,
      status: 403,
      code: OPERATOR_ROLE_REQUIRED,
      message:
        'This endpoint configures the loyalty program for the business. Redeeming your own rewards is done through POST /v1/loyalty/rewards/redeem.',
    };
  }

  return { ok: true };
}

export type EffectiveCustomer =
  /**
   * `undefined` only for an operator who named no customer: on the read path
   * that still means "the whole tenant", exactly as before. A customer can
   * never reach that state — for that role the id is always resolved first.
   */
  | { ok: true; customerId: string | undefined }
  | { ok: false; status: 403; code: string; message: string };

/**
 * Resolve the token subject to the tenant's own customer row.
 *
 * `X-User-Id` is the JWT subject, which is the customer's `globalId` — not the
 * `customers.id` primary key that `points_transactions.customer_id` holds. The
 * join has to happen somewhere, and doing it here is what lets the two loyalty
 * routes stop trusting a client-supplied id.
 *
 * Both halves of the key are mandatory. `businessId` is not decoration: the
 * same person is a row per merchant, so a lookup on `globalId` alone is a
 * cross-tenant lookup that happens to be one of many equally valid answers.
 * `deletedAt` is excluded for the same reason `GET /v1/customers/me` excludes
 * it — a withdrawn membership must not keep transacting.
 */
export async function resolveOwnCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  businessId: string,
  globalId: string,
): Promise<{ id: string } | undefined> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.globalId, globalId),
        eq(customers.businessId, businessId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);

  return customer as { id: string } | undefined;
}

/**
 * Decide which customer a loyalty request is allowed to act on.
 *
 * Both `GET /v1/loyalty/points/transactions` and `POST
 * /v1/loyalty/rewards/redeem` take a `customer_id` from the client, and
 * `X-Business-Id` alone only says which tenant — never which customer inside
 * it. Honouring the supplied id unchecked therefore let any customer read the
 * tenant's whole movement history (by omitting it) or spend another
 * customer's balance (by naming them). Both routes resolve through this one
 * function so they cannot drift apart again.
 *
 * Operator and admin are unchanged: they may name any customer, and the read
 * route still falls back to the tenant-wide listing when they name none. The
 * dashboard POS depends on that — it redeems on behalf of a scanned customer.
 *
 * For a customer the token is the only authority. An id that disagrees is a
 * 403 rather than a silent rewrite to the caller's own: a mismatch is the
 * signal that the client is reading a stale id, and coercing it would spend
 * the caller's points to hide a bug the caller needs to see. The supplied id
 * is never looked up, so the 403 cannot be told apart from one for an id that
 * does not exist — no existence oracle, and nothing of another tenant's is
 * read to produce the answer.
 */
export async function resolveEffectiveCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  auth: AuthHeaders,
  requestedCustomerId?: string,
): Promise<EffectiveCustomer> {
  if (!isCustomerRole(auth)) {
    return { ok: true, customerId: requestedCustomerId };
  }

  const own = await resolveOwnCustomer(db, auth.businessId, auth.userId);

  if (!own) {
    return {
      ok: false,
      status: 403,
      code: CUSTOMER_SELF_NOT_FOUND,
      message:
        'This account has no customer record in this business, so it cannot read or spend loyalty points here.',
    };
  }

  if (requestedCustomerId !== undefined && requestedCustomerId !== own.id) {
    return {
      ok: false,
      status: 403,
      code: CUSTOMER_ID_MISMATCH,
      message:
        'customer_id must identify the authenticated customer. Omit it to act on your own record.',
    };
  }

  return { ok: true, customerId: own.id };
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
  rewardId?: string,
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
  if (rewardId !== undefined) {
    payload.reward_id = rewardId;
  }

  return createEnvelope(
    REWARD_REDEEMED,
    { business_id: businessId, timestamp: new Date().toISOString() },
    payload,
  );
}

/**
 * Build a RewardAutoGranted event envelope for the domain events queue.
 *
 * The payload follows the RewardAutoGranted schema registered in the
 * schema registry.
 */
export function buildRewardAutoGrantedEvent(
  customerId: string,
  businessId: string,
  rewardId: string,
  rewardName: string,
  balanceAfter: number,
): EventEnvelope {
  const payload = {
    customer_id: customerId,
    reward_id: rewardId,
    reward_name: rewardName,
    granted_at: new Date().toISOString(),
    balance_after: balanceAfter,
  };

  return createEnvelope(
    REWARD_AUTO_GRANTED,
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

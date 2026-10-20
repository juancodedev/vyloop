import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import { setCurrentBusinessId, customers } from '@vyloop/db';
import {
  POINTS_ASSIGNED,
  REWARD_REDEEMED,
  REWARD_AUTO_GRANTED,
  createEnvelope,
} from '@vyloop/event-bus';
import type { EventEnvelope } from '@vyloop/event-bus';
import {
  OPERATOR_ROLE_REQUIRED,
  isCustomerRole as isCustomerRoleValue,
  isCounterSubject as isCounterSubjectValue,
  requireOperatorRole as requireOperatorRoleShared,
  type OperatorRoleGuard,
} from '@vyloop/types';
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

/**
 * The wallet worker's RPC surface, as this worker calls it.
 *
 * A plain `Fetcher` models only `fetch` and `connect`, so the target's exported
 * `reconcileCustomer` — the entire point of this binding — needs its own shape.
 * This is the same declaration `workers/automation` makes for the wallet's
 * `scheduled`, for the same reason: rename or re-sign that export over there and
 * this stops typechecking, so the contract is pinned from both sides instead of
 * from whichever one was written last.
 *
 * The outcome is `unknown` on purpose. This worker does not read it: the
 * projection is fire-and-forget, because a sale must not wait on Google, and the
 * daily sweep is the backstop for whatever the outcome turns out to have been.
 * Copying `reconcilePass`'s eight-way outcome union across a worker boundary it
 * is not allowed to branch on would be a second definition of a decision it does
 * not make, drifting for ever from the one that does.
 */
export interface WalletWorker {
  reconcileCustomer(input: { tenantId: string; customerId: string }): Promise<unknown>;
}

export interface Bindings {
  DATABASE_URL: string;
  DOMAIN_EVENTS_QUEUE: Queue;
  SCHEMA_REGISTRY: KVNamespace;
  /**
   * The wallet worker, so a ledger write can ask for the balance projection
   * instead of waiting for the customer to reopen the app.
   *
   * A service binding rather than a `fetch`, for the reason
   * `workers/automation` gives for the same binding: the wallet's exported
   * method runs with the *wallet's* bindings and its Google credentials. A fetch
   * would have to forward them by hand and would put the issuer's signing key
   * on a path that takes customer input.
   */
  WALLET: WalletWorker;
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
 *
 * The value itself now lives in `@vyloop/types`, because `workers/identity`
 * answers the same question about the same three kinds of subject for the
 * routes that manage a business's branches. The reason it lives there is the
 * reason `CUSTOMER_PATCHABLE_FIELDS` lives there: two workers have to agree on
 * it for a decision to mean anything, and a predicate copied beside its twin
 * is a predicate that will drift.
 */

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
  return isCustomerRoleValue(auth.userRole);
}

/** Stable, specific code. Callers can branch on this without parsing prose. */
export { OPERATOR_ROLE_REQUIRED };

export type { OperatorRoleGuard };

/**
 * Refuse the customer app's token, and a counter's, on a route that configures
 * the loyalty program rather than spending the customer's own points.
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
 * ## The counter, which was the second way in
 *
 * The guard denied one kind of subject and there were two. `POST
 * /v1/auth/pos/token` is public and mints `sub: 'pos:<terminalId>'`, and a till
 * authenticates once per boot, so such a token is a credential that exists in the
 * wild rather than a hypothetical: it passed here, and a terminal could send
 * `points` to `POST /v1/loyalty/points/assign` and credit an arbitrary balance
 * outright — bypassing the earn rule that `POST /v1/loyalty/checkins` exists to
 * apply. A terminal reports that a sale happened and sends `amount_cents`; what
 * that is worth is the tenant's decision, never the till's.
 *
 * Denied through the existing `isCounterSubject`, on the same grounds it was
 * written: the subject namespace is the only structurally distinct thing here,
 * `role` is free-form text the issuer never enumerates, and a second predicate
 * written beside it would be a second definition of what a counter is — which is
 * how the two halves of this file would come to disagree.
 *
 * Deliberately the *same* answer whatever the request would otherwise have
 * done, and for a counter the same answer as for a customer: one status, one
 * code, one message, not a code per subject kind. Distinct codes would turn the
 * refusal into an inventory of which kinds of subject exist and which do not,
 * which is the one thing a guard on an unrecognised credential must not be. The
 * guard reads nothing, so it cannot tell an absent program from a present one, a
 * missing tier from an existing one, or a taken reward name from a free one —
 * there is no existence oracle to probe the tenant with, and nothing is written
 * on the way out.
 *
 * The counterpart to `isCustomerRole` and `isCounterSubject`, not a second source
 * of truth about either: it denies by asking those two questions rather than by
 * re-reading `X-User-Role` or holding a list of operator roles. Two questions is
 * still not an allow-list. `issueToken` types `role` as a free-form string, so an
 * allow-list would have to invent a vocabulary the issuer does not define and
 * would refuse every role added after this was written — and the pair of
 * questions cannot drift when a role is renamed, which is what the list was for.
 * The honest cost of the pair is that it fails *open* on a fourth kind of subject
 * nobody has thought to ask about, where a list fails closed. That is paid here
 * deliberately: a new kind of subject needs its question added, and the counter is
 * what that cost bought.
 */
export function requireOperatorRole(auth: AuthHeaders): OperatorRoleGuard {
  return requireOperatorRoleShared(auth, OPERATOR_ROLE_REQUIRED_MESSAGE);
}

/**
 * The message a refused operator route answers with.
 *
 * A parameter of the shared guard rather than a fact of it: the growth routes
 * that call it are about the loyalty program, and the identity routes that call
 * it are about a business's branches. What they share is the *decision*, and
 * what must not be shared is prose that names the wrong thing.
 */
const OPERATOR_ROLE_REQUIRED_MESSAGE =
  'This endpoint configures the loyalty program for the business. Redeeming your own rewards is done through POST /v1/loyalty/rewards/redeem.';

/**
 * The namespace a counter's token subject lives in: `pos:<terminalId>`.
 *
 * `issueToken` (`workers/identity/src/auth.ts`) types `sub` as a free-form string
 * and every subject it is asked for today is a uuid — `customers.global_id` for
 * the customer app, `users.id` for staff — so `pos:` is unreachable by accident
 * and cannot collide with one of those. A uuid cannot begin with it at all.
 *
 * ## Why this prefix and not a bare `pos`
 *
 * A bare prefix is what makes an authorization marker forgeable by accident.
 * `pos` alone would be matched by `postmaster-3`, `pos-7` and `POS-2`; a
 * `startsWith('pos')` guard would therefore hand a counter subject to any issuer
 * that happened to pick a word beginning with those three letters. The colon is
 * the separator that makes the namespace unambiguous: it cannot appear in a uuid,
 * and it is not a character any of those look-alikes contain. Case-sensitive on
 * top of that, so `POS:` is not a counter.
 *
 * The value now lives in `@vyloop/types`, for the reason given at
 * `CUSTOMER_ROLE` above: `workers/identity` refuses counter tokens on the
 * routes that manage a business's branches, and it has to refuse exactly the
 * ones this file refuses.
 */

export type CounterSubjectGuard =
  { ok: true } | { ok: false; status: 403; code: string; message: string };

/** Stable, specific code. Callers can branch on this without parsing prose. */
export const COUNTER_SUBJECT_REQUIRED = 'COUNTER_SUBJECT_REQUIRED';

/**
 * Is this token a counter at the till?
 *
 * A counter is a *third* kind of subject, so this is not `!isCustomerRole` and not
 * its mirror image. It asks one question about the subject and refuses everything
 * else, which is the same shape `isCustomerRole` gives `requireOperatorRole`: a
 * check phrased as one question cannot drift when the issuer adds a role, and
 * cannot go stale when a role is renamed.
 *
 * ## Why the subject and not the role
 *
 * Because `role` is free-form text the issuer never enumerates, so asking "is the
 * role `terminal`" is the allow-list this file deliberately avoids — it would
 * refuse every role a later counter integration might carry, and would pass a
 * token whose role was mis-set. The subject namespace is decided by the same
 * issuer and is structurally distinct, and `issueToken` needs no new claim and no
 * change to `JwtClaims` for it.
 *
 * The remainder after the prefix is opaque. It is not looked up, not parsed, and
 * not compared to anything: there is no `pos_terminals` row behind it yet, so
 * nothing here can tell a terminal that exists from one that does not.
 */
export function isCounterSubject(auth: AuthHeaders): boolean {
  return isCounterSubjectValue(auth.userId);
}

/**
 * Refuse everything that is not a merchant's payment terminal on the two routes
 * that speak for a sale that already happened.
 *
 * `POST /v1/loyalty/passes/resolve` and `POST /v1/loyalty/checkins` had no guard at
 * all, and the absence *was* the defect: `POST /v1/auth/customer/token` is public
 * and mints `role: 'customer'`, so any customer could resolve an arbitrary
 * `member_code` and then report a fabricated sale against it — crediting whatever
 * the tenant's earn rule made of an `amount_cents` they chose. That is the same
 * class of hole `requireOperatorRole` was written for on `points/assign`, so it is
 * closed here the same way: on the route, not only on the one that was exploited.
 *
 * `requireOperatorRole` would be the wrong guard, for a product reason before a
 * security one. A terminal never sends points — it sends `amount_cents` and the
 * tenant's earn rule decides what that is worth — and the dashboard, which does
 * send points, calls `points/assign` instead. The two subjects therefore have to
 * stay distinguishable in both directions: a counter cannot configure the program,
 * and a customer cannot report a sale.
 *
 * Deliberately the *same* answer whatever the request would otherwise have done,
 * and for the same reason `requireOperatorRole` is: this reads nothing and writes
 * nothing, so it cannot tell an absent program from a present one, a member code
 * that exists from one that does not, or a request that would have been credited
 * from one that would have bounced. There is no existence oracle to probe the
 * tenant with, and it runs ahead of the body parse so an unauthorized caller
 * cannot make the route do work on their behalf.
 */
export function requireCounterSubject(auth: AuthHeaders): CounterSubjectGuard {
  if (!isCounterSubject(auth)) {
    return {
      ok: false,
      status: 403,
      code: COUNTER_SUBJECT_REQUIRED,
      message:
        "This endpoint reports a sale the merchant's payment terminal already collected, and only a counter credential may report one.",
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
// Pass projection
// ---------------------------------------------------------------------------

/**
 * Ask the wallet to project one customer's balance, and do not wait for it.
 *
 * ## The problem this answers
 *
 * A Google Wallet pass is a surface at a till, and the balance on it moved only
 * when the holder opened the app or when the daily sweep ran. Both are *pull*:
 * neither knows a sale happened, and the sweep bounds the staleness at 24 hours,
 * which is longer than a shift. This is the push, fired from the two handlers
 * that move a balance, after the ledger row is written.
 *
 * ## Why `waitUntil` and not an `await`
 *
 * The work is a Google round trip. Awaiting it would make a till's availability
 * depend on Google's, so one slow minute from Google becomes a sales outage —
 * a worse failure than a balance that is briefly stale and converges within a
 * day. `waitUntil` is what makes the projection outlive the response without
 * being on the response's critical path.
 *
 * ## Why this function cannot throw
 *
 * It is called from inside the handlers' `try` blocks, where a unique-violation
 * is being translated into a 409 and anything else becomes a 500. A throw here
 * would therefore turn a balance projection into a failed sale, which is exactly
 * the coupling above argued against. So the dispatch is guarded, the promise is
 * handled, and the absence of a binding is a log line rather than an exception.
 * The ledger is already correct by the time this runs; the pass converges later
 * or the daily sweep converges it.
 *
 * ## Why fire-and-forget is safe here rather than merely convenient
 *
 * The wallet's `reconcileCustomer` is `reconcilePass`, which compares before it
 * writes: a second call for an unchanged balance issues no Google write at all.
 * A dropped `waitUntil`, a Google failure and a duplicated fire are all the same
 * no-op, and the daily sweep is the backstop for all of them. What this buys is
 * latency — the balance is right by the time the customer is back at the counter
 * — and that is worth having; it is not the correctness fix, the sweep already
 * was.
 *
 * Only the wallet-side outcome knows whether anything was written, and this
 * worker deliberately does not read it. Branching on it here would be a second
 * opinion about the pass, held by a worker with no way to check it.
 */
export function schedulePassReconcile(
  // `Context<{ Bindings: Bindings }>` rather than `Context<AppEnv>`: the router
  // declares bindings and no variables, so `AppEnv`'s `Variables` would make this
  // uncallable from the two handlers that need it. The tenant is passed in
  // explicitly for the same reason — the app-level middleware validates the auth
  // headers but never stores them on the context, so `c.get('auth')` is not
  // something a route can rely on.
  c: Context<{ Bindings: Bindings }>,
  customer: { tenantId: string; customerId: string },
): void {
  const wallet = c.env?.WALLET;

  // `Bindings` declares this as required, and the runtime does not make it so:
  // a `wrangler.jsonc` that predates the binding — and every test that drives
  // this app through `app.fetch(request, env)` — reaches here without one. That
  // is one of the ways the projection can be unavailable, and the contract above
  // says what to do with all of them: do not fail the sale.
  if (!wallet) {
    console.error(
      `[growth] No WALLET service binding, so the pass for customer ${customer.customerId} in ` +
        `tenant ${customer.tenantId} was not projected. The daily sweep will pick it up.`,
    );
    return;
  }

  // The dispatch itself is guarded separately from its promise. An RPC call that
  // throws synchronously — a binding that is present but is not a worker — would
  // otherwise be caught by the handler's `try` and reported as a 500 for a
  // request that had already been written to the database.
  let projection: Promise<unknown>;
  try {
    projection = wallet.reconcileCustomer(customer);
  } catch (err: unknown) {
    console.error(
      `[growth] Could not reach the wallet to project the pass for customer ` +
        `${customer.customerId} in tenant ${customer.tenantId}:`,
      err,
    );
    return;
  }

  // Handled before it is handed over, so the promise `waitUntil` receives cannot
  // reject. A rejected background task is attributed to the invocation that
  // spawned it, and an unhandled rejection is indistinguishable from a real
  // fault in a log someone has to triage at 06:00.
  const handled = projection.catch((err: unknown) => {
    console.error(
      `[growth] Pass projection failed for customer ${customer.customerId} in tenant ` +
        `${customer.tenantId}; the ledger is correct and the daily sweep will converge the pass:`,
      err,
    );
  });

  // `c.executionCtx` throws when the context carries no `ExecutionContext`, and
  // the only such callers are the ones driving this app directly rather than
  // the Workers runtime. Catching that is not defensive noise: the alternative
  // is a pass projection failing a sale for the sake of an environment that is
  // not a sale.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  if (waitUntil === undefined) {
    console.error(
      '[growth] No ExecutionContext to hand the pass projection to, so it runs unattached.',
    );
    return;
  }

  waitUntil(handled);
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

import type { KVNamespace } from '@cloudflare/workers-types';
import { getRequestId } from '@vyloop/request-context';
import { COUNTER_SUBJECT_PREFIX, isCounterSubject } from '@vyloop/types';
import type { Context, Next } from 'hono';

import type { JwtClaims } from './auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** KV namespace for rate limit counters */
  kv: KVNamespace;
  /** Default rate limits per plan (requests per window) */
  limits: Record<string, number>;
  /** Time window in seconds (default: 60) */
  windowSeconds: number;
  /**
   * Limits for routes that have no identity to key on.
   *
   * A request without a JWT has no `business_id`, so the per-business counter has
   * nothing to key on and the request used to skip the limiter entirely. That was
   * harmless while every throttled route required a token, and stopped being
   * harmless when `POST /v1/auth/business/signup` landed: it is public, it creates
   * a tenant, and it runs a 100k-iteration key derivation before answering. A
   * script farm is exactly that shape.
   *
   * Keyed by client address rather than by anything the caller supplies, so the
   * limit cannot be spent by rotating a header.
   */
  anonymousLimits?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/**
 * The ceiling for a tenant on the `premium` plan.
 *
 * ## UNCONFIRMED — this is a guess with a shape, not a decision
 *
 * Nobody has decided what a paying tenant gets. What is decided is that the
 * paying tenant is currently getting `free`'s 60, because the lookup below fell
 * through to it: that is the defect this file exists to close, and any number
 * above 60 closes it. So the number here is chosen to be defensible, not to be
 * right.
 *
 * Why 600, and why that is a reasonable shape to argue about:
 *
 * - **It exists in this repository already.** `WALLET_CALLBACK_LIMIT_PER_WINDOW`
 *   in `apps/gateway/src/index.ts:144` is 600, chosen for a machine caller at a
 *   paying merchant behind a busy address. A till terminal is that shape and
 *   more so: it is a machine, it is per-merchant, and it asks about the same
 *   handful of endpoints all day.
 * - **It is a ceiling, not an entitlement.** 600/min is 10 requests a second. A
 *   merchant with two tills does not approach it, and the thing it protects
 *   against is amplification — one stolen terminal key driving a script — not
 *   honest traffic.
 * - **It cannot break the one paying tenant in the system.** Raising a ceiling
 *   for a tenant that has never had one is not a risk to that tenant.
 *
 * What would make it wrong: if a premium plan is ever sold on the promise of
 * *unlimited* API access, this becomes the wrong number and the contract has to
 * change with it. What would make it too low: bulk imports, if they ever exist.
 *
 * One named constant so that changing it is one line and not a search.
 */
export const PREMIUM_PLAN_LIMIT_PER_WINDOW = 600;

/**
 * The ceiling for a token whose `plan` claim is absent, or names a plan this
 * build has never heard of.
 *
 * ## Strictly below `free`, and that ordering is the point
 *
 * `plan` is an **optional** claim (see `middleware/auth.ts`), so this number is
 * live: every token minted before this change carries none, and it has a
 * one-hour lifetime, so it is a rolling population rather than a permanent one.
 *
 * The alternative — resolving an absent plan to `free`'s 60 — makes omission
 * worth exactly as much as being the cheapest tier, which turns "the caller
 * forgot to pass the plan" into a free way to be throttled least. A limit is
 * supposed to fall when you know less about the caller, not rise.
 *
 * So: 30, half of `free`. It is a tightening rather than a loosening, so it
 * cannot weaken any limit in effect today, and it only reaches tokens that a
 * gateway which has not been told a plan exists could have minted anyway.
 *
 * **What it must never be is unlimited.** A plan this build does not know is
 * more likely to be a future tier than a paying one, and an unknown key must not
 * be able to fall through to nothing at all.
 */
export const UNKNOWN_PLAN_LIMIT_PER_WINDOW = 30;

/**
 * Rate limits per `tenants.plan`, per window.
 *
 * ## The keys are the plans that exist, which is the whole point
 *
 * Measured against production rather than assumed: `tenants.plan` holds `free`
 * (5 tenants) and `premium` (1). This table used to be `{ free, pro, business }`,
 * so `pro` and `business` were **dead keys** — nothing was ever limited by them,
 * and the one paying tenant resolved through `?? config.limits.free` to the same
 * 60 requests a minute a tenant that has never paid gets.
 *
 * They were removed rather than renamed, and that is a judgement worth stating
 * because it is reversible-looking: renaming `pro` to `premium` would have left
 * `business` behind, and a key nobody can reach is not a harmless leftover. It
 * is a table that reads as though it describes the product and does not, which
 * is what makes the *next* plan get added to it without anyone measuring whether
 * the one before it is real. Two keys, both real, is the honest shape of the
 * thing today.
 *
 * ## Keyed by plan, not by role
 *
 * The lookup used to be `config.limits[jwt.role]`, and `role` holds `admin`,
 * `staff`, `cashier` and `customer` — none of which was ever a key, so the
 * `??` fired on every authenticated request in the system. A limit table keyed
 * by something the table does not contain is not a limit; it is one number with
 * extra words around it.
 */
export const DEFAULT_LIMITS: Record<string, number> = {
  free: 60,
  premium: PREMIUM_PLAN_LIMIT_PER_WINDOW,
};

/**
 * The subject namespace a counter's token lives in: `pos:<terminalId>`, and the
 * question of whether a subject is one, are both owned by `@vyloop/types` and
 * imported here.
 *
 * They used to be declared twice — once in this file and once in
 * `workers/growth/src/helpers.ts` — with a contract test that read the other
 * file's source to prove the two spellings agreed. That worked, and it was the
 * only thing holding them together: the dependency runs the wrong way for a
 * shared rule (growth reads the value, it does not own it), and a worker cannot
 * own a rule the edge has to apply to every request before it decides which
 * worker to forward to.
 *
 * A package both sides depend on is the dependency direction that can. The
 * gateway still cannot take a runtime dependency on a **worker**, and it still
 * does not need to: `@vyloop/types` is a leaf with no runtime dependencies of
 * its own, and it is already on this worker's dependency list.
 *
 * ## Why the colon, and why it is exact
 *
 * The reason `@vyloop/types` gives: a bare `pos` is matched by `postmaster-3`,
 * `pos-7` and `POS-2`, so a prefix without a separator hands a counter's bucket
 * to any issuer that happened to pick a word starting with those letters. A
 * uuid cannot contain a colon, so `pos:` is unreachable by accident. `pos:` with
 * an empty remainder is not a counter either, for the same reason growth
 * refuses it.
 */

export const DEFAULT_WINDOW = 60;

/**
 * Signups allowed per window, per client address.
 *
 * Five a minute is generous for a person filling in a form and read from
 * someone filling in the same form with a list of businesses, which is what a
 * tenant-creation endpoint is worth to an attacker. It is not a security
 * control on its own — it bounds the cost of a wrong guess, not the volume of
 * real signups — and nothing here should be read as a reason to expose the
 * route without authentication in front of it later.
 */
export const SIGNUP_LIMIT_PER_WINDOW = 5;

/**
 * Token exchanges at a merchant's till allowed per window, per client address.
 *
 * Five, which is `SIGNUP_LIMIT_PER_WINDOW` and for the same reason: both routes
 * are public, both are keyed only by client address because the caller has no
 * `business_id` to key on yet, and both run a 100k-iteration key derivation before
 * they can answer. One derivation per request with no ceiling is an amplifier
 * pointed at us, and five a minute is far more than either legitimate caller
 * needs.
 *
 * ## Deliberately not login's number, which is none
 *
 * Login is left unlimited because a limit there hands a legitimate person a 429
 * because *someone else* guessed at their password, and they cannot tell that
 * apart from being locked out of their own account. That is the worse failure,
 * and it is why one number in this file is absent on purpose.
 *
 * A till is not that. It authenticates once per boot, so a request loop against
 * `POST /v1/auth/pos/token` is a bug in the terminal rather than traffic a
 * merchant is generating — there is no burst of legitimate exchanges for a limit
 * to break. Bounding it costs a real merchant nothing and removes an
 * unauthenticated, unthrottled path to a CPU cost.
 */
export const POS_TOKEN_LIMIT_PER_WINDOW = 5;

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Hono middleware that rate-limits requests per business_id + endpoint.
 *
 * Uses a KV counter with a TTL window. When the limit is exceeded,
 * returns 429 `RATE_LIMIT_EXCEEDED` with a `Retry-After` header.
 *
 * @param config Rate limiting configuration.
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context, next: Next) => {
    const jwt = c.get('jwt') as JwtClaims | undefined;
    const endpoint = new URL(c.req.url).pathname;

    if (!jwt) {
      // No identity, so the per-business counter has nothing to key on. This is
      // not a reason to skip throttling: a public route that costs real work is
      // exactly the one a limit exists for. Routes absent from `anonymousLimits`
      // are still unlimited, which is what keeps this opt-in per route rather
      // than a blanket ceiling on the public surface.
      const anonymousLimit = config.anonymousLimits?.[endpoint];
      if (anonymousLimit === undefined) {
        await next();
        return;
      }

      // `CF-Connecting-IP` is set by the edge and is not a header the caller can
      // set. The loopback fallback only exists so the middleware is testable and
      // so a local run is not keyed on the literal string "unknown", which would
      // put every local request in one shared bucket.
      const clientIp = c.req.header('CF-Connecting-IP') ?? 'local';

      return throttle(c, next, config, {
        kvKey: `ratelimit:anon:${clientIp}:${endpoint}`,
        limit: anonymousLimit,
      });
    }

    const businessId = jwt.business_id;
    // `jwt.plan` is optional, so the key is narrowed before the lookup rather than
    // after: indexing a `Record<string, number>` with `undefined` is a type error,
    // and the honest translation of "no plan claim" is "no entry", which the `??`
    // below turns into a bounded number rather than into `undefined`.
    const limit =
      (jwt.plan === undefined ? undefined : config.limits[jwt.plan]) ??
      UNKNOWN_PLAN_LIMIT_PER_WINDOW;

    // ## The counter key, and why only counters change
    //
    // A merchant runs more than one thing against these endpoints: a human at a
    // dashboard, and one or more tills. Keyed on `business_id` alone they all
    // spend one bucket, so a busy counter could throttle the person trying to
    // fix it — and a stolen terminal credential could burn the budget of every
    // operator at that merchant to get itself a 429.
    //
    // A counter therefore gets its own key:
    //
    // ```
    // ratelimit:<businessId>:pos:<sub>:<endpoint>
    // ```
    //
    // Every other subject keeps `ratelimit:<businessId>:<endpoint>` exactly as it
    // was. That is deliberate and it is not an oversight: humans at one merchant
    // sharing a bucket is a *tenant-wide ceiling*, which is the property the
    // limiter is for, and splitting it per user would multiply the buckets one
    // tenant can spend by the size of its staff. Counters are counted apart
    // because they are machines with their own traffic shape, not because
    // operators deserve to be able to exceed a tenant's ceiling between them.
    //
    // `business_id` stays in the counter's key too, so a terminal can never read
    // or exhaust a bucket that belongs to a different merchant.
    const kvKey = isCounterSubject(jwt.sub)
      ? `ratelimit:${businessId}:${COUNTER_SUBJECT_PREFIX}${jwt.sub}:${endpoint}`
      : `ratelimit:${businessId}:${endpoint}`;

    return throttle(c, next, config, { kvKey, limit });
  };
}

/**
 * One counter, one window.
 *
 * Extracted because the authenticated and anonymous paths now do the same thing
 * with a different key, and two copies of a KV read-modify-write is where a
 * `Retry-After` header starts disagreeing between callers.
 */
async function throttle(
  c: Context,
  next: Next,
  config: RateLimitConfig,
  { kvKey, limit }: { kvKey: string; limit: number },
): Promise<Response | void> {
    try {
      const current = await config.kv.get(kvKey);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= limit) {
        const retryAfter = config.windowSeconds;
        return c.json(
          {
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
              request_id: getRequestId(c),
            },
          },
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }

      // Increment counter. Use PUT since KV does not support atomic increment.
      // For production: consider D1-backed counters for atomicity.
      await config.kv.put(kvKey, String(count + 1), {
        expirationTtl: config.windowSeconds,
      });

      await next();
  } catch (err) {
    console.error('Rate limit error:', err);
    // If KV fails, allow the request through (fail open for PMV)
    await next();
  }
}

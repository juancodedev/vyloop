import type { KVNamespace } from '@cloudflare/workers-types';
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

export const DEFAULT_LIMITS: Record<string, number> = {
  free: 60,
  pro: 300,
  business: 1000,
};

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
    const kvKey = `ratelimit:${businessId}:${endpoint}`;
    const limit = config.limits[jwt.role] ?? config.limits.free ?? 60;

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
              request_id: crypto.randomUUID(),
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

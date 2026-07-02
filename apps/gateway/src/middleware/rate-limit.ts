import type { Context, Next } from 'hono';
import type { KVNamespace } from '@cloudflare/workers-types';
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

    if (!jwt) {
      // Unauthenticated — let auth middleware handle it
      await next();
      return;
    }

    const businessId = jwt.business_id;
    const endpoint = new URL(c.req.url).pathname;
    const kvKey = `ratelimit:${businessId}:${endpoint}`;
    const limit = config.limits[jwt.role] ?? config.limits.free ?? 60;

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
  };
}

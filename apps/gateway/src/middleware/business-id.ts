import type { Context, Next } from 'hono';
import type { JwtClaims } from './auth';

/**
 * Hono middleware that enforces X-Business-ID matches the JWT's business_id claim.
 *
 * This is the first line of multi-tenant isolation:
 * every request must carry an `X-Business-ID` header that matches
 * the `business_id` in the authenticated JWT.
 *
 * Returns 403 `AUTH_BUSINESS_MISMATCH` on mismatch.
 */
export async function businessIdMiddleware(c: Context, next: Next) {
  const headerBusinessId = c.req.header('X-Business-ID');
  const jwt = c.get('jwt') as JwtClaims | undefined;

  if (!jwt) {
    return c.json(
      {
        error: {
          code: 'AUTH_TOKEN_INVALID',
          message: 'JWT claims not found — ensure auth middleware runs first',
          request_id: crypto.randomUUID(),
        },
      },
      401,
    );
  }

  if (!headerBusinessId) {
    return c.json(
      {
        error: {
          code: 'AUTH_BUSINESS_MISMATCH',
          message: 'Missing X-Business-ID header',
          request_id: crypto.randomUUID(),
        },
      },
      403,
    );
  }

  if (headerBusinessId !== jwt.business_id) {
    return c.json(
      {
        error: {
          code: 'AUTH_BUSINESS_MISMATCH',
          message: 'X-Business-ID does not match token business_id',
          request_id: crypto.randomUUID(),
        },
      },
      403,
    );
  }

  await next();
}

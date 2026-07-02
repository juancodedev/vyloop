import type { Context, Next } from 'hono';
import type { JwtClaims } from './auth';

/**
 * Hono middleware that strips incoming `X-User-Id`, `X-Business-Id`, `X-User-Role`
 * headers (preventing spoofing) and injects them from the decoded JWT claims.
 *
 * Must run AFTER auth middleware (so `c.get('jwt')` is available) and BEFORE
 * the router middleware (so forwarded requests carry the injected headers).
 *
 * - `jwt.sub` → `X-User-Id`
 * - `jwt.business_id` → `X-Business-Id`
 * - `jwt.role` → `X-User-Role`
 *
 * If a JWT claim is missing, the corresponding header is omitted (no error).
 * If no JWT is set (e.g., /v1/auth/* paths that skip auth), spoofed headers are
 * still stripped, and no injection occurs.
 */
export function authInjectMiddleware() {
  return async (c: Context, next: Next) => {
    const jwt = c.get('jwt') as JwtClaims | undefined;

    // Clone the raw request so we can build a clean set of headers
    const req = c.req.raw;
    const headers = new Headers(req.headers);

    // Strip any incoming spoofed headers — the downstream services must only
    // trust headers injected here, never what the client sends directly.
    headers.delete('X-User-Id');
    headers.delete('X-Business-Id');
    headers.delete('X-User-Role');

    // Inject headers from JWT claims (if available).
    // If a claim is absent the header is simply omitted — no hard failure.
    if (jwt) {
      if (jwt.sub) headers.set('X-User-Id', jwt.sub);
      if (jwt.business_id) headers.set('X-Business-Id', jwt.business_id);
      if (jwt.role) headers.set('X-User-Role', jwt.role);
    }

    // Replace the underlying raw Request so subsequent middleware and the router
    // (which reads c.req.raw) see the modified headers.
    c.req.raw = new Request(req, { headers });

    await next();
  };
}

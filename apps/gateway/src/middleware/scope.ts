import { getRequestId } from '@vyloop/request-context';
import type { Context, Next } from 'hono';

import type { JwtClaims } from './auth';

/**
 * The routes that need a token scope beyond a valid signature.
 *
 * Exact method and path, never a prefix: a prefix would quietly extend the
 * requirement to every route added under it later. A route missing from this
 * table is gated by the token alone, which is what every route was before the
 * table existed.
 */
export const REQUIRED_SCOPES: ReadonlyArray<{ method: string; path: string; scope: string }> = Object.freeze([
  // The customer edits their own name, email and birth date.
  { method: 'PATCH', path: '/v1/customers/me', scope: 'profile:write' },
]);

export const SCOPE_MISSING = 'AUTH_SCOPE_MISSING';

/**
 * The path as the worker's router will match it.
 *
 * The worker decodes percent-escapes before routing, so `/v1/customers/%6De`
 * reaches the `me` route there. Comparing the raw path here would let that
 * spelling walk past the table. Repeated and trailing slashes are folded for
 * the same reason: the table must not be the stricter reader of the two.
 */
export function normalizePath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape is left as written; it cannot spell a table entry.
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

export function requiredScopeFor(method: string, path: string): string | null {
  const normalized = normalizePath(path);
  const rule = REQUIRED_SCOPES.find((r) => r.method === method.toUpperCase() && r.path === normalized);
  return rule ? rule.scope : null;
}

/**
 * Refuse a request whose token lacks the scope its route needs.
 *
 * Runs after the auth middleware. A route that needs a scope and arrives with
 * no verified token is refused too: it fails closed rather than trusting that
 * nothing upstream skipped authentication for it.
 */
export function scopeMiddleware() {
  return async (c: Context, next: Next) => {
    const scope = requiredScopeFor(c.req.method, new URL(c.req.url).pathname);
    if (scope === null) {
      await next();
      return;
    }

    const jwt = c.get('jwt') as JwtClaims | undefined;
    const scopes = Array.isArray(jwt?.scopes) ? jwt.scopes : [];
    if (!scopes.includes(scope)) {
      return c.json(
        {
          error: {
            code: SCOPE_MISSING,
            message: `This token does not carry the ${scope} scope this route needs. Sign in again to get a token that does.`,
            request_id: getRequestId(c),
          },
        },
        403,
      );
    }

    await next();
  };
}

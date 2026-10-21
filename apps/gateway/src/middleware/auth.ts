import { getRequestId } from '@vyloop/request-context';
import type { Context, Next } from 'hono';
import { jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtClaims extends JWTPayload {
  sub: string;
  business_id: string;
  role: string;
  scopes: string[];
  /**
   * The tenant's plan, taken from `tenants.plan` by the issuer.
   *
   * ## Optional, on purpose
   *
   * `sub`, `business_id`, `role` and `scopes` are required because nothing works
   * without them: a request that has no `sub` has no subject to authorize, and
   * one with no `business_id` has no tenant to read or write. `plan` has no such
   * job — it decides one number, in one middleware, and `rate-limit.ts` gives an
   * absent or unrecognised one a bounded limit of its own.
   *
   * So this is deliberately **not** added to the required-claims check below.
   * That check is the difference between "this token predates the feature" and
   * "this token is broken", and every token issued before this change predates
   * the feature. Requiring it would answer 401 to every live session in the
   * system the moment this deploys, and it would keep answering 401 to any token
   * minted by a path that has not been updated to pass a plan — including
   * `POST /v1/auth/token` and `POST /v1/auth/refresh`, which are not being
   * changed here. An expired-and-refreshed session is a recoverable annoyance;
   * a fleet of 401s at deploy time is an outage with a misleading error code.
   *
   * The consequence is that a missing claim has to be *safe*, not impossible:
   * `UNKNOWN_PLAN_LIMIT_PER_WINDOW` in `rate-limit.ts` is what makes it safe,
   * and it is stricter than the cheapest plan's ceiling so that omitting the
   * claim is never worth as much as paying for the least.
   *
   * Not trusted as an authorization input anywhere: it is read only to pick a
   * number, and only from a claim the issuer signed.
   */
  plan?: string;
}

export type AuthEnv = {
  Variables: {
    jwt: JwtClaims;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that validates a Bearer JWT token from the Authorization header.
 *
 * Sets `c.get('jwt')` with the decoded claims on success.
 * Returns 401 `AUTH_TOKEN_INVALID` on failure.
 */
export function authMiddleware(secret: string) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(
        {
          error: {
            code: 'AUTH_TOKEN_INVALID',
            message: 'Missing or invalid Authorization header',
            request_id: getRequestId(c),
          },
        },
        401,
      );
    }

    const token = authHeader.slice(7);

    try {
      const { payload } = await jwtVerify(token, secretKey(secret), {
        issuer: 'vyloop',
        algorithms: ['HS256'],
        clockTolerance: 60, // tolerate up to 60s of clock drift
      });

      const claims = payload as unknown as JwtClaims;

      // `plan` is intentionally absent from this list. It is an optional claim,
      // and a required one here would 401 every token minted before it shipped —
      // see the note on `JwtClaims.plan` for why that is an outage wearing a
      // misleading error code.
      if (!claims.sub || !claims.business_id || !claims.role || !claims.scopes) {
        return c.json(
          {
            error: {
              code: 'AUTH_TOKEN_INVALID',
              message: 'Token missing required claims',
              request_id: getRequestId(c),
            },
          },
          401,
        );
      }

      c.set('jwt', claims);
      await next();
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'AUTH_TOKEN_INVALID',
            message: err instanceof Error ? err.message : 'Token invalid or expired',
            request_id: getRequestId(c),
          },
        },
        401,
      );
    }
  };
}

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
            request_id: crypto.randomUUID(),
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

      if (!claims.sub || !claims.business_id || !claims.role || !claims.scopes) {
        return c.json(
          {
            error: {
              code: 'AUTH_TOKEN_INVALID',
              message: 'Token missing required claims',
              request_id: crypto.randomUUID(),
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
            request_id: crypto.randomUUID(),
          },
        },
        401,
      );
    }
  };
}

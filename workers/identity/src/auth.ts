import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtClaims extends JWTPayload {
  sub: string;
  business_id: string;
  role: string;
  scopes: string[];
  /**
   * The tenant's `tenants.plan`, so the gateway's limiter can key on the thing it
   * is actually limiting.
   *
   * **Optional, and not added to the required set below.** The limiter gives an
   * absent claim a bounded limit of its own (`UNKNOWN_PLAN_LIMIT_PER_WINDOW` in
   * `apps/gateway/src/middleware/rate-limit.ts`), and every token issued before
   * this claim existed is valid without it. Requiring it here would 401 all of
   * them.
   *
   * Passed in rather than looked up: this is a signing function, and a token
   * without a plan is still a valid token, so "a route forgot to pass one" is a
   * silent failure. Making the caller state it keeps that decision where the
   * tenant row already is.
   */
  plan?: string;
}

export interface TokenRequest {
  client_id: string;
  client_secret: string;
  grant_type: 'client_credentials' | 'refresh_token';
  refresh_token?: string;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default token lifetime: 1 hour */
const ACCESS_TOKEN_TTL = 3600;

/** Refresh token lifetime: 30 days */
const _REFRESH_TOKEN_TTL = 2_592_000;

// ---------------------------------------------------------------------------
// POS terminals
// ---------------------------------------------------------------------------

/**
 * The plans whose tenants may hold a payment terminal.
 *
 * ## UNCONFIRMED — defaulted to the one paid tier, not decided
 *
 * POS is what a merchant pays for, so a free tenant cannot have one. That is a
 * guess about packaging and not a decision anyone has made, and it is why the
 * value lives in one constant with a name: selling POS as part of another tier
 * is a one-line change here and nowhere else.
 *
 * `['premium']` rather than `[]` is the deliberate half of that. An empty list
 * would be the strictly cautious choice and it would also make the entire feature
 * unreachable — no tenant could ever mint a `pos:` token, so
 * `POST /v1/auth/pos/token` could not be exercised end to end, and the guard on
 * the two routes that accept a counter would never have a positive case. A gate
 * that cannot be opened cannot be tested.
 *
 * It is a gate and not a feature flag, so it is checked against the tenant's
 * plan **on every exchange** rather than once at creation. A tenant that is
 * downgraded stops being able to renew its terminal credential immediately,
 * without anybody having to remember to revoke the rows.
 */
export const POS_PLANS: readonly string[] = ['premium'];

/** May a tenant on this plan hold a payment terminal? */
export function isPosPlan(plan: string | undefined): boolean {
  return typeof plan === 'string' && POS_PLANS.includes(plan);
}

/**
 * The subject a terminal's token carries: `pos:<terminalId>`.
 *
 * ## Why the prefix and not a bare `pos`
 *
 * `requireCounterSubject` in `workers/growth/src/helpers.ts` matches
 * `pos:` + a non-empty remainder, and it is deliberately exact: a bare `pos`
 * would be matched by `postmaster-3`, `pos-7` and `POS-2`, so the prefix is what
 * makes the namespace unambiguous. A uuid cannot contain a colon, and no other
 * issuer in this system asks for a subject that begins with these three letters —
 * `customers.global_id` for the customer app, `users.id` for staff — so `pos:` is
 * unreachable by accident.
 *
 * Declared here rather than imported from growth because the dependency runs the
 * wrong way: growth reads this value, it does not own it.
 */
export function counterSubject(terminalId: string): string {
  return `pos:${terminalId}`;
}

// ---------------------------------------------------------------------------
// JWT Signing / Verification
// ---------------------------------------------------------------------------

/**
 * Derive an HS256 key from the configured JWT_SECRET.
 * In production, use a proper key management system (RS256 with JWKS).
 */
function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Issue a signed JWT access token.
 *
 * @param secret       The JWT_SECRET from environment.
 * @param sub          User or service identifier. A counter uses `counterSubject(id)`.
 * @param businessId   Tenant (business) identifier.
 * @param role         User role (e.g. 'admin', 'staff').
 * @param scopes       Array of permission scopes.
 * @param plan         The tenant's plan, from `tenants.plan`. Omitted from the
 *                     token when absent — see `JwtClaims.plan`.
 * @param ttl          Time-to-live in seconds (default: 1 hour).
 */
export async function issueToken(
  secret: string,
  sub: string,
  businessId: string,
  role: string,
  scopes: string[],
  plan?: string,
  ttl: number = ACCESS_TOKEN_TTL,
): Promise<string> {
  const jwt = await new SignJWT({ sub, business_id: businessId, role, scopes, plan } as JwtClaims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setIssuer('vyloop')
    .setSubject(sub)
    .sign(secretKey(secret));

  return jwt;
}

/**
 * Verify and decode a JWT access token.
 *
 * @returns The decoded claims if valid.
 * @throws {Error} If the token is invalid, expired, or malformed.
 */
export async function validateToken(
  secret: string,
  token: string,
): Promise<JwtClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    issuer: 'vyloop',
    algorithms: ['HS256'],
  });

  // Validate that required claims are present
  if (!payload.sub || !payload.business_id || !payload.role || !payload.scopes) {
    throw new Error('AUTH_TOKEN_INVALID: missing required claims');
  }

  return payload as unknown as JwtClaims;
}

/**
 * Check that the JWT's scopes include at least one of the required scopes.
 *
 * @returns true if at least one required scope is present.
 */
export function hasScope(claims: JwtClaims, requiredScopes: string[]): boolean {
  return requiredScopes.some((s) => claims.scopes.includes(s));
}

/**
 * Generate a refresh token (opaque string, not a JWT).
 * In production, store this in DB with an expiry date.
 */
export function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Issue both access token and refresh token.
 *
 * `plan` is threaded through rather than defaulted to anything: a caller that
 * knows the tenant's plan passes it, and a caller that has not loaded the tenant
 * yet does not. The fallback for an absent plan is the limiter's bounded
 * unknown-plan ceiling, never an unlimited one.
 */
export async function issueTokenPair(
  secret: string,
  sub: string,
  businessId: string,
  role: string,
  scopes: string[],
  plan?: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const [accessToken, refreshToken] = await Promise.all([
    issueToken(secret, sub, businessId, role, scopes, plan),
    Promise.resolve(generateRefreshToken()),
  ]);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL };
}

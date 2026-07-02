import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JwtClaims extends JWTPayload {
  sub: string;
  business_id: string;
  role: string;
  scopes: string[];
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
const REFRESH_TOKEN_TTL = 2_592_000;

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
 * @param sub          User or service identifier.
 * @param businessId   Tenant (business) identifier.
 * @param role         User role (e.g. 'admin', 'staff').
 * @param scopes       Array of permission scopes.
 * @param ttl          Time-to-live in seconds (default: 1 hour).
 */
export async function issueToken(
  secret: string,
  sub: string,
  businessId: string,
  role: string,
  scopes: string[],
  ttl: number = ACCESS_TOKEN_TTL,
): Promise<string> {
  const jwt = await new SignJWT({ sub, business_id: businessId, role, scopes } as JwtClaims)
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
 */
export async function issueTokenPair(
  secret: string,
  sub: string,
  businessId: string,
  role: string,
  scopes: string[],
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const [accessToken, refreshToken] = await Promise.all([
    issueToken(secret, sub, businessId, role, scopes),
    Promise.resolve(generateRefreshToken()),
  ]);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL };
}

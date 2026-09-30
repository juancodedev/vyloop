import { describe, it, expect, beforeAll, vi } from 'vitest';

import { issueToken, validateToken, issueTokenPair, generateRefreshToken } from './auth';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-key-for-unit-tests-only';
const TEST_SUB = 'user_abc123';
const TEST_BUSINESS_ID = 'biz_456';
const TEST_ROLE = 'admin';
const TEST_PASSWORD_HASH = '7465737473616c743132333435363738:29e173ede6837224f941422881874869027d7a0c41ea754d81eb479ab49fab86180da374e764ade13d98102ebc3e0cbc1375ec5c321a32e54a241df21e659077';

// ---------------------------------------------------------------------------
// Mock database
// ---------------------------------------------------------------------------

// `hashPassword`, `verifyPassword` and the slug/policy helpers are spread in
// from the real module rather than stubbed. They are pure functions with no
// database dependency, and `POST /v1/auth/token` has to run the *real*
// `verifyPassword` — stubbing it would leave the login route untested exactly
// where the extraction is most likely to have broken something. Only the two
// things that touch a database are replaced.
vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();

  const mockUser = {
    id: TEST_SUB,
    email: 'test@example.com',
    passwordHash: TEST_PASSWORD_HASH,
    businessId: TEST_BUSINESS_ID,
    role: TEST_ROLE,
    fullName: 'Test User',
    createdAt: new Date(),
    updatedAt: null,
    deletedAt: null,
  };

  const mockDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockUser]),
        }),
      }),
    }),
  };

  return {
    ...actual,
    createDb: () => mockDb,
    schema: {
      users: {
        id: 'id',
        email: 'email',
        passwordHash: 'passwordHash',
        businessId: 'businessId',
        role: 'role',
        fullName: 'fullName',
        createdAt: 'createdAt',
        updatedAt: 'updatedAt',
        deletedAt: 'deletedAt',
      },
    },
  };
});
const TEST_SCOPES = ['read:customers', 'write:customers', 'write:loyalty'];

// ---------------------------------------------------------------------------
// Auth tests (JWT lifecycle)
// ---------------------------------------------------------------------------

describe('JWT Lifecycle', () => {
  describe('issueToken', () => {
    it('should issue a valid JWT with correct claims', async () => {
      const token = await issueToken(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES);
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // JWT has three dot-separated parts
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('validateToken', () => {
    it('should validate and return claims for a valid token', async () => {
      const token = await issueToken(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES);
      const claims = await validateToken(TEST_SECRET, token);

      expect(claims.sub).toBe(TEST_SUB);
      expect(claims.business_id).toBe(TEST_BUSINESS_ID);
      expect(claims.role).toBe(TEST_ROLE);
      expect(claims.scopes).toEqual(TEST_SCOPES);
    });

    it('should reject a token signed with a different secret', async () => {
      const token = await issueToken('different-secret', TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES);
      await expect(validateToken(TEST_SECRET, token)).rejects.toThrow();
    });

    it('should reject an expired token', async () => {
      // Token with 0-second TTL — effectively expired immediately
      const token = await issueToken(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES, 0);
      await expect(validateToken(TEST_SECRET, token)).rejects.toThrow();
    });

    it('should reject a malformed token', async () => {
      await expect(validateToken(TEST_SECRET, 'not-a-jwt')).rejects.toThrow();
    });

    it('should reject an empty token', async () => {
      await expect(validateToken(TEST_SECRET, '')).rejects.toThrow();
    });
  });

  describe('issueTokenPair', () => {
    it('should return both access and refresh tokens', async () => {
      const result = await issueTokenPair(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES);

      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.expiresIn).toBeGreaterThan(0);

      // Validate the access token
      const claims = await validateToken(TEST_SECRET, result.accessToken);
      expect(claims.sub).toBe(TEST_SUB);
    });
  });

  describe('generateRefreshToken', () => {
    it('should generate a unique opaque string', () => {
      const token1 = generateRefreshToken();
      const token2 = generateRefreshToken();

      expect(token1).toBeTruthy();
      expect(token1).not.toBe(token2);
      // Should be hex string (64 chars = 32 bytes)
      expect(token1).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

// ---------------------------------------------------------------------------
// Identity API tests (via Hono app)
// ---------------------------------------------------------------------------

describe('Identity API', () => {
  let app: typeof import('./index').default;

  beforeAll(async () => {
    app = (await import('./index')).default;
  });

  describe('POST /v1/auth/token', () => {
    it('should return 200 with token pair for valid email/password', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'test@example.com',
            password: 'test-password',
          }),
        }),
        { JWT_SECRET: TEST_SECRET, DATABASE_URL: 'postgres://mock' },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('access_token');
      expect(body).toHaveProperty('refresh_token');
      expect(body).toHaveProperty('token_type', 'Bearer');
      expect(body).toHaveProperty('expires_in');
      expect(body).toHaveProperty('scope');
    });

    it('should return 401 for missing credentials', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }),
        { JWT_SECRET: TEST_SECRET, DATABASE_URL: 'postgres://mock' },
      );

      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/me', () => {
    it('should return 200 with user info for a valid token', async () => {
      const token = await issueToken(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES);

      const res = await app.fetch(
        new Request('http://localhost/v1/me', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        { JWT_SECRET: TEST_SECRET },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.sub).toBe(TEST_SUB);
      expect(body.business_id).toBe(TEST_BUSINESS_ID);
      expect(body.role).toBe(TEST_ROLE);
      expect(body.scopes).toEqual(TEST_SCOPES);
    });

    it('should return 401 without Authorization header', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/me'),
        { JWT_SECRET: TEST_SECRET },
      );

      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/businesses/:id', () => {
    it('should return business info', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/businesses/biz_001'),
        { JWT_SECRET: TEST_SECRET },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('id', 'biz_001');
      expect(body).toHaveProperty('status', 'active');
    });
  });

  describe('GET /v1/businesses/:id/branches', () => {
    it('should return branch list', async () => {
      const res = await app.fetch(
        new Request('http://localhost/v1/businesses/biz_001/branches'),
        { JWT_SECRET: TEST_SECRET },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('branches');
      expect(body).toHaveProperty('total', 0);
    });
  });
});

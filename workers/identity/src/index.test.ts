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

  // What the POS exchange finds. Staged per test rather than filtered, for the
  // reason `customer-login.route.test.ts` gives: reproducing Drizzle's `where`
  // inside a stub would be testing the stub. Tables are told apart by a marker
  // rather than by which columns happen to be on them, so adding a column to the
  // schema cannot silently re-route a lookup. `lastSeenWrites` is what proves the
  // route touched the row it was handed.
  const USERS = 'users';
  const POS_TERMINALS = 'pos_terminals';
  const TENANTS = 'tenants';

  let posTerminals: Record<string, unknown>[] = [];
  let tenants: Record<string, unknown>[] = [];
  const lastSeenWrites: { where: unknown; values: Record<string, unknown> }[] = [];

  function rowsFor(table: Record<string, unknown>) {
    if (table.__table === POS_TERMINALS) return posTerminals;
    if (table.__table === TENANTS) return tenants;
    return [mockUser];
  }

  const mockDb = {
    select: () => ({
      from: (table: Record<string, unknown>) => ({
        where: () => ({
          limit: () => Promise.resolve(rowsFor(table).slice(0, 1)),
        }),
      }),
    }),
    update: (table: Record<string, unknown>) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          if (table.__table === POS_TERMINALS) lastSeenWrites.push({ where, values });
          return Promise.resolve();
        },
      }),
    }),
  };

  return {
    ...actual,
    createDb: () => mockDb,
    schema: {
      users: {
        __table: USERS,
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
      posTerminals: {
        __table: POS_TERMINALS,
        id: 'id',
        businessId: 'business_id',
        name: 'name',
        keyHash: 'key_hash',
        lastSeenAt: 'last_seen_at',
        revokedAt: 'revoked_at',
        createdAt: 'created_at',
      },
      tenants: {
        __table: TENANTS,
        id: 'id',
        slug: 'slug',
        name: 'name',
        plan: 'plan',
      },
    },
    __posFixtures: {
      stage: (rows: Record<string, unknown>[], tenantRows: Record<string, unknown>[]) => {
        posTerminals = rows;
        tenants = tenantRows;
        lastSeenWrites.length = 0;
      },
      lastSeenWrites,
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
      // Token with 0-second TTL — effectively expired immediately.
      //
      // `undefined` for `plan` and `0` for `ttl`, in that order: `plan` sits
      // between the scopes and the TTL, so the positional `0` this test used to
      // pass became a plan of `0` and the token stopped expiring. The test still
      // ran and still passed its first assertion, which is exactly the shape of a
      // change that silently stops testing what it was written to test.
      const token = await issueToken(TEST_SECRET, TEST_SUB, TEST_BUSINESS_ID, TEST_ROLE, TEST_SCOPES, undefined, 0);
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

// ---------------------------------------------------------------------------
// POST /v1/auth/pos/token
//
// `requireCounterSubject` (workers/growth/src/helpers.ts:244) refuses both
// counter routes to anything whose subject is not `pos:<id>`, and until this
// route existed nothing in the system could mint one. These tests are the positive
// and negative cases for the credential behind that marker.
//
// The three refusals that must not be distinguishable are asserted as
// indistinguishable, not just as refusals: an unknown terminal, a revoked
// terminal and a wrong secret all answer the same status and the same code, so
// this endpoint cannot be used to learn which terminal ids exist.
// ---------------------------------------------------------------------------

const TERMINAL_ID = '0f9c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const TENANT_ID = 'tenant-pos-1';
const TERMINAL_SECRET = 'posk_live_9f3c1a77e0b24d5e8a61f0c3b95d7421';

/** The staged row and tenant, ready for a happy-path exchange. */
async function stageTerminal(overrides: Record<string, unknown> = {}, plan = 'premium') {
  const { hashPassword } = await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');
  const keyHash = await hashPassword(TERMINAL_SECRET);

  fixtures.stage(
    [
      {
        id: TERMINAL_ID,
        businessId: TENANT_ID,
        name: 'Terminal Mostrador 1',
        keyHash,
        lastSeenAt: null,
        revokedAt: null,
        createdAt: new Date(),
        ...overrides,
      },
    ],
    [{ id: TENANT_ID, slug: 'cafe-central', name: 'Café Central', plan }],
  );

  return { keyHash };
}

function posLogin(body: unknown, app: typeof import('./index').default) {
  return app.fetch(
    new Request('http://localhost/v1/auth/pos/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { JWT_SECRET: TEST_SECRET, DATABASE_URL: 'postgres://mock' },
  );
}

/** The fixture staging handle the `@vyloop/db` mock exposes. Cast, because the
 *  real module has no such export — it only exists in the mock. */
const { __posFixtures: fixtures } = (await import('@vyloop/db')) as unknown as {
  __posFixtures: {
    stage: (rows: Record<string, unknown>[], tenantRows: Record<string, unknown>[]) => void;
    lastSeenWrites: { where: unknown; values: Record<string, unknown> }[];
  };
};

describe('POST /v1/auth/pos/token', () => {
  let app: typeof import('./index').default;

  beforeAll(async () => {
    app = (await import('./index')).default;
  });

  it('exchanges a live credential for a token whose subject is a counter', async () => {
    await stageTerminal();

    const res = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; business_id: string; terminal_id: string };
    const claims = await validateToken(TEST_SECRET, body.token);

    // The whole point: `requireCounterSubject` matches `pos:` + a non-empty
    // remainder, so a token whose subject is anything else is refused by the two
    // routes this credential exists to serve.
    expect(claims.sub).toBe(`pos:${TERMINAL_ID}`);
    expect(claims.business_id).toBe(TENANT_ID);
    // The plan travels with it, so the gateway's limiter stops reading this
    // merchant as a free one.
    expect(claims.plan).toBe('premium');
  });

  it('refuses an unknown terminal', async () => {
    fixtures.stage([], []);

    const res = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('refuses a revoked terminal, with the same answer as an unknown one', async () => {
    // Revocation is a timestamp on the row rather than a delete, so "revoked" is
    // a state the exchange has to notice. The response is identical to the unknown
    // case on purpose: a different code here would answer "this terminal id exists
    // and was revoked", which is half the value of guessing ids.
    await stageTerminal({ revokedAt: new Date('2026-01-02T03:04:05Z') });
    const revoked = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);
    const revokedBody = await revoked.clone().json();

    fixtures.stage([], []);
    const unknown = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);

    expect(revoked.status).toBe(401);
    expect(revoked.status).toBe(unknown.status);
    expect(revokedBody).toEqual(await unknown.json());
  });

  it('refuses a wrong secret', async () => {
    await stageTerminal();

    const res = await posLogin({ terminal_id: TERMINAL_ID, secret: 'posk_live_not_the_one' }, app);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('refuses a tenant whose plan does not include POS', async () => {
    // Checked on every exchange rather than once at creation, so a downgrade
    // takes effect without anybody having to remember to revoke the rows.
    await stageTerminal({}, 'free');

    const res = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('POS_PLAN_REQUIRED');
    // And nothing was written: a refused exchange is not evidence of a visit.
    expect(fixtures.lastSeenWrites).toEqual([]);
  });

  it('refuses a body that names no terminal', async () => {
    await stageTerminal();

    const res = await posLogin({ secret: TERMINAL_SECRET }, app);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a body that is not JSON, rather than throwing', async () => {
    const res = await posLogin('{ not json', app);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('records the visit only after the credential has been accepted', async () => {
    await stageTerminal();

    await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);

    expect(fixtures.lastSeenWrites).toHaveLength(1);
    expect(fixtures.lastSeenWrites[0]!.values.lastSeenAt).toBeInstanceOf(Date);
  });

  it('verifies against the stored hash, never against the secret in the row', async () => {
    // The assertion the whole table shape exists for: what is stored is not the
    // thing that was presented. `hashPassword` is the same mechanism
    // `users.password_hash` uses, so there is one credential scheme here rather
    // than two.
    const { keyHash } = await stageTerminal();

    expect(keyHash).not.toBe(TERMINAL_SECRET);
    expect(keyHash).not.toContain(TERMINAL_SECRET);
    // `saltHex:hashHex`, and neither half is the secret.
    expect(keyHash.split(':')).toHaveLength(2);
    expect(keyHash).not.toContain(TERMINAL_SECRET.slice(0, 8));

    // Two terminals with the same secret hash differently, because the salt is
    // random. A row that stored a digest of the secret alone could be attacked
    // with one rainbow table for every terminal in the system.
    const { hashPassword } = await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');
    expect(await hashPassword(TERMINAL_SECRET)).not.toBe(keyHash);
  });

  it('carries the narrowest scope that exists, because a till reports sales', async () => {
    // Scopes do not authorize the counter — the subject namespace does, on the
    // route — so this is documentation in the token rather than a control. It is
    // the narrowest existing scope, and it is the one that names the thing the
    // terminal is allowed to do.
    await stageTerminal();

    const res = await posLogin({ terminal_id: TERMINAL_ID, secret: TERMINAL_SECRET }, app);
    const body = (await res.json()) as { token: string };
    const claims = await validateToken(TEST_SECRET, body.token);

    expect(claims.scopes).toEqual(['write:loyalty']);
  });
});

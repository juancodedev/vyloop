import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

import { issueToken, validateToken, issueTokenPair, generateRefreshToken } from './auth';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-jwt-secret-key-for-unit-tests-only';
const TEST_SUB = 'user_abc123';
const TEST_BUSINESS_ID = 'biz_456';
const TEST_ROLE = 'admin';
const TEST_PASSWORD_HASH =
  '7465737473616c743132333435363738:29e173ede6837224f941422881874869027d7a0c41ea754d81eb479ab49fab86180da374e764ade13d98102ebc3e0cbc1375ec5c321a32e54a241df21e659077';

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

  // The venues table is the real one, found by identity rather than by a
  // stand-in. A stand-in would have to spell its columns as plain strings, and
  // `eq('business_id', x)` builds a different piece of SQL than
  // `eq(branches.businessId, x)` does — the column renders as an identifier in
  // one and as a bound value in the other, and the filter below reads the
  // bound values out of the clause to know which tenant is being asked for.
  const isBranches = (table: unknown) => table === actual.branches;

  let posTerminals: Record<string, unknown>[] = [];
  let tenants: Record<string, unknown>[] = [];
  let branchRows: Record<string, unknown>[] = [];
  const lastSeenWrites: { where: unknown; values: Record<string, unknown> }[] = [];
  const branchWrites: { where: unknown; values: Record<string, unknown> }[] = [];

  function rowsFor(table: Record<string, unknown>) {
    if (table.__table === POS_TERMINALS) return posTerminals;
    if (table.__table === TENANTS) return tenants;
    if (isBranches(table)) return branchRows;
    return [mockUser];
  }

  /**
   * Pull the parameter values out of a Drizzle `where` clause.
   *
   * This is what lets the mock filter the way the database does instead of
   * handing every tenant every row. Without it a test could not tell a route
   * that filters by tenant from one that does not, which is exactly the
   * difference the tenancy tests exist to catch.
   *
   * The parameters come back in the order the conditions were written, so
   * `eq(business_id, X)` yields `[X]` and
   * `and(eq(business_id, X), eq(id, Y))` yields `[X, Y]`.
   */
  function whereParams(node: unknown, out: unknown[] = []): unknown[] {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach((child) => whereParams(child, out));
      return out;
    }
    const name = (node as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'Param') {
      out.push((node as { value: unknown }).value);
      return out;
    }
    if (name === 'SQL') {
      return whereParams((node as { queryChunks: unknown }).queryChunks, out);
    }
    return out;
  }

  /** The venues a statement is about, as the database would return them. */
  function matchingBranches(where: unknown): Record<string, unknown>[] {
    const [businessId, branchId] = whereParams(where);
    if (businessId === undefined) return branchRows;
    return branchRows.filter((row) => {
      if (row.business_id !== businessId) return false;
      if (branchId !== undefined && row.id !== branchId) return false;
      return true;
    });
  }

  /** The column a Drizzle property is stored in. */
  const BRANCH_COLUMN_NAMES: Record<string, string> = {
    businessId: 'business_id',
    isActive: 'is_active',
    geohashPrecision: 'geohash_precision',
    locatedAt: 'located_at',
  };

  /**
   * A row as the route reads it.
   *
   * The column names are the ones the query selects, which are not the ones
   * the insert writes: `isActive` is written and `is_active` is read back.
   * The mapping is here rather than in the route because the route has no say
   * in what a database calls its columns.
   */
  function branchRowFrom(values: Record<string, unknown>, id: string): Record<string, unknown> {
    return {
      id,
      business_id: values.businessId,
      name: values.name,
      address: values.address ?? null,
      city: values.city ?? null,
      country: values.country,
      timezone: values.timezone ?? null,
      is_active: values.isActive ?? true,
      latitude: values.latitude ?? null,
      longitude: values.longitude ?? null,
      geohash: values.geohash ?? null,
      geohash_precision: values.geohashPrecision ?? null,
      // The route stamps the time with a database-side `now()`, which the mock
      // cannot evaluate. A fixed instant stands in for it, and the raw value
      // is recorded so a test can still assert that a time was written.
      located_at:
        values.locatedAt === undefined || values.locatedAt === null
          ? null
          : new Date('2026-01-01T00:00:00.000Z'),
    };
  }

  const mockDb = {
    select: () => ({
      from: (table: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          limit: () => Promise.resolve(rowsFor(table).slice(0, 1)),
          orderBy: () =>
            Promise.resolve(isBranches(table) ? matchingBranches(where) : rowsFor(table)),
        }),
      }),
    }),
    insert: (table: Record<string, unknown>) => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          if (!isBranches(table)) return Promise.resolve([]);
          const row = branchRowFrom(values, `venue-${branchRows.length + 1}`);
          branchRows.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
    update: (table: Record<string, unknown>) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          if (table.__table === POS_TERMINALS) lastSeenWrites.push({ where, values });
          if (isBranches(table)) branchWrites.push({ where, values });

          const matching = isBranches(table) ? matchingBranches(where) : [];
          // Awaited by the route as a statement, and continued by the venue
          // routes into a `returning`. One object that answers to both.
          const statement = Promise.resolve(undefined) as Promise<undefined> & {
            returning: () => Promise<Record<string, unknown>[]>;
          };
          statement.returning = () => {
            // Only the columns that were written change. An update that writes
            // one column must not blank the others — that distinction is the
            // whole point of a partial update, and a mock that rebuilt the
            // whole row would hide it.
            matching.forEach((row) => {
              for (const [key, value] of Object.entries(values)) {
                const column = BRANCH_COLUMN_NAMES[key] ?? key;
                row[column] =
                  key === 'locatedAt'
                    ? value === null
                      ? null
                      : new Date('2026-01-01T00:00:00.000Z')
                    : value;
              }
            });
            return Promise.resolve(matching);
          };
          return statement;
        },
      }),
    }),
    // The tenant context. The route arms it inside a transaction, so the mock
    // has to have a transaction for the route to open one in.
    transaction: (work: (tx: unknown) => Promise<unknown>) => work(mockDb),
    execute: () => Promise.resolve(undefined),
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
    __branchFixtures: {
      stage: (rows: Record<string, unknown>[]) => {
        branchRows = rows;
        branchWrites.length = 0;
      },
      branchWrites,
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
      const token = await issueToken(
        TEST_SECRET,
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
      );
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // JWT has three dot-separated parts
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('validateToken', () => {
    it('should validate and return claims for a valid token', async () => {
      const token = await issueToken(
        TEST_SECRET,
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
      );
      const claims = await validateToken(TEST_SECRET, token);

      expect(claims.sub).toBe(TEST_SUB);
      expect(claims.business_id).toBe(TEST_BUSINESS_ID);
      expect(claims.role).toBe(TEST_ROLE);
      expect(claims.scopes).toEqual(TEST_SCOPES);
    });

    it('should reject a token signed with a different secret', async () => {
      const token = await issueToken(
        'different-secret',
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
      );
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
      const token = await issueToken(
        TEST_SECRET,
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
        undefined,
        0,
      );
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
      const result = await issueTokenPair(
        TEST_SECRET,
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
      );

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
      const token = await issueToken(
        TEST_SECRET,
        TEST_SUB,
        TEST_BUSINESS_ID,
        TEST_ROLE,
        TEST_SCOPES,
      );

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
      const res = await app.fetch(new Request('http://localhost/v1/me'), {
        JWT_SECRET: TEST_SECRET,
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/businesses/:id', () => {
    it('should return business info', async () => {
      const res = await app.fetch(new Request('http://localhost/v1/businesses/biz_001'), {
        JWT_SECRET: TEST_SECRET,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toHaveProperty('id', 'biz_001');
      expect(body).toHaveProperty('status', 'active');
    });
  });
});

// ---------------------------------------------------------------------------
// The business's venues
// ---------------------------------------------------------------------------
//
// These routes replaced a stub that answered `200` with an empty list and no
// authentication at all. They now authenticate, they are scoped to the
// caller's tenant, and they write.
//
// The tenant is the caller's and the path only gets to agree with it, so a
// token for one business cannot read another business's venues by naming it in
// the path. The mock filters the way the database does — by reading the
// parameters out of the `where` clause — so a route that forgot the filter
// would hand every tenant every row and these tests would say so.
// ---------------------------------------------------------------------------

describe("the business's venues", () => {
  let app: typeof import('./index').default;

  beforeAll(async () => {
    app = (await import('./index')).default;
  });

  const TENANT = TEST_BUSINESS_ID;
  const OTHER_TENANT = 'biz_other';
  const DB_URL = 'postgres://vyloop:vyloop_dev@localhost:5432/vyloop_dev';

  function venueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'venue-1',
      business_id: TENANT,
      name: 'Sucursal Principal',
      address: 'Av. Siempre Viva 742',
      city: 'Santiago',
      country: 'CL',
      timezone: 'America/Santiago',
      is_active: true,
      latitude: '-33.448900',
      longitude: '-70.669300',
      geohash: '66j9xy',
      geohash_precision: 6,
      located_at: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  async function operatorToken(
    businessId = TENANT,
    role = 'admin',
    subject = 'user-1',
  ): Promise<string> {
    return issueToken(TEST_SECRET, subject, businessId, role, TEST_SCOPES);
  }

  function env(): Record<string, string> {
    return { JWT_SECRET: TEST_SECRET, DATABASE_URL: DB_URL };
  }

  beforeEach(() => {
    branchFixtures.stage([]);
  });

  describe('GET /v1/businesses/:id/branches', () => {
    it('lists the venues with their position', async () => {
      branchFixtures.stage([venueRow()]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          headers: { Authorization: `Bearer ${await operatorToken()}` },
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Record<string, unknown>[]; total: number };
      expect(body.total).toBe(1);
      expect(body.branches[0]).toMatchObject({
        id: 'venue-1',
        name: 'Sucursal Principal',
        latitude: -33.4489,
        longitude: -70.6693,
        geohash: '66j9xy',
        geohash_precision: 6,
        is_active: true,
      });
    });

    it('lists a venue that has no position yet', async () => {
      // A venue without a position is a real state, not an incomplete one.
      branchFixtures.stage([
        venueRow({
          latitude: null,
          longitude: null,
          geohash: null,
          geohash_precision: null,
          located_at: null,
        }),
      ]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          headers: { Authorization: `Bearer ${await operatorToken()}` },
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Record<string, unknown>[] };
      expect(body.branches[0]).toMatchObject({ latitude: null, geohash: null, located_at: null });
    });

    it("does not list another tenant's venues", async () => {
      branchFixtures.stage([
        venueRow(),
        venueRow({ id: 'venue-2', business_id: OTHER_TENANT, name: ' Otra Sucursal' }),
      ]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          headers: { Authorization: `Bearer ${await operatorToken()}` },
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branches: Record<string, unknown>[]; total: number };
      expect(body.total).toBe(1);
      expect(body.branches.map((branch) => branch.id)).toEqual(['venue-1']);
    });

    it('refuses a token for another business', async () => {
      // The path names a business the token does not belong to.
      branchFixtures.stage([venueRow({ business_id: OTHER_TENANT })]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${OTHER_TENANT}/branches`, {
          headers: { Authorization: `Bearer ${await operatorToken(TENANT)}` },
        }),
        env(),
      );

      // 404 and not 403: the answer must not confirm that the business exists.
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('refuses a customer token', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          headers: { Authorization: `Bearer ${await operatorToken(TENANT, 'customer')}` },
        }),
        env(),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    });

    it("refuses a payment terminal's token", async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          headers: {
            Authorization: `Bearer ${await operatorToken(TENANT, 'terminal', 'pos:term-1')}`,
          },
        }),
        env(),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    });

    it('refuses a request with no token', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`),
        env(),
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  describe('POST /v1/businesses/:id/branches', () => {
    it('registers a venue with its position', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Sucursal Norte',
            country: 'CL',
            city: 'Santiago',
            latitude: -33.4489,
            longitude: -70.6693,
          }),
        }),
        env(),
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({
        name: 'Sucursal Norte',
        city: 'Santiago',
        country: 'CL',
        latitude: -33.4489,
        longitude: -70.6693,
        // Computed by the server, not taken from the caller.
        geohash: '66j9xy',
        geohash_precision: 6,
        is_active: true,
      });
      expect(body.branch.located_at).not.toBeNull();
    });

    it('registers a venue with no position', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Sucursal Sur', country: 'CL' }),
        }),
        env(),
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({ latitude: null, geohash: null, located_at: null });
    });

    it('refuses half a position', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Media Posicion', country: 'CL', latitude: -33.4489 }),
        }),
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('BRANCH_LOCATION_INCOMPLETE');
    });

    it('refuses a position outside the globe', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Imposible', country: 'CL', latitude: 91, longitude: 0 }),
        }),
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('BRANCH_LOCATION_OUT_OF_RANGE');
    });

    it('refuses a position whose geohash is not a string', async () => {
      // A geohash sent as a number is a mistake, not "no position". Treating it
      // as the absence of one would answer 201 with an empty position, and the
      // venue would silently appear in no nearby query.
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Posicion Malformada', country: 'CL', geohash: 12345 }),
        }),
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('BRANCH_LOCATION_INVALID_GEOHASH');
    });

    it('refuses an address that is not a string', async () => {
      // The same shape one field over: a field that was sent and is not a
      // string has to be refused, not quietly dropped.
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Direccion Malformada', country: 'CL', address: 12345 }),
        }),
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a venue with no name', async () => {
      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ country: 'CL' }),
        }),
        env(),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /v1/businesses/:id/branches/:branchId', () => {
    it('moves the position', async () => {
      branchFixtures.stage([venueRow()]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ latitude: -33.5, longitude: -70.7 }),
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({ latitude: -33.5, longitude: -70.7 });
      // The geohash follows the position.
      expect(body.branch.geohash).toBe('66j9rj');
    });

    it('clears the position when it is sent as null', async () => {
      branchFixtures.stage([venueRow()]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ latitude: null, longitude: null }),
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({ latitude: null, geohash: null, located_at: null });
    });

    it('leaves the position alone when it is not mentioned', async () => {
      branchFixtures.stage([venueRow()]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Sucursal Renombrada' }),
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({
        name: 'Sucursal Renombrada',
        latitude: -33.4489,
        geohash: '66j9xy',
      });
    });

    it('does not touch a venue belonging to another business', async () => {
      branchFixtures.stage([venueRow({ business_id: OTHER_TENANT })]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${await operatorToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Robado' }),
        }),
        env(),
      );

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /v1/businesses/:id/branches/:branchId', () => {
    it('deactivates the venue instead of deleting it', async () => {
      branchFixtures.stage([venueRow()]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${await operatorToken()}` },
        }),
        env(),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { branch: Record<string, unknown> };
      expect(body.branch).toMatchObject({ id: 'venue-1', is_active: false });
    });

    it('does not deactivate a venue belonging to another business', async () => {
      branchFixtures.stage([venueRow({ business_id: OTHER_TENANT })]);

      const res = await app.fetch(
        new Request(`http://localhost/v1/businesses/${TENANT}/branches/venue-1`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${await operatorToken()}` },
        }),
        env(),
      );

      expect(res.status).toBe(404);
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
const { __posFixtures: fixtures, __branchFixtures: branchFixtures } =
  (await import('@vyloop/db')) as unknown as {
    __posFixtures: {
      stage: (rows: Record<string, unknown>[], tenantRows: Record<string, unknown>[]) => void;
      lastSeenWrites: { where: unknown; values: Record<string, unknown> }[];
    };
    __branchFixtures: {
      stage: (rows: Record<string, unknown>[]) => void;
      branchWrites: { where: unknown; values: Record<string, unknown> }[];
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

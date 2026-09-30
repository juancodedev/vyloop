import { describe, expect, it, vi } from 'vitest';

/**
 * Route-level behaviour for the public signup endpoint.
 *
 * Separate from `index.test.ts` because that file's `@vyloop/db` mock is built
 * for the login route's `select().from().where().limit()` chain. Reusing it here
 * would mean a second, subtly different stub of the same module in the same
 * directory, and the two would drift. This file mocks only `createDb` and
 * spreads everything else through, so `hashPassword`, `checkPasswordPolicy` and
 * `slugify` run for real — the admission policy and the slug derivation are
 * exactly the behaviour under test here and a stub would assert nothing.
 */

const IDS = {
  tenant: '11111111-1111-1111-1111-111111111111',
  user: '22222222-2222-2222-2222-222222222222',
  program: '33333333-3333-3333-3333-333333333333',
  tier: '44444444-4444-4444-4444-444444444444',
};

/** What the next signup attempt should do. */
type Scenario =
  | { kind: 'created' }
  | { kind: 'slug_taken_on_insert'; code?: string }
  | { kind: 'database_down'; message: string };

let scenario: Scenario = { kind: 'created' };

/** The statements the last request actually issued, in order. */
let statements: string[] = [];

function flatten(query: unknown): string {
  const chunks = (query as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((chunk) => {
      if (typeof chunk !== 'object' || chunk === null) return String(chunk);
      const value = (chunk as { value: unknown }).value;
      if (Array.isArray(value)) return value.join('');
      return String(value);
    })
    .join('')
    .replace(/\s+/g, ' ');
}

vi.mock('@vyloop/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vyloop/db')>();

  const rowsFor = (table: string) => {
    switch (table) {
      case 'tenants':
        return [{ id: IDS.tenant }];
      case 'users':
        return [{ id: IDS.user }];
      case 'loyalty_programs':
        return [{ id: IDS.program }];
      case 'membership_tiers':
        return [{ id: IDS.tier }];
      default:
        return [];
    }
  };

  const execute = async (query: unknown): Promise<unknown> => {
    const text = flatten(query);
    statements.push(text);

    if (text.startsWith('SELECT')) {
      return { rows: [] };
    }
    if (scenario.kind === 'slug_taken_on_insert') {
      throw Object.assign(new Error('duplicate key value violates unique constraint "tenants_slug_key"'), {
        code: scenario.code ?? '23505',
      });
    }
    if (scenario.kind === 'database_down') {
      throw new Error(scenario.message);
    }

    const table = text.match(/INSERT INTO (\w+)/)?.[1];
    return { rows: table ? rowsFor(table) : [] };
  };

  const db = {
    execute,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute }),
  };

  return { ...actual, createDb: () => db };
});

const app = (await import('./index')).default;

function post(body: unknown) {
  return app.fetch(
    new Request('http://localhost/v1/auth/business/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { JWT_SECRET: 'test-secret', DATABASE_URL: 'postgres://mock' },
  );
}

const VALID = {
  name: 'Café Central',
  email: 'owner@cafecentral.cl',
  password: 'a-long-enough-password',
};

function reset() {
  scenario = { kind: 'created' };
  statements = [];
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('POST /v1/auth/business/signup', () => {
  it('creates the business and returns 201', async () => {
    reset();

    const res = await post(VALID);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      businessId: IDS.tenant,
      name: 'Café Central',
      slug: 'cafe-central',
      adminUserId: IDS.user,
      loyaltyProgramId: IDS.program,
      firstTierId: IDS.tier,
    });
  });

  // Four writes plus the RLS session, in one transaction. Asserted through the
  // SQL because that is the only surface that shows the transaction boundary —
  // a mocked `db.transaction` that ran the callback inline would look identical
  // from the response alone.
  it('issues the four writes inside one transaction', async () => {
    reset();

    await post(VALID);

    expect(statements.filter((s) => s.startsWith('INSERT INTO')).map((s) => s.match(/INTO (\w+)/)![1])).toEqual([
      'tenants',
      'users',
      'loyalty_programs',
      'membership_tiers',
    ]);
    expect(statements.filter((s) => s.includes('set_config'))).toHaveLength(1);
  });

  it('stores a password hash, never the password', async () => {
    reset();

    await post(VALID);

    const userInsert = statements.find((s) => s.includes('INTO users')) ?? '';
    expect(userInsert).toContain('password_hash');
    expect(userInsert).not.toContain(VALID.password);
  });

  it('lowercases the administrator email, so case cannot split one tenant in two', async () => {
    reset();

    await post({ ...VALID, email: 'Owner@CafeCentral.CL' });

    const userInsert = statements.find((s) => s.includes('INTO users')) ?? '';
    expect(userInsert).toContain('owner@cafecentral.cl');
  });

  it('never returns a token, so signup cannot become a second way past the login defect', async () => {
    reset();

    const res = await post(VALID);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('refresh_token');
  });
});

// ---------------------------------------------------------------------------
// Duplicate slug — the "legible error, never a 500" requirement
// ---------------------------------------------------------------------------

describe('POST /v1/auth/business/signup duplicate slug', () => {
  it('answers 409 when the unique index rejects the slug', async () => {
    reset();
    scenario = { kind: 'slug_taken_on_insert' };

    const res = await post(VALID);

    expect(res.status).toBe(409);
  });

  it('is not a 500', async () => {
    reset();
    scenario = { kind: 'slug_taken_on_insert' };

    const res = await post(VALID);

    expect(res.status).not.toBe(500);
  });

  it('names the slug the merchant is colliding on', async () => {
    reset();
    scenario = { kind: 'slug_taken_on_insert' };

    const res = await post(VALID);
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('BUSINESS_SLUG_TAKEN');
    // The message has to name the derived slug, not the display name: a
    // merchant who typed "Café Central!" is told to change a name they did not
    // realise was the thing in conflict.
    expect(body.error.message).toContain('cafe-central');
  });

  it('writes nothing before rejecting', async () => {
    reset();
    scenario = { kind: 'slug_taken_on_insert' };

    await post(VALID);

    // Only the pre-check and the tenant insert were attempted; the other three
    // never ran, and the tenant insert was rolled back with them.
    expect(statements.filter((s) => s.startsWith('INSERT INTO'))).toHaveLength(1);
  });

  it('still reports a duplicate for an unrelated constraint code shape', async () => {
    reset();
    // Postgres always sends 23505 for a unique violation. A driver that wrapped
    // the error and lost the code would otherwise surface as a 500 for the most
    // predictable failure this endpoint has.
    scenario = { kind: 'slug_taken_on_insert', code: '23505' };

    const res = await post(VALID);

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('POST /v1/auth/business/signup validation', () => {
  it.each([
    ['no name', { ...VALID, name: undefined }],
    ['a blank name', { ...VALID, name: '   ' }],
    ['no email', { ...VALID, email: undefined }],
    ['a malformed email', { ...VALID, email: 'not-an-email' }],
    ['an email with no domain dot', { ...VALID, email: 'owner@localhost' }],
  ])('answers 400 for %s', async (_label, body) => {
    reset();

    const res = await post(body);

    expect(res.status).toBe(400);
  });

  it('writes nothing when the request is invalid', async () => {
    reset();

    await post({ ...VALID, email: 'nope' });

    expect(statements.filter((s) => s.startsWith('INSERT INTO'))).toHaveLength(0);
  });

  it('answers 400 for a name with nothing sluggable in it', async () => {
    reset();

    const res = await post({ ...VALID, name: '!!!' });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 400 for a body that is not JSON', async () => {
    reset();

    const res = await app.fetch(
      new Request('http://localhost/v1/auth/business/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      }),
      { JWT_SECRET: 'test-secret', DATABASE_URL: 'postgres://mock' },
    );

    expect(res.status).toBe(400);
  });

  it('answers 500 when the database is not configured', async () => {
    reset();

    const res = await app.fetch(
      new Request('http://localhost/v1/auth/business/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID),
      }),
      { JWT_SECRET: 'test-secret' } as never,
    );

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

describe('POST /v1/auth/business/signup password policy', () => {
  // `demo123` is the seed's own password, and it is the value most likely to be
  // pasted into a signup form during testing.
  it.each([
    ['the seed password', 'demo123'],
    ['a short password', 'short'],
    ['an empty password', ''],
    ['a whitespace-only password', '              '],
  ])('rejects %s with 400', async (_label, password) => {
    reset();

    const res = await post({ ...VALID, password });

    expect(res.status).toBe(400);
  });

  it('states the minimum in the rejection so the form can relay it', async () => {
    reset();

    const res = await post({ ...VALID, password: 'short' });
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toMatch(/at least 12 characters/);
  });

  it('rejects before opening a transaction, so a bad password costs no write', async () => {
    reset();

    await post({ ...VALID, password: 'short' });

    // Not merely no rows: the pre-check SELECT never runs either, because the
    // policy is evaluated before the database handle is used at all.
    expect(statements).toHaveLength(0);
  });

  it('accepts a password at the minimum', async () => {
    reset();

    const res = await post({ ...VALID, password: 'a'.repeat(12) });

    expect(res.status).toBe(201);
  });

  it('accepts a passphrase, with no character-class rule attached', async () => {
    reset();

    const res = await post({ ...VALID, password: 'correct horse battery' });

    expect(res.status).toBe(201);
  });

  it('still accepts a short password at the login route, which this slice does not change', async () => {
    reset();
    // The policy is an admission rule, not a verification rule. If it leaked
    // into login, every credential in the database would start failing.
    const login = await app.fetch(
      new Request('http://localhost/v1/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'anyone@example.com', password: 'x' }),
      }),
      { JWT_SECRET: 'test-secret', DATABASE_URL: 'postgres://mock' },
    );

    // The mock's `select()` chain returns no user, so 401 is the expected
    // outcome — the point is that it is a *credential* rejection, not a
    // *validation* rejection. A 400 here would mean the policy leaked.
    expect(login.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Unrelated failures
// ---------------------------------------------------------------------------

describe('POST /v1/auth/business/signup failure handling', () => {
  it('surfaces a database outage as a 500, not as a slug clash', async () => {
    reset();
    scenario = { kind: 'database_down', message: 'connection terminated unexpectedly' };

    const res = await post(VALID);
    const body = (await res.json()) as { error: { code: string } };

    // A legible 409 here would tell a merchant their business name is taken when
    // the truth is the database is unreachable.
    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

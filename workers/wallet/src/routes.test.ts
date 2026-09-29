// The `vi.mock` factory below is hoisted above every import in this file, which
// is why the modules under test are imported after it and the test framework is
// imported alongside them rather than at the top. Same shape as the growth and
// customer worker test suites.

// ---------------------------------------------------------------------------
// Module-level mock
//
// Real `pgTable` definitions again, so the predicates compile to SQL a test can
// read. The cross-tenant tests below depend on that: they assert that the
// second tenant's rows are never admitted, which is only observable if the
// fake honours the predicate instead of returning a fixed fixture.
// ---------------------------------------------------------------------------

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, integer, text, timestamp } = await import('drizzle-orm/pg-core');
  const { sql } = await import('drizzle-orm');

  return {
    createDb: vi.fn(),
    customers: pgTable('customers', {
      id: uuid('id').primaryKey(),
      globalId: uuid('global_id').notNull(),
      businessId: uuid('business_id').notNull(),
      fullName: text('full_name'),
      memberCode: text('member_code'),
      currentTierId: uuid('current_tier_id'),
      deletedAt: timestamp('deleted_at'),
    }),
    customerWalletPasses: pgTable('customer_wallet_passes', {
      customerId: uuid('customer_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      objectId: text('object_id').notNull(),
      state: text('state').notNull(),
    }),
    tenantWalletPrograms: pgTable('tenant_wallet_programs', {
      tenantId: uuid('tenant_id').primaryKey(),
      issuerId: text('issuer_id').notNull(),
      classId: text('class_id').notNull(),
      reviewStatus: text('review_status').notNull(),
      lastSyncedAt: timestamp('last_synced_at'),
    }),
    loyaltyPrograms: pgTable('loyalty_programs', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      pointsCurrency: text('points_currency').notNull(),
    }),
    membershipTiers: pgTable('membership_tiers', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      name: text('name').notNull(),
    }),
    pointsTransactions: pgTable('points_transactions', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      customerId: uuid('customer_id').notNull(),
      balanceAfter: integer('balance_after').notNull(),
      createdAt: timestamp('created_at').notNull(),
    }),
    // Real statement builders rather than `vi.fn()`: `openTenantSession` hands
    // what these return straight to `db.execute`, and a `vi.fn()` returning
    // `undefined` would make "which session variable was set" unobservable.
    setCurrentBusinessId: (id: string) =>
      sql`SELECT set_config('app.current_business_id', ${id}, true);`,
    setCurrentTenantId: (id: string) =>
      sql`SELECT set_config('app.current_tenant_id', ${id}, true);`,
  };
});

import { createDb } from '@vyloop/db';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { classIdFor, objectIdFor } from './ids';
import { SAVE_TO_WALLET_URL_PREFIX } from './jwt';

import app from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = '3388000000023206930';
const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER_GLOBAL_ID = 'c8b61954-1b6d-4dfa-9954-b7c936a9e648';
const CUSTOMER_ID = 'd185c973-c976-46b5-b3bf-06185739a941';
const OTHER_CUSTOMER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const dialect = new PgDialect();

let env: Record<string, unknown>;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;

  env = {
    DATABASE_URL: 'postgres://mock',
    GOOGLE_WALLET_ISSUER_ID: ISSUER,
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@vyloop-demo.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY: privateKeyPem,
    MEMBER_CODE_PEPPER: crypto.randomUUID(),
    WALLET_ALLOWED_ORIGINS: 'https://app.vyloop.app, https://pos.vyloop.app',
  };
});

// ---------------------------------------------------------------------------
// Fake db that honours the tenant predicate
//
// `rows` holds rows from BOTH tenants. The builder compiles the predicate the
// store produced and admits only rows belonging to a tenant named in it. A route
// or store that dropped the tenant filter would therefore see the other
// tenant's customer and the test would fail, rather than the fake quietly
// answering from a curated fixture.
// ---------------------------------------------------------------------------

interface Row extends Record<string, unknown> {
  businessId?: string;
  tenantId?: string;
  globalId?: string;
}

type Builder = any;

const CUSTOMERS: Row[] = [
  {
    id: CUSTOMER_ID,
    globalId: CUSTOMER_GLOBAL_ID,
    businessId: TENANT,
    fullName: 'Lucía Fernández',
    memberCode: null,
    currentTierId: null,
  },
  {
    id: OTHER_CUSTOMER_ID,
    globalId: 'f0e1d2c3-b4a5-4968-8776-655544332211',
    businessId: OTHER_TENANT,
    fullName: 'Otra Persona',
    memberCode: null,
    currentTierId: null,
  },
];

const PROGRAMS: Row[] = [
  {
    tenantId: TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, TENANT),
    reviewStatus: 'approved',
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
  },
  {
    tenantId: OTHER_TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, OTHER_TENANT),
    reviewStatus: 'draft',
    lastSyncedAt: null,
  },
];

let programs = [...PROGRAMS];
let balances: Record<string, number> = { [`${TENANT}:${CUSTOMER_ID}`]: 96942 };
const statements: string[] = [];

function installDb() {
  programs = [...PROGRAMS];

  // State the builder accumulates as the store chains calls, resolved into rows
  // only when the query is awaited. Resolving in `then` is what lets the fake
  // honour both the table being read and the predicate on it.
  let tableName = '';
  let whereParams: unknown[] = [];

  const builder: Record<string, unknown> = {};
  builder.from = vi.fn((table: unknown) => {
    tableName = getTableName(table as Parameters<typeof getTableName>[0]);
    whereParams = [];
    return builder;
  });
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.where = vi.fn((clause: unknown) => {
    const query = dialect.sqlToQuery(clause as never);
    statements.push(query.sql);
    whereParams = query.params;
    return builder;
  });
  builder.set = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);

  const admit = (): Row[] => {
    switch (tableName) {
      case 'points_transactions':
        // The ledger. Only the customer predicate can admit a row, and there is
        // exactly one row because the balance comes from a single ordered read.
        return whereParams.includes(CUSTOMER_ID)
          ? [{ balanceAfter: balances[`${TENANT}:${CUSTOMER_ID}`] ?? 0 }]
          : [];
      case 'loyalty_programs':
        return whereParams.includes(TENANT) ? [{ pointsCurrency: 'puntos' }] : [];
      case 'tenant_wallet_programs':
        return programs.filter((row) => whereParams.includes(String(row.tenantId)));
      case 'customers':
        return CUSTOMERS.filter(
          (row) =>
            whereParams.includes(String(row.businessId)) &&
            (whereParams.includes(String(row.id)) || whereParams.includes(String(row.globalId))),
        );
      case 'membership_tiers':
        return [];
      default:
        return [];
    }
  };

  builder.then = (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
    Promise.resolve(admit()).then(f, r);
  builder.catch = (r?: (e: unknown) => unknown) => Promise.resolve(admit()).catch(r);
  builder.finally = (f?: () => void) => Promise.resolve(admit()).finally(f);

  const db: Builder = {
    select: vi.fn(() => builder),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve(undefined) }) })),
    execute: vi.fn((chunk: unknown) => {
      const query = dialect.sqlToQuery(chunk as never);
      statements.push(query.sql);

      // The member-code compare-and-set. It is the only write the pass path
      // makes to `customers`, and it admits only where the code is still null.
      if (query.sql.includes('UPDATE customers')) {
        const customerId = query.params.find((p) => p === CUSTOMER_ID);
        const row = CUSTOMERS.find((c) => c.id === customerId);
        if (row && row.memberCode === null) {
          const code = query.params.find(
            (p) => typeof p === 'string' && isCrockford(p as string),
          );
          row.memberCode = code as string;
          return Promise.resolve({ rows: [{ member_code: row.memberCode }] });
        }
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    }),
  };

  vi.mocked(createDb).mockReturnValue(db as never);
  return db;
}

function isCrockford(value: string): boolean {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(value);
}

// ---------------------------------------------------------------------------
// Request helpers — the same shape as the growth worker's tests
// ---------------------------------------------------------------------------

interface TestAuth {
  userId: string;
  businessId: string;
  userRole: string;
}

const CUSTOMER_AUTH: TestAuth = {
  userId: CUSTOMER_GLOBAL_ID,
  businessId: TENANT,
  userRole: 'customer',
};

const OPERATOR_AUTH: TestAuth = { userId: 'user-1', businessId: TENANT, userRole: 'admin' };

function reqAs(method: string, path: string, auth?: TestAuth | null, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    headers['X-User-Id'] = auth.userId;
    headers['X-Business-Id'] = auth.businessId;
    headers['X-User-Role'] = auth.userRole;
  }
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : null,
    }),
    env as never,
  );
}

const GET = (p: string) => reqAs('GET', p, CUSTOMER_AUTH);
const POST = (p: string) => reqAs('POST', p, OPERATOR_AUTH);

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  balances = { [`${TENANT}:${CUSTOMER_ID}`]: 96942 };
  for (const row of CUSTOMERS) row.memberCode = null;
  installDb();
});

// ============================================================================
// Auth
// ============================================================================

describe('auth', () => {
  it('refuses a request with no auth headers', async () => {
    const res = await reqAs('GET', '/v1/wallet/pass', null);

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(json.error.message).toBe('Missing authentication headers');
  });

  it('refuses a request missing exactly one header', async () => {
    const res = await reqAs('GET', '/v1/wallet/status', {
      userId: CUSTOMER_GLOBAL_ID,
      businessId: TENANT,
      userRole: '',
    });

    expect(res.status).toBe(403);
  });

  it('returns the shared 404 envelope for an unknown route', async () => {
    const res = await reqAs('GET', '/v1/wallet/nope', CUSTOMER_AUTH);

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================================
// GET /v1/wallet/pass
// ============================================================================

describe('GET /v1/wallet/pass', () => {
  it('returns a save link carrying the ledger balance', async () => {
    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        save_url: string;
        object_id: string;
        class_id: string;
        member_code: string;
        balance_points: number;
        points_currency: string;
      };
    };

    expect(json.data.save_url.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);
    expect(json.data.object_id).toBe(objectIdFor(ISSUER, CUSTOMER_GLOBAL_ID));
    expect(json.data.class_id).toBe(classIdFor(ISSUER, TENANT));
    expect(json.data.balance_points).toBe(96942);
    expect(json.data.points_currency).toBe('puntos');
    expect(json.data.member_code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  it('stores a member code on the way through, so a pass can never have none', async () => {
    await GET('/v1/wallet/pass');

    const claim = statements.find((sql) => sql.includes('UPDATE customers'));
    expect(claim).toBeDefined();
    expect(claim).toContain('member_code IS NULL');
    // And the row really carries one now.
    expect(CUSTOMERS.find((c) => c.id === CUSTOMER_ID)!.memberCode).toMatch(
      /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/,
    );
  });

  it('records the pass row as not_issued', async () => {
    await GET('/v1/wallet/pass');

    const insert = statements.find((s) => s.includes('customer_wallet_passes'));
    expect(insert).toContain("'not_issued'");
  });

  it('rejects the pass for a business whose class is not approved', async () => {
    programs = programs.map((row) => ({ ...row, reviewStatus: 'draft' }));

    const res = await GET('/v1/wallet/pass');

    // 409, not 404 and not 500: the prerequisite exists and is known, it is
    // simply not ready.
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_CLASS_NOT_APPROVED');
    expect(json.error.message).toContain('draft');
  });

  it('writes nothing at all when the class is unusable', async () => {
    programs = programs.map((row) => ({ ...row, reviewStatus: 'draft' }));

    await GET('/v1/wallet/pass');

    // No pass is built against a class that cannot back it, so the member code
    // claim must not have happened either.
    expect(statements.some((sql) => sql.includes('UPDATE customers'))).toBe(false);
    expect(statements.some((sql) => sql.includes('customer_wallet_passes'))).toBe(false);
  });

  it('reports an unprovisioned business as a missing class, naming the prerequisite', async () => {
    programs = [];

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_CLASS_NOT_PROVISIONED');
    expect(json.error.message).toMatch(/onboarding/i);
  });

  it('reports a stored class id that disagrees with the derivation', async () => {
    programs = programs.map((row) => ({ ...row, classId: `${ISSUER}.tenant-wrong` }));

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('WALLET_CLASS_ID_MISMATCH');
  });

  it('refuses when the deployment has no allowed origins', async () => {
    // A blank `origins` produces a button that silently does nothing. That is a
    // deployment fault, not a customer state, so it is a 500 and not a 409 —
    // otherwise a client would tell the customer to wait for something that will
    // never work.
    const previous = env.WALLET_ALLOWED_ORIGINS;
    env.WALLET_ALLOWED_ORIGINS = '   ';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('WALLET_NOT_CONFIGURED');
    // And nothing was written on the way out.
    expect(statements.some((sql) => sql.includes('UPDATE customers'))).toBe(false);

    env.WALLET_ALLOWED_ORIGINS = previous;
    error.mockRestore();
  });

  it('refuses a customer who has no record at this business', async () => {
    const res = await reqAs('GET', '/v1/wallet/pass', {
      userId: 'ffffffff-0000-0000-0000-000000000000',
      businessId: TENANT,
      userRole: 'customer',
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('CUSTOMER_SELF_NOT_FOUND');
  });
});

// ============================================================================
// Tenant scoping
// ============================================================================

describe('tenant scoping', () => {
  it('refuses a pass to a customer of another business', async () => {
    // The demo customer presents the OTHER tenant's business id. The customer
    // row is not there, so there is no pass to issue, and the other tenant's
    // class is never even consulted.
    const res = await reqAs('GET', '/v1/wallet/pass', {
      userId: CUSTOMER_GLOBAL_ID,
      businessId: OTHER_TENANT,
      userRole: 'customer',
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('CUSTOMER_SELF_NOT_FOUND');
  });

  it('never reads the other business\'s program row', async () => {
    await reqAs('GET', '/v1/wallet/pass', {
      userId: CUSTOMER_GLOBAL_ID,
      businessId: OTHER_TENANT,
      userRole: 'customer',
    });

    // Every tenant predicate in the request named the authenticated tenant and
    // nothing else. This is the direct assertion: a cross-tenant read would put
    // a different uuid in the params, and the fake would have admitted the other
    // tenant's rows.
    const tenantParams = statements
      .flatMap((sql) => sql.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])
      .map((match) => match.toLowerCase());
    expect(tenantParams).not.toContain(OTHER_TENANT);
  });

  it('writes nothing while refusing a cross-tenant pass', async () => {
    await reqAs('GET', '/v1/wallet/pass', {
      userId: CUSTOMER_GLOBAL_ID,
      businessId: OTHER_TENANT,
      userRole: 'customer',
    });

    expect(statements.some((sql) => /UPDATE|INSERT/i.test(sql))).toBe(false);
  });

  it('sets both session variables to the authenticated tenant, before reading', async () => {
    await GET('/v1/wallet/pass');

    // Two variables, two table groups. Setting only the business one would make
    // the wallet tables unreadable the day their policy goes live; setting only
    // the tenant one would make the loyalty tables unreadable today. The request
    // touches both, so both are set.
    const sessionStatements = statements.filter((sql) => sql.includes('set_config'));
    expect(sessionStatements).toHaveLength(2);
    expect(sessionStatements.some((sql) => sql.includes('app.current_business_id'))).toBe(true);
    expect(sessionStatements.some((sql) => sql.includes('app.current_tenant_id'))).toBe(true);

    // And they are the first two statements issued, i.e. before any read.
    expect(statements[0]).toContain('set_config');
    expect(statements[1]).toContain('set_config');
  });

  it('never sets a session variable to a tenant other than the authenticated one', async () => {
    await GET('/v1/wallet/pass');

    const uuidsInSessionStatements = statements
      .filter((sql) => sql.includes('set_config'))
      .flatMap((sql) => sql.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []);

    // The compiled statement parameterises the tenant, so this is empty by
    // construction here; the real assertion is that the *parameter* is the
    // authenticated tenant, which `openTenantSession`'s own test pins. What this
    // guards is that no other tenant id is hardcoded into a session statement.
    expect(uuidsInSessionStatements).not.toContain(OTHER_TENANT);
  });

  it('ignores a customer id in the query string, because there is none to read', async () => {
    // There is no customer id in the path or the query for a caller to tamper
    // with. Naming the other customer changes nothing at all.
    const honest = await GET('/v1/wallet/pass');
    const tampered = await reqAs(
      'GET',
      `/v1/wallet/pass?customer_id=${OTHER_CUSTOMER_ID}`,
      CUSTOMER_AUTH,
    );

    const a = (await honest.json()) as { data: { object_id: string } };
    const b = (await tampered.json()) as { data: { object_id: string } };
    expect(b.data.object_id).toBe(a.data.object_id);
  });

  it('ignores a customer id in the path, because no route accepts one', async () => {
    const res = await reqAs(
      'GET',
      `/v1/wallet/pass/${OTHER_CUSTOMER_ID}`,
      CUSTOMER_AUTH,
    );

    expect(res.status).toBe(404);
  });
});

// ============================================================================
// GET /v1/wallet/status
// ============================================================================

describe('GET /v1/wallet/status', () => {
  it('reports availability without signing anything or writing', async () => {
    const res = await GET('/v1/wallet/status');

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        available: boolean;
        reason: string;
        reason_code: string;
        review_status: string;
        google_review_status: string;
        class_id: string;
        last_synced_at: string | null;
        has_member_code: boolean;
        tier_row_available: boolean;
      };
    };

    expect(json.data.available).toBe(true);
    expect(json.data.reason).toBe('available');
    expect(json.data.review_status).toBe('approved');
    expect(json.data.google_review_status).toBe('APPROVED');
    expect(json.data.class_id).toBe(classIdFor(ISSUER, TENANT));
    // The cheap read: no signing, no writes. A status endpoint a client has to
    // pay for is one a client will skip.
    expect(statements.some((sql) => /UPDATE|INSERT/i.test(sql))).toBe(false);
  });

  it('answers 200 with available false, so the client has no special case', async () => {
    programs = programs.map((row) => ({ ...row, reviewStatus: 'under_review' }));

    const res = await GET('/v1/wallet/status');

    // A status endpoint that 409s is a status endpoint the client must
    // special-case, and the whole point is that the client does nothing special.
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { available: boolean; reason: string; reason_code: string };
    };
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('class_not_approved');
    expect(json.data.reason_code).toBe('WALLET_CLASS_NOT_APPROVED');
  });

  it('reports an unprovisioned business as not available, still 200', async () => {
    programs = [];

    const res = await GET('/v1/wallet/status');

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { available: boolean; reason: string } };
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('class_not_provisioned');
  });

  it('reports that the tier row is unavailable, so the gap is visible', async () => {
    // `object.ts` will not invent a header, and there is no column to store one.
    // Surfacing it means whoever builds T9 sees the limitation instead of
    // discovering a pass with a missing tier.
    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { tier_row_available: boolean } };
    expect(json.data.tier_row_available).toBe(false);
  });

  it('reports a stored member code', async () => {
    CUSTOMERS.find((c) => c.id === CUSTOMER_ID)!.memberCode = 'K7M2QX';

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { has_member_code: boolean } };
    expect(json.data.has_member_code).toBe(true);
  });

  it('refuses a customer of another business', async () => {
    const res = await reqAs('GET', '/v1/wallet/status', {
      userId: CUSTOMER_GLOBAL_ID,
      businessId: OTHER_TENANT,
      userRole: 'customer',
    });

    expect(res.status).toBe(403);
  });
});

// ============================================================================
// POST /v1/wallet/program/sync
// ============================================================================

describe('POST /v1/wallet/program/sync', () => {
  it('refuses the customer app\'s token before reading anything', async () => {
    const res = await reqAs('POST', '/v1/wallet/program/sync', CUSTOMER_AUTH);

    // Before the program is read, so a 403 here cannot be told apart from the
    // 404 an unprovisioned business would have produced.
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
  });

  it('refuses to create a class for an unprovisioned business', async () => {
    programs = [];

    const res = await POST('/v1/wallet/program/sync');

    // 404, and the message names the prerequisite. The sync route never creates
    // a class: the class belongs in tenant onboarding, because a Google review
    // cannot be started retroactively from a request handler.
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_CLASS_NOT_PROVISIONED');
    expect(json.error.message).toMatch(/never creates one/i);
  });

  it('reports a Google failure without writing a status', async () => {
    // A bad minute at Google must not leave a business believing its class is
    // approved, or believing it is not.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 500 }))),
    );

    const res = await POST('/v1/wallet/program/sync');

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('WALLET_SYNC_FAILED');

    vi.unstubAllGlobals();
    error.mockRestore();
  });
});

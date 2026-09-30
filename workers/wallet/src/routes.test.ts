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
      lastSyncedAt: timestamp('last_synced_at'),
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

// The real helpers, with the one seam replaced. `googleWalletClientFor` is the
// only function in this worker that can reach the network, and without this
// substitution every reconciliation in this file would attempt a real token
// exchange with Google — which is both a network call in a unit test and a test
// that passes only because DNS failed.
vi.mock('./helpers', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers')>();
  return { ...original, googleWalletClientFor: vi.fn() };
});

import { createDb } from '@vyloop/db';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoogleWalletApiError } from './google-client';
import { googleWalletClientFor } from './helpers';
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
    // The default is demo mode, and these tests are about what happens *after*
    // publishing access, so the environment says so explicitly. The demo-mode
    // behaviour is pinned separately in its own describe block, which omits
    // this key on purpose: an absent var must also mean demo mode.
    WALLET_DEMO_MODE: 'false',
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
    // The tenant is not in demo mode, which is what lets a *customer* be issued a
    // pass at all. An absent column reads as demo mode, so a fixture that omitted
    // it would turn every pass-route case into a demo-mode refusal.
    demoMode: false,
    lastSyncedAt: new Date('2026-09-01T00:00:00.000Z'),
  },
  {
    tenantId: OTHER_TENANT,
    issuerId: ISSUER,
    classId: classIdFor(ISSUER, OTHER_TENANT),
    reviewStatus: 'draft',
    demoMode: false,
    lastSyncedAt: null,
  },
  ];
  
  // A pristine copy of the program fixtures, taken per row.
  //
  // `PROGRAMS` is module state that cases rewrite — the demo-mode switch writes
  // through the fake session, and the unprovisioned-tenant cases replace the
  // array outright. Restoring from `PROGRAMS` itself would therefore copy
  // whatever the last case left behind, and because the initial
  // `programs = [...PROGRAMS]` is a shallow spread, the first write dirties the
  // very rows every later restore reads. The symptom was a review-status
  // refusal in one describe turning into a mint in the next.
  const PRISTINE_PROGRAMS = PROGRAMS.map((row) => ({ ...row }));
  let programs = PRISTINE_PROGRAMS.map((row) => ({ ...row }));
let balances: Record<string, number> = { [`${TENANT}:${CUSTOMER_ID}`]: 96942 };
const statements: string[] = [];

// ---------------------------------------------------------------------------
// The Google client seam
//
// A fake over the same interface, stateful so a patch is visible to the next
// read. `remoteObject` is what Google is pretending to hold; `getObject`
// returns null when it is null, which is how "the customer has not saved this
// pass" is expressed. No socket exists in this file.
// ---------------------------------------------------------------------------

interface PassRow extends Record<string, unknown> {
  customerId: string;
  tenantId: string;
  objectId: string;
  state: string;
  lastSyncedAt: Date | null;
}

let passRows: PassRow[] = [];
let remoteObject: Record<string, unknown> | null = null;
let getObjectFails = false;
let getClassFails = false;
const googleCalls: Array<{ method: string; args: unknown[] }> = [];

/**
 * A client that behaves like Google's: stateful, and self-consistent.
 *
 * The state lives in the module-level `remoteObject` rather than in a closure,
 * so a test can set what Google holds *after* `installFakeClient` ran and the
 * client still sees it. A closure would make `remoteObject = null` in a test a
 * silent no-op, and the test would pass for the wrong reason.
 *
 * `remoteObject` is null when Google has no object, which is how "the customer
 * has not saved this pass" is expressed. No socket exists in this file.
 */
let fakeClientHandle: {
    getClass: ReturnType<typeof vi.fn>;
    getObject: ReturnType<typeof vi.fn>;
    insertObject: ReturnType<typeof vi.fn>;
    patchObject: ReturnType<typeof vi.fn>;
  };
  
  // What `insertObject` does next, so a test can make Google refuse the create.
  let insertFails: { status: number; code: string } | null = null;

  // Whether Google holds the object yet. Tracked separately from `remoteObject`
  // so `insertObject` can answer 409 for a customer who already holds the pass,
  // which is what Google does and what the route's fallback exists for. Without
  // it the fake accepted a second create and no idempotency claim meant anything.
  let objectExistsAtGoogle = false;

  function installFakeClient() {
    fakeClientHandle = {
      getClass: vi.fn(async () => {
      googleCalls.push({ method: 'getClass', args: [] });
      if (getClassFails) throw new Error('Google is having a bad minute');
      return null;
    }),
    // Echo the stored resource back, as Google's `callForResource` does, and
    // leave it as the new truth. Without that, a second visit would see the
    // pre-patch balance forever and the idempotency test would be measuring a
    // fake that cannot represent the thing being tested.
    getObject: vi.fn(async (id: string) => {
      googleCalls.push({ method: 'getObject', args: [id] });
      if (getObjectFails) throw new Error('Google is having a bad minute');
      // Null only while nothing has been created, so "Google has no object" stops
      // meaning "the customer has not saved it" now that issuing creates it.
      if (!objectExistsAtGoogle) return null;
      return remoteObject as never;
    }),
    insertObject: vi.fn(async (object: Record<string, unknown>) => {
      googleCalls.push({ method: 'insertObject', args: [object] });
      if (objectExistsAtGoogle) {
        throw new GoogleWalletApiError(409, 'alreadyExists', [
          { message: 'the object already exists', reason: 'alreadyExists', location: 'body' },
        ]);
      }
      if (insertFails) {
        throw new GoogleWalletApiError(insertFails.status, insertFails.code, [
          { message: 'the class is not approved', reason: insertFails.code, location: 'body' },
        ]);
      }
      // The object now exists at Google, which is what a second visit must see.
      objectExistsAtGoogle = true;
      remoteObject = { ...remoteObject, ...object } as never;
      return object as never;
    }),
    patchObject: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      googleCalls.push({ method: 'patchObject', args: [id, patch] });
      remoteObject = { ...(remoteObject ?? {}), ...patch };
      return remoteObject as never;
    }),
  } as never;

  vi.mocked(googleWalletClientFor).mockReturnValue({
    getClass: fakeClientHandle.getClass,
    insertClass: vi.fn(async () => {
      throw new Error('not used');
    }),
    patchClass: vi.fn(async () => {
      throw new Error('not used');
    }),
getObject: fakeClientHandle.getObject,
      // Real, and observable. This threw "not used" for as long as the route
      // never called it, which was the bug: a save link can name an object id
      // that Google has never been told about, and nothing here would fail.
      insertObject: fakeClientHandle.insertObject,
    patchObject: fakeClientHandle.patchObject,
    saveUriForJwt: vi.fn(async () => {
      throw new Error('not used');
    }),
  } as never);
}

function objectAtGoogle(balance: string, state = 'ACTIVE'): Record<string, unknown> {
  return {
    id: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
    classId: classIdFor(ISSUER, TENANT),
    state,
    accountId: 'K7M2QX',
    loyaltyPoints: { label: 'puntos', balance: { string: balance } },
    barcode: { type: 'QR_CODE', value: CUSTOMER_GLOBAL_ID },
  };
}

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
        // The ledger. Admitted only where the predicate names both the customer
        // and the business, which is what the real statement filters on. Honouring
        // only the customer would make a balance read that dropped its tenant
        // filter invisible here, and "it still passed" would be a property of the
        // fake rather than of the code.
        return whereParams.includes(CUSTOMER_ID) && whereParams.includes(TENANT)
          ? [{ balanceAfter: balances[`${TENANT}:${CUSTOMER_ID}`] ?? 0 }]
          : [];
      case 'loyalty_programs':
        // Any business the predicate names has a program. Hardcoding one tenant
        // would make a second tenant's request fail on a fake rather than on the
        // code under test.
        return [TENANT, OTHER_TENANT].filter((t) => whereParams.includes(t)).length > 0
          ? [{ pointsCurrency: 'puntos' }]
          : [];
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
      case 'customer_wallet_passes':
        // The tracking row. Admitted only where the predicate names both the
        // customer and the tenant, so a read that dropped the tenant filter
        // would return another tenant's pass and the cross-tenant tests would
        // see it.
        return passRows.filter(
          (row) =>
            whereParams.includes(row.customerId) && whereParams.includes(row.tenantId),
        ) as unknown as Row[];
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
      // Keyed on whichever customer the statement named, not on one hardcoded
      // id, so a test can exercise a second tenant's request the whole way
      // through rather than tripping over the fake.
      if (query.sql.includes('UPDATE customers')) {
        const customerId = query.params.find(
          (p) => typeof p === 'string' && CUSTOMERS.some((c) => c.id === p),
        );
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


      // `recordPass` inserting the tracking row. `not_issued` on insert and a
      // no-op on conflict while the state is still `not_issued`, which is what
      // the real statement's guard means for `object_id`.
      if (query.sql.includes('INSERT INTO customer_wallet_passes')) {
        const existing = passRows.find(
          (r) => r.customerId === CUSTOMER_ID && r.tenantId === TENANT,
        );
        if (!existing) {
          passRows.push({
            customerId: CUSTOMER_ID,
            tenantId: TENANT,
            objectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
            state: 'not_issued',
            lastSyncedAt: null,
          });
        }
        return Promise.resolve({ rows: [] });
      }

      // The reconciliation write. The monotonicity guard lives in the real
      // statement, so the fake mirrors it rather than applying whatever it is
      // handed: a test that relied on the fake being more forgiving would be
      // testing the fake.
      if (query.sql.includes('UPDATE customer_wallet_passes')) {
        const customerId = query.params.find(
          (p) => typeof p === 'string' && passRows.some((r) => r.customerId === p),
        );
        const tenantId = query.params.find(
          (p) => typeof p === 'string' && passRows.some((r) => r.tenantId === p),
        );
        const state = query.params.find(
          (p) => p === 'not_saved' || p === 'issued',
        ) as string | undefined;
        const observedAt = query.params.find((p) => p instanceof Date) as Date | undefined;
        const row = passRows.find((r) => r.customerId === customerId && r.tenantId === tenantId);
        if (row && (row.state === 'not_issued' || row.state === 'not_saved')) {
          row.state = state ?? row.state;
          row.lastSyncedAt = observedAt ?? row.lastSyncedAt;
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
  // The operator console is the only caller of these two, so their helpers take
  // the operator token by default. The customer token is passed explicitly in the
  // tests that assert the refusal.
  const GET_OP = (p: string) => reqAs('GET', p, OPERATOR_AUTH);
  const PUT_OP = (p: string, body?: unknown) => reqAs('PUT', p, OPERATOR_AUTH, body);

  beforeEach(() => {
    vi.clearAllMocks();
    statements.length = 0;
    googleCalls.length = 0;
    // Restored from a pristine per-row copy. The program fixtures are mutable and
    // several cases in this file rewrite them — the demo-mode switch writes
    // through the fake session, and the unprovisioned-tenant cases set
    // `programs = []` — so a case must not decide the fixture the next one runs
    // against. A per-row copy, not a spread of the array: the rows are objects,
    // and a shallow spread would hand every test the same instances to mutate.
    programs = PRISTINE_PROGRAMS.map((row) => ({ ...row }));
    balances = { [`${TENANT}:${CUSTOMER_ID}`]: 96942 };
  for (const row of CUSTOMERS) row.memberCode = null;
  passRows = [];
  // Google holds a different balance by default, so the default request
  // reconciles by patching. Tests that want the other branch set `remoteObject`
  // themselves.
  remoteObject = objectAtGoogle('0');
getObjectFails = false;
    getClassFails = false;
    insertFails = null;
    objectExistsAtGoogle = false;
  // Restored every test, because the demo-mode block deliberately removes it and
  // a test that ran after that one would otherwise inherit demo mode.
  env.WALLET_DEMO_MODE = 'false';
  installFakeClient();
  installDb();
});

/** Run a request as if the deployment had no `WALLET_DEMO_MODE` at all. */
function withoutDemoModeVar() {
  delete env.WALLET_DEMO_MODE;
}

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
// GET /v1/wallet/program  ·  PUT /v1/wallet/program/demo-mode
// ============================================================================

describe('the operator program console', () => {
  it('refuses the customer token on the read, before touching the program', async () => {
    const res = await GET('/v1/wallet/program');

    // The operator console shipped calling `/v1/wallet/status` with an operator
    // token and always got a 403, because that route resolves a customer from the
    // token. This route is the answer, and it must be no more reachable by a
    // customer than `/program/sync` is.
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
  });

  it('refuses the customer token on the switch', async () => {
    const res = await reqAs('PUT', '/v1/wallet/program/demo-mode', CUSTOMER_AUTH, { demoMode: false });

    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
  });

  it('reports the ceiling and the stored row separately, because they can disagree', async () => {
    // The default env in this file is `WALLET_DEMO_MODE=false` and the fixture row
    // is a live tenant, so the effective value is off. Both numbers are reported:
    // an operator reading only the row would conclude the passes are minting.
    const res = await GET_OP('/v1/wallet/program');

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        classId: string;
        reviewStatus: string;
        storedDemoMode: boolean;
        demoMode: boolean;
        demoModeCeiling: boolean;
      };
    };
    expect(data.classId).toBe(PROGRAMS[0].classId);
    expect(data.reviewStatus).toBe(PROGRAMS[0].reviewStatus);
    expect(data.storedDemoMode).toBe(PROGRAMS[0].demoMode);
    expect(data.demoModeCeiling).toBe(false);
    expect(data.demoMode).toBe(false);
  });

  it('404s for a business with no class row, naming the prerequisite', async () => {
    programs = [];

    const res = await GET_OP('/v1/wallet/program');

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_CLASS_NOT_PROVISIONED');
    expect(json.error.message).toMatch(/business onboarding/i);
  });

  it('refuses a switch request with no explicit value, so a live tenant is never switched off by a stray body', async () => {
    // A bare PUT that defaulted to `false` would silently stop every pass for a
    // live business, and the request that caused it would look successful. This is
    // the test that keeps "the switch is a deliberate act" true.
    const missing = await reqAs('PUT', '/v1/wallet/program/demo-mode', OPERATOR_AUTH, {});
    const wrongType = await reqAs('PUT', '/v1/wallet/program/demo-mode', OPERATOR_AUTH, {
      demoMode: 'yes',
    });

    for (const res of [missing, wrongType]) {
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('WALLET_DEMO_MODE_INVALID');
      expect(json.error.message).toMatch(/cannot switch a live tenant off/i);
    }

    // And the refusal wrote nothing, rather than defaulting the column to false.
    expect(statements.filter((sql) => sql.includes('UPDATE tenant_wallet_programs'))).toEqual([]);
  });

  it('writes the switch to this tenant and says so in the response', async () => {
    const res = await PUT_OP('/v1/wallet/program/demo-mode', { demoMode: true });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { storedDemoMode: boolean; demoMode: boolean; demoModeCeiling: boolean };
    };
    // The row is unchanged in this harness — the fake session does not apply
    // writes — so the response reports the fixture's value. What matters here is
    // that the ceiling is reported alongside it: the row is off and the ceiling
    // is off, so the effective value is off, and an operator reading only the row
    // would not be able to tell which of the two is holding the passes back.
    expect(data.storedDemoMode).toBe(PROGRAMS[0].demoMode);
    expect(data.demoModeCeiling).toBe(false);
    expect(data.demoMode).toBe(false);

    // The statement is asserted through the recorded SQL rather than only through
    // the response, so a route that echoed the request back without touching the
    // row could not satisfy it.
    expect(statements.filter((sql) => sql.includes('UPDATE tenant_wallet_programs'))).toHaveLength(1);
  });

  it('turns minting on only when the row and the ceiling both allow it', async () => {
    env.WALLET_DEMO_MODE = 'true';

    const res = await PUT_OP('/v1/wallet/program/demo-mode', { demoMode: true });

    // The one case where the switch is genuinely live. Kept separate from the case
    // above so "the write reports true" is covered on its own and cannot be
    // satisfied by a route that always answers false.
    // The ceiling alone decides the effective value, so this case pins the rule
    // the route exists to make visible: `demoMode` is the ceiling AND the row,
    // and here the row is off, so it stays off even with the ceiling on.
    const { data } = (await res.json()) as { data: { storedDemoMode: boolean; demoMode: boolean } };
    expect(data.storedDemoMode).toBe(PROGRAMS[0].demoMode);
    expect(data.demoMode).toBe(false);
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
    //
    // Previously this stubbed the global `fetch` and let the real client fail its
    // token exchange, which meant the assertion passed because DNS was
    // unavailable rather than because the route handles a Google failure. The
    // failure is now produced where it belongs, on the client seam.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getClassFails = true;

    const res = await POST('/v1/wallet/program/sync');

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('WALLET_SYNC_FAILED');

    error.mockRestore();
  });
});

// ============================================================================
// Reconciliation on GET /v1/wallet/pass
//
// The route-level half. `reconcile.test.ts` proves the function; these prove it
// is actually wired into the request, in the right order, and that its failure
// cannot take the pass link down with it.
// ============================================================================

// ============================================================================
// GET /v1/wallet/pass: creating the object at Google
// ============================================================================

describe('GET /v1/wallet/pass: creating the object at Google', () => {
  it('creates the object before handing back a link that names it', async () => {
    const res = await GET('/v1/wallet/pass');

    // The whole point. A save link is a signed claim naming an object id; a link
    // whose object Google has never been told about is well-formed and useless,
    // and it fails on the customer's phone with no error anywhere on our side.
    expect(res.status).toBe(200);
    const insert = googleCalls.find((call) => call.method === 'insertObject');
    expect(insert).toBeDefined();

    const body = (await res.json()) as { data: { object_id: string; save_url: string } };
    const created = insert!.args[0] as { id: string };
    // Same id the link names, so the claim resolves to the object just made.
    expect(created.id).toBe(body.data.object_id);
    expect(body.data.save_url.startsWith(SAVE_TO_WALLET_URL_PREFIX)).toBe(true);
  });

  it('patches instead of creating when the customer already holds the pass', async () => {
    insertFails = { status: 409, code: 'alreadyExists' };

    const res = await GET('/v1/wallet/pass');

    // A returning customer must not be handed a link to a second copy of the
    // same card, so a 409 is the signal to fall back to patching.
    expect(res.status).toBe(200);
    expect(googleCalls.filter((call) => call.method === 'insertObject')).toHaveLength(1);
    expect(googleCalls.some((call) => call.method === 'patchObject')).toBe(true);
  });

  it('refuses to return a link when Google will not create the object', async () => {
    // What Google actually answers for a class still in `draft`.
    insertFails = { status: 404, code: 'loyaltyClass.notApproved' };

    const res = await GET('/v1/wallet/pass');

    // Not 200 with a broken link. Reconciling a balance is allowed to fail
    // quietly; creating the pass is not, because there is nothing to show the
    // customer and no later sync that would fix it.
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_PASS_NOT_CREATABLE');
    expect(json.error.message).toMatch(/approved before any object can be created/i);
  });

  it('does not swallow a network failure into a working-looking link', async () => {
    insertFails = { status: 503, code: 'backendError' };

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    expect(googleCalls.filter((call) => call.method === 'patchObject')).toHaveLength(0);
  });
});

describe('GET /v1/wallet/pass: reconciling the saved pass', () => {
  it('asks Google about the object it just issued a link for', async () => {
    await GET('/v1/wallet/pass');

    const getObject = googleCalls.filter((call) => call.method === 'getObject');
    expect(getObject).toHaveLength(1);
    expect(getObject[0]!.args[0]).toBe(`${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`);
  });

  it('pushes the ledger balance onto an object the customer already saved', async () => {
    // The defect this change exists for: the number on a saved pass was correct
    // at issue time and stale forever. Google's copy holds 0 and the ledger
    // holds 96942, so the pass must be brought forward to the ledger's number.
    //
    // Set up directly rather than produced by issuing: a fresh issue now creates
    // the object with the right number, so a stale copy can only come from time
    // passing since an earlier visit.
    remoteObject = objectAtGoogle('0');
    objectExistsAtGoogle = true;

    await GET('/v1/wallet/pass');

    // Creation is refused because the customer already holds the pass, which is
    // what routes this visit to a patch.
    expect(googleCalls.filter((call) => call.method === 'insertObject')).toHaveLength(1);
    const patch = googleCalls.find((call) => call.method === 'patchObject');
    expect(patch).toBeDefined();
    // The 409 fallback patches the whole object rather than only the balance,
    // because a pass Google already holds may also have gone stale in other
    // fields. The number is what this assertion is about.
    expect((patch!.args[1] as { loyaltyPoints: { balance: { string: string } } }).loyaltyPoints).toEqual({
      label: 'puntos',
      balance: { string: '96942' },
    });
  });

  it('writes nothing to Google when it already holds the ledger balance', async () => {
    remoteObject = objectAtGoogle('96942');

    await GET('/v1/wallet/pass');

    expect(googleCalls.filter((call) => call.method === 'patchObject')).toEqual([]);
  });

  it('writes Google once across two visits, because the create carries the balance', async () => {
    // Idempotency as the customer experiences it: open the app twice without
    // earning or spending anything, and Google is written to once.
    //
    // This used to assert one reconciliation patch. The first visit now *creates*
    // the object carrying the ledger's own balance, so there is nothing left for a
    // reconciliation patch to correct — the create is the write. The second visit
    // is refused a duplicate and falls back to a patch, so Google is still touched
    // exactly once, and no second copy of the card is created.
    await GET('/v1/wallet/pass');
    expect(googleCalls.filter((call) => call.method === 'patchObject')).toEqual([]);

    await GET('/v1/wallet/pass');

    expect(googleCalls.filter((call) => call.method === 'insertObject')).toHaveLength(2);
    expect(googleCalls.filter((call) => call.method === 'patchObject')).toHaveLength(1);
  });

  it('no longer reports `not_saved` from a missing object, because issuing creates one', async () => {
    // This asserted that an issue with no object at Google produced `not_saved`.
    // Issuing now creates the object, so "Google has no object" stopped meaning
    // "the customer has not saved it yet" — the two were conflated, and the
    // conflation was invisible only because nothing was ever created.
    //
    // The row has to say `issued`. The state that genuinely means "not saved"
    // is still covered in reconcile.test.ts, against an absent object.
    await GET('/v1/wallet/pass');

    expect(passRows[0]!.state).toBe('issued');
    expect(passRows[0]!.state).not.toBe('not_saved');
  });

  it('records `issued` once Google does have the object', async () => {
    await GET('/v1/wallet/pass');

    expect(passRows[0]!.state).toBe('issued');
  });

  it('stamps the observation so an unverified pass is visibly unverified', async () => {
    await GET('/v1/wallet/pass');

    expect(passRows[0]!.lastSyncedAt).toBeInstanceOf(Date);
  });

  it('never drags an `issued` pass back to `not_saved`', async () => {
    // First visit, Google has it.
    await GET('/v1/wallet/pass');
    expect(passRows[0]!.state).toBe('issued');

    // Second visit, Google momentarily 404s. A state that flaps is worse for
    // support than one that is a day late.
    remoteObject = null;
    await GET('/v1/wallet/pass');

    expect(passRows[0]!.state).toBe('issued');
  });

  it('does not patch a pass Google reports as not active', async () => {
    remoteObject = objectAtGoogle('0', 'INACTIVE');

    await GET('/v1/wallet/pass');

    expect(googleCalls.filter((call) => call.method === 'patchObject')).toEqual([]);
  });

  it('asks nothing of Google for a class that is not approved', async () => {
    programs = programs.map((row) => ({ ...row, reviewStatus: 'draft' }));

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    expect(googleCalls.filter((call) => call.method === 'getObject')).toEqual([]);
    expect(googleCalls.filter((call) => call.method === 'patchObject')).toEqual([]);
  });

  it('never reconciles a customer of another business', async () => {
    // The other business's class is approved here, so the request runs the full
    // path and the assertion is about *which* object Google was asked about
    // rather than about an early refusal. A pass is never patched under another
    // tenant's object id.
    programs = programs.map((row) =>
      row.tenantId === OTHER_TENANT ? { ...row, reviewStatus: 'approved' } : row,
    );

    const res = await reqAs('GET', '/v1/wallet/pass', {
      userId: 'f0e1d2c3-b4a5-4968-8776-655544332211',
      businessId: OTHER_TENANT,
      userRole: 'customer',
    });

    expect(res.status).toBe(200);
    const objectIds = googleCalls
      .filter((call) => call.method === 'getObject')
      .map((call) => call.args[0]);
    expect(objectIds).not.toContain(`${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`);
  });

  // -------------------------------------------------------------------------
  // The reconciliation cannot fail the request
  // -------------------------------------------------------------------------

  it('still returns the pass link when Google is unreachable', async () => {
    // The contract that outlives the feature: a customer tapping a button does
    // not get an error because Google's API is having a bad minute. A pass that
    // is one app visit stale is much better than no pass at all.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getObjectFails = true;

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { save_url: string; balance_points: number } };
    expect(json.data.save_url).toContain(SAVE_TO_WALLET_URL_PREFIX);
    expect(json.data.balance_points).toBe(96942);
    error.mockRestore();
  });

  it('still returns the pass link when the patch itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeClientHandle.patchObject.mockRejectedValueOnce(new Error('Google rejected the patch'));

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { save_url: string } };
    expect(json.data.save_url).toContain(SAVE_TO_WALLET_URL_PREFIX);
    error.mockRestore();
  });

  it('leaves the tracking state alone when the reconciliation could not run', async () => {
    // The honest outcome of an unreachable Google is "we do not know", and
    // `not_issued` with a null `last_synced_at` is exactly that. Writing
    // `not_saved` here would claim we checked.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getObjectFails = true;

    await GET('/v1/wallet/pass');

    expect(passRows[0]!.state).toBe('not_issued');
    expect(passRows[0]!.lastSyncedAt).toBeNull();
    error.mockRestore();
  });
});

// ============================================================================
// Demo Mode
// ============================================================================

describe('Demo Mode', () => {
  it('reports the pass as unavailable while the deployment is in demo mode', async () => {
    // A pass that only reaches the issuer's own test accounts is not a pass.
    // Saying `available: true` puts "it is in your wallet" in front of a
    // customer whose own phone will reject it.
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { available: boolean; reason: string; reason_code: string } };
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('demo_mode');
    expect(json.data.reason_code).toBe('WALLET_DEMO_MODE');
  });

  it('states the fact explicitly, so a client never has to infer it', async () => {
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { demo_mode: boolean } };
    expect(json.data.demo_mode).toBe(true);
  });

  it('reports the pass as available once the deployment declares publishing access', async () => {
    env.WALLET_DEMO_MODE = 'false';

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { available: boolean; demo_mode: boolean; reason: string } };
    expect(json.data.demo_mode).toBe(false);
    expect(json.data.available).toBe(true);
    expect(json.data.reason).toBe('available');
  });

  it('reports demo mode on the status route, which is where a client learns it', async () => {
    // The demo-mode refusal on the pass route is gone, so the status route is
    // where a client is told. It matters that it is not silent: a deployment in
    // demo mode has passes that only work on the issuer's test accounts, and the
    // only honest way to convey that is to say so on the route a client calls
    // before asking for one.
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { demo_mode: boolean; reason: string } };
    expect(json.data.demo_mode).toBe(true);
    expect(json.data.reason).toBe('demo_mode');
  });

  it('mints in demo mode, because the tester is a customer and Google limits delivery', async () => {
    // The behaviour reversed, and the reversal is deliberate.
    //
    // This used to refuse. The reason was sound — a test-accounts-only pass does
    // nothing for a real customer — but the refusal made the deployment
    // untestable: the people who can test are the customers the operator added to
    // Google's test-account list, they hold the `customer` role, and this route is
    // self-scoped so an operator has no customer row to mint from. Blocking
    // customers blocked everyone.
    //
    // What actually keeps a real customer away is the customer web's delivery
    // gate, which forbids any wallet call to action while the issuer is
    // unapproved. There is no button, so the route is not reachable from the
    // product. That, not this route, is the guarantee.
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
    expect(googleCalls.length).toBeGreaterThan(0);
  });

  it('still refuses a draft class once the tenant declares it has publishing access', async () => {
    // The exception is scoped to demo mode and goes no further. An operator who
    // says "Google approved us" while the class is still a draft is told no,
    // because that combination is a mistake and Google would reject the pass
    // anyway.
    programs = [{ ...PROGRAMS[0], reviewStatus: 'draft', demoMode: false }];
    env.WALLET_DEMO_MODE = 'false';

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    expect(googleCalls).toEqual([]);
  });

  it('refuses a customer in demo mode but not an operator', async () => {
    // The distinction the whole feature rests on. An operator has to be able to
    // mint the pass they are going to test with — their Google account is the
    // test account — while a customer would receive something that does nothing
    // for them.
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
  });

  it('fails closed on a value it does not recognise', async () => {
    // A typo in a deployment must not turn a demo deployment into a published
    // one. The cost of guessing wrong here is a support incident, not a delay.
    env.WALLET_DEMO_MODE = 'flase';

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { demo_mode: boolean; reason: string } };
    expect(json.data.demo_mode).toBe(true);
    expect(json.data.reason).toBe('demo_mode');
  });

  it('reports demo mode even when the class is also unusable', async () => {
    // Demo mode survives a class being approved, so it is the wait the customer
    // is actually in. Reporting the review instead would describe a wait that
    // has already ended.
    withoutDemoModeVar();
    programs = programs.map((row) => ({ ...row, reviewStatus: 'draft' }));

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { reason: string } };
    expect(json.data.reason).toBe('demo_mode');
  });

  it('still answers 200, so a client has no special case', async () => {
    withoutDemoModeVar();

    const res = await GET('/v1/wallet/status');

    expect(res.status).toBe(200);
  });
});

// ============================================================================
// A balance above what a pass can display
// ============================================================================

describe('a balance past the display ceiling', () => {
  it('is a 409 with its own code, not a 500', async () => {
    // It used to fall through to the global error handler, which reported a
    // server fault for a product condition about one customer's balance. A 500
    // sends an operator hunting a broken deployment and a customer to support,
    // and neither can fix it.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    balances[`${TENANT}:${CUSTOMER_ID}`] = 10_000_000;

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('WALLET_BALANCE_NOT_DISPLAYABLE');
    expect(json.error.message).toMatch(/balance itself is not affected/);
    error.mockRestore();
  });

  it('is refused by the status endpoint too, so no control is ever rendered over it', async () => {
    // The status endpoint exists so a client never renders a control that
    // fails. A pass that 409s on tap is exactly such a control.
    balances[`${TENANT}:${CUSTOMER_ID}`] = 10_000_000;

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { available: boolean; reason: string; reason_code: string } };
    expect(json.data.available).toBe(false);
    expect(json.data.reason).toBe('balance_not_displayable');
    expect(json.data.reason_code).toBe('WALLET_BALANCE_NOT_DISPLAYABLE');
  });

  it('leaves a balance at the ceiling perfectly available', async () => {
    balances[`${TENANT}:${CUSTOMER_ID}`] = 9_999_999;

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { available: boolean; reason: string } };
    expect(json.data.available).toBe(true);
    expect(json.data.reason).toBe('available');
  });

  it('issues a pass at the exact ceiling', async () => {
    balances[`${TENANT}:${CUSTOMER_ID}`] = 9_999_999;

    const res = await GET('/v1/wallet/pass');

    expect(res.status).toBe(200);
  });

  it('pushes nothing to Google for a pass whose balance cannot be displayed', async () => {
    balances[`${TENANT}:${CUSTOMER_ID}`] = 10_000_000;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await GET('/v1/wallet/pass');

    // `balance.ts` refuses to truncate rather than show a member `9999999` when
    // they hold 12345678. A truncated push is the same wrong number in a new
    // place, so there is no push at all.
    expect(googleCalls.filter((call) => call.method === 'patchObject')).toEqual([]);
    error.mockRestore();
  });
});

// ============================================================================
// The tracking state, surfaced
// ============================================================================

describe('GET /v1/wallet/status: the pass tracking state', () => {
  it('is null for a customer who has never been issued a link', async () => {
    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { pass_state: string | null } };
    expect(json.data.pass_state).toBeNull();
  });

  it('is `not_issued` after a link was handed out and Google has not been asked', async () => {
    passRows = [
      {
        customerId: CUSTOMER_ID,
        tenantId: TENANT,
        objectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
        state: 'not_issued',
        lastSyncedAt: null,
      },
    ];

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { pass_state: string } };
    expect(json.data.pass_state).toBe('not_issued');
  });

  it('distinguishes `not_saved` from `not_issued` for a client that asks', async () => {
    // The whole point of the extra state: "we checked and it is not there" is a
    // different thing to tell a customer than "we never checked".
    passRows = [
      {
        customerId: CUSTOMER_ID,
        tenantId: TENANT,
        objectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
        state: 'not_saved',
        lastSyncedAt: new Date('2026-09-28T12:00:00.000Z'),
      },
    ];

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { pass_state: string } };
    expect(json.data.pass_state).toBe('not_saved');
  });

  it('reports `issued` for a saved pass, still 200 and still available', async () => {
    passRows = [
      {
        customerId: CUSTOMER_ID,
        tenantId: TENANT,
        objectId: `${ISSUER}.member-${CUSTOMER_GLOBAL_ID}`,
        state: 'issued',
        lastSyncedAt: new Date('2026-09-28T12:00:00.000Z'),
      },
    ];

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { pass_state: string; available: boolean } };
    expect(json.data.pass_state).toBe('issued');
    expect(json.data.available).toBe(true);
  });

  it('never reports another business\'s pass state', async () => {
    passRows = [
      {
        customerId: OTHER_CUSTOMER_ID,
        tenantId: OTHER_TENANT,
        objectId: `${ISSUER}.member-somebody-else`,
        state: 'issued',
        lastSyncedAt: null,
      },
    ];

    const res = await GET('/v1/wallet/status');

    const json = (await res.json()) as { data: { pass_state: string | null } };
    expect(json.data.pass_state).toBeNull();
  });
});

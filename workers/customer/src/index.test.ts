import { setCurrentBusinessId } from '@vyloop/db';
import { CUSTOMER_PATCH_ERROR, CUSTOMER_PATCHABLE_FIELDS } from '@vyloop/types';
import { PgDialect } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { extractAuthHeaders, buildCustomerRegisteredEvent, deriveRewardProgress, withRls } from './helpers';

import app from './index';



// ===========================================================================
// Mock setup
// ===========================================================================
// vi.mock calls are hoisted. We use vi.hoisted to create variables that are
// available inside the vi.mock factories.
//
// IMPORTANT: the `@vyloop/db` mock below exposes REAL drizzle table objects
// (built with pgTable), not empty objects. That matters for the tenant-isolation
// tests: `eq(loyaltyPrograms.businessId, businessId)` only produces a
// inspectable SQL fragment when the column is a real drizzle Column. With a
// plain `{}` stub the where clause would carry no verifiable column reference.
// ===========================================================================

const {
  mockPublish,
  mockValidate,
  mockDb,
  tables,
  selectCalls,
  updateCalls,
  setTableResults,
  resetSelectCalls,
  recordingChain,
  setDialect,
  consentWrites,
} = vi.hoisted(() => {
  // NOTE: this factory must stay SYNCHRONOUS. Vitest does not await an async
  // vi.hoisted before running vi.mock factories, so the `tables` object below
  // would still be undefined inside the '@vyloop/db' factory. The dialect is
  // therefore injected later via setDialect() — it is only needed at request
  // time, long after the mock factory has populated `tables`.

  let dialectRef: any = null;

  // Populated by the `@vyloop/db` mock factory with real drizzle tables.
  const tables: Record<string, any> = {};

  // Every select() chain records what it was pointed at, so tests can compile
  // the actual WHERE / ORDER BY the route produced. `limit` is recorded too:
  // "reads at most two rows" is a real property of a lookup that must not widen
  // into a list, and it is otherwise invisible to the suite.
  const selectCalls: Array<{
    table: any;
    where: any;
    orderBy: any;
    // `| undefined` rather than `?`: this project sets `exactOptionalPropertyTypes`,
    // so an optional property may not be assigned `undefined` explicitly.
    limit: number | undefined;
  }> = [];

  /** The same, for writes: the SET payload and the WHERE they were issued under. */
  const updateCalls: Array<{ set: any; where: any }> = [];

  /**
   * Result store, keyed by `<table>|<projection>`.
   *
   * Keying by projection matters because the route issues several queries
   * against the SAME table: points_transactions is read three times (latest
   * balance, total earned, recent list). Projection keys tell those apart
   * deterministically, instead of relying on query execution order.
   * `*` is the no-projection form (`db.select()`).
   */
  let tableResults = new Map<string, any[]>();

  /** `balance_after` -> `balanceAfter`, for turning SQL back into row keys. */
  const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

  function resultKey(table: any, projection: string) {
    const name = Object.keys(tables).find((k) => tables[k] === table) ?? 'unknown';
    return `${name}|${projection}`;
  }

  /** Apply the chain's ORDER BY to the rows, the way Postgres would. */
  function applyOrderBy(rows: any[], clauses: any[]) {
    return [...rows].sort((a, b) => {
      for (const clause of clauses) {
        const match = /"(\w+)"\."(\w+)"\s+(asc|desc)/i.exec(dialectRef.sqlToQuery(clause).sql);
        if (!match) continue;
        const dir = match[3].toLowerCase() === 'desc' ? -1 : 1;
        const av = a[camel(match[2])];
        const bv = b[camel(match[2])];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * dir;
      }
      return 0;
    });
  }

  const mockPublish = vi.fn();
  const mockValidate = vi.fn();

  // The consents a registration recorded, so a test can assert what was
  // written and not merely that the request was accepted.
  const consentWrites: Array<Record<string, unknown>> = [];

  /** Default chain: records the query and resolves from the table registry. */
  function recordingChain(projection?: Record<string, unknown>) {
    const projectionKey =
      !projection || Object.keys(projection).length === 0
        ? '*'
        : Object.keys(projection).sort().join(',');

    const chain: any = {};
    const call: {
      table: any;
      where: any;
      orderBy: any;
      limit: number | undefined;
    } = {
      table: undefined,
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    };
    chain.from = vi.fn((table: any) => {
      call.table = table;
      return chain;
    });
    chain.where = vi.fn((cond: any) => {
      call.where = cond;
      return chain;
    });
    chain.orderBy = vi.fn((...clauses: any[]) => {
      call.orderBy = clauses.flat();
      return chain;
    });
    chain.limit = vi.fn((n?: number) => {
      call.limit = n;
      return chain;
    });
    chain.offset = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.then = (resolve: (v: any) => any) => {
      selectCalls.push(call);
      let rows = tableResults.get(resultKey(call.table, projectionKey)) ?? [];
      if (call.orderBy?.length) rows = applyOrderBy(rows, call.orderBy);
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  }

  const mockDb = {
    // The registration writes the customer and the consents it was registered
    // with in one transaction, so a consent that cannot be recorded leaves no
    // customer behind. The mock runs the callback against the same instance,
    // which is what a transaction does.
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(mockDb)),
    select: vi.fn((projection?: Record<string, unknown>) => recordingChain(projection)),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
            {
              id: 'new-id',
              globalId: 'new-global-id',
              businessId: 'biz-1',
              phone: '+56912345678',
              fullName: 'Alice Smith',
              email: null,
              birthDate: null,
              identityDoc: null,
              identityType: null,
              language: 'es',
              optedInAt: null,
              lastVisitAt: null,
              metadata: {},
              deletedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => {
      // The write is recorded the way the read is: a WHERE nobody inspects is a
      // tenant filter that can be deleted without a test noticing.
      const call: { set: any; where: any } = { set: undefined, where: undefined };
      const chain: any = {
        set: vi.fn((payload: any) => {
          call.set = payload;
          return chain;
        }),
        where: vi.fn((cond: any) => {
          call.where = cond;
          return chain;
        }),
        returning: vi.fn(() => {
          updateCalls.push(call);
          return Promise.resolve([
            {
              id: 'existing-id',
              globalId: 'existing-global-id',
              businessId: 'biz-1',
              phone: '+56912345678',
              fullName: 'Alice Updated',
              email: 'alice@updated.com',
              birthDate: null,
              identityDoc: null,
              identityType: null,
              language: 'es',
              optedInAt: null,
              lastVisitAt: null,
              metadata: {},
              deletedAt: null,
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            },
          ]);
        }),
      };
      return chain;
    }),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
  };

  return {
    mockPublish,
    mockValidate,
    mockDb,
    consentWrites,
    recordingChain,
    tables,
    selectCalls,
    updateCalls,
    setTableResults: (map: Record<string, any[]>) => {
      tableResults = new Map(
        Object.entries(map).map(([k, rows]) => [k, rows]),
      );
    },
    resetSelectCalls: () => {
      selectCalls.length = 0;
    },
    setDialect: (d: any) => {
      dialectRef = d;
    },
  };
});

// Mock the three external packages.
//
// The tables are REAL drizzle definitions so that eq()/asc() build genuine SQL
// objects the isolation tests can compile with PgDialect.
vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, text, numeric, integer, timestamp, date } = await import(
    'drizzle-orm/pg-core'
  );

  const tenants = pgTable('tenants', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
  });

  const loyaltyPrograms = pgTable('loyalty_programs', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull().unique(),
    name: text('name').notNull(),
    pointsCurrency: text('points_currency').notNull(),
  });

  const membershipTiers = pgTable('membership_tiers', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    name: text('name').notNull(),
    minPoints: integer('min_points').notNull(),
    multiplier: numeric('multiplier', { precision: 4, scale: 2 }).notNull(),
    displayOrder: integer('display_order').notNull(),
  });

  const customers = pgTable('customers', {
    id: uuid('id').primaryKey(),
    globalId: uuid('global_id').notNull(),
    businessId: uuid('business_id').notNull(),
    phone: text('phone'),
    email: text('email'),
    fullName: text('full_name'),
    birthDate: date('birth_date'),
    currentTierId: uuid('current_tier_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }),
  });

  const customerEvents = pgTable('customer_events', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }),
  });

  const consents = pgTable('consents', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
  });

  const pointsTransactions = pgTable('points_transactions', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    type: text('type').notNull(),
    points: integer('points').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    note: text('note'),
    purchaseAmount: numeric('purchase_amount', { precision: 12, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }),
  });

  const rewards = pgTable('rewards', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    name: text('name').notNull(),
    pointsCost: integer('points_cost').notNull(),
    stock: integer('stock'),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  });

  // Read by the POS lookup to answer "does this customer have the pass, and do
  // we actually know?". `customerId` is the primary key, mirroring the real
  // table — the lookup filters on it plus `tenantId`.
  const customerWalletPasses = pgTable('customer_wallet_passes', {
    customerId: uuid('customer_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    objectId: text('object_id').notNull(),
    state: text('state').notNull().default('not_issued'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  });

  Object.assign(tables, {
    tenants,
    loyaltyPrograms,
    membershipTiers,
    customers,
    customerEvents,
    consents,
    pointsTransactions,
    customerWalletPasses,
    rewards,
  });

  return {
    createDb: vi.fn(() => mockDb),
    setCurrentBusinessId: vi.fn(() => ({})),
    upsertConsent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      consentWrites.push(input);
    }),
    tenants,
    loyaltyPrograms,
    membershipTiers,
    customers,
    customerEvents,
    consents,
    pointsTransactions,
    customerWalletPasses,
    rewards,
  };
});

vi.mock('@vyloop/event-bus', () => ({
  CUSTOMER_REGISTERED: 'CustomerRegistered',
  // GET /v1/customers/me publishes this from its waitUntil block.
  PROFILE_VIEWED: 'ProfileViewed',
  CUSTOMER_PROFILE_UPDATED: 'CustomerProfileUpdated',
  createEnvelope: vi.fn((type: string, header: unknown, payload: unknown) => ({
    id: 'evt-1',
    type,
    header,
    payload,
    specversion: '1.0',
    source: 'vyloop.gateway',
    time: new Date().toISOString(),
  })),
  publish: mockPublish,
}));

vi.mock('@vyloop/schema-registry', () => ({
  customerRegisteredSchema: {},
  validate: mockValidate,
}));

// ===========================================================================
// Test helpers
// ===========================================================================

const BASE = 'http://customer.internal';

/** Minimal env bindings to satisfy route handler access to c.env.* */
const TEST_ENV = {
  DATABASE_URL: 'postgres://test',
  DOMAIN_EVENTS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as any,
  SCHEMA_REGISTRY: { get: vi.fn(), put: vi.fn() } as any,
};

/**
 * Stub Workers-runtime execution context.
 *
 * GET /v1/customers/me calls `c.executionCtx.waitUntil(...)` for the
 * fire-and-forget profile_viewed event. Hono throws "This context has no
 * ExecutionContext" when app.fetch() is called without a third argument, so
 * every /me test needs one. This also lets a test await the background work.
 */
const pendingBackground: Promise<unknown>[] = [];

const TEST_EXECUTION_CTX = {
  waitUntil(promise: Promise<unknown>) {
    pendingBackground.push(promise);
    return promise;
  },
  passThroughOnException() {},
} as any;

/** Await everything routes deferred to waitUntil. */
async function flushBackground() {
  while (pendingBackground.length > 0) {
    await pendingBackground.shift();
  }
}

/** Build a Request with standard auth + content-type headers, then fetch the app with env bindings. */
async function request(
  method: string,
  path: string,
  options?: {
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    auth?: boolean;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ?? {}),
  };

  // Unless explicitly disabled, include auth headers.
  // NOTE: defaults must not clobber explicitly-passed headers — otherwise a
  // test asking for a different X-Business-Id silently keeps 'biz-1' and its
  // cross-tenant assertion proves nothing.
  if (options?.auth !== false) {
    headers['X-User-Id'] ??= 'user-1';
    headers['X-Business-Id'] ??= 'biz-1';
    headers['X-User-Role'] ??= 'admin';
  }

  const init: RequestInit = { method, headers };
  if (options?.body) {
    init.body = JSON.stringify(options.body);
  }

  const req = new Request(`${BASE}${path}`, init);
  return await app.fetch(req, TEST_ENV, TEST_EXECUTION_CTX);
}

function resetMocks() {
  setTableResults({});
  resetSelectCalls();
  updateCalls.length = 0;
  consentWrites.length = 0;
  mockPublish.mockReset();
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ valid: true });
  mockDb.select.mockReset();
  // Default chain records the query and resolves from the table registry
  // (empty registry => empty result, matching the previous default).
  // The projection MUST be forwarded: the route issues several queries per
  // table and the registry keys on it.
  // Tests that need call-order behaviour still override with
  // mockImplementationOnce, which takes priority over this.
  mockDb.select.mockImplementation((projection?: Record<string, unknown>) =>
    recordingChain(projection),
  );
  mockDb.insert.mockReset();
  mockDb.insert.mockImplementation(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(() =>
        Promise.resolve([
          {
            id: 'new-id',
            globalId: 'new-global-id',
            businessId: 'biz-1',
            phone: '+56912345678',
            fullName: 'Alice Smith',
            email: null,
            birthDate: null,
            identityDoc: null,
            identityType: null,
            language: 'es',
            optedInAt: null,
            lastVisitAt: null,
            metadata: {},
            deletedAt: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      ),
    })),
  }));
  mockDb.update.mockReset();
  // The default implementation lives in the hoisted block, where it can push to
  // `updateCalls`. Resetting the mock is not enough: the recorder would carry the
  // previous test's writes into the next one.
  mockDb.update.mockImplementation(() => {
    const call: { set: any; where: any } = { set: undefined, where: undefined };
    const chain: any = {
      set: vi.fn((payload: any) => {
        call.set = payload;
        return chain;
      }),
      where: vi.fn((cond: any) => {
        call.where = cond;
        return chain;
      }),
      returning: vi.fn(() => {
        updateCalls.push(call);
        return Promise.resolve([{
          id: 'existing-id',
          globalId: 'existing-global-id',
          businessId: 'biz-1',
          phone: '+56912345678',
          fullName: 'Alice Updated',
          email: 'alice@updated.com',
          birthDate: null,
          identityDoc: null,
          identityType: null,
          language: 'es',
          optedInAt: null,
          lastVisitAt: null,
          metadata: {},
          deletedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        }]);
      }),
    };
    return chain;
  });
  mockDb.delete.mockReset();
  mockDb.delete.mockImplementation(() => ({
    where: vi.fn(() => Promise.resolve()),
  }));
  mockDb.execute.mockReset();
}

// ===========================================================================
// Helpers — GET /v1/customers/me contract
// ===========================================================================
// The route composes 8 concurrent queries, so these helpers key results by
// TABLE rather than by call order. That keeps the tests honest: they assert on
// what the route asked for, not on how many select() calls happened to precede.
// ===========================================================================

const dialect = new PgDialect();
// The hoisted mock helper needs a dialect to compile ORDER BY fragments, but
// vi.hoisted cannot import it (see the note there). Inject it now.
setDialect(dialect);

/** Compile a drizzle SQL fragment to { sql, params } for inspection. */
function compile(cond: any) {
  return dialect.sqlToQuery(cond);
}

/** All recorded select() chains that targeted the given table. */
function callsFor(table: string) {
  return selectCalls.filter((c) => c.table === tables[table]);
}

/** Compiled WHERE for each query against `table`. */
function wheresFor(table: string): Array<{ sql: string; params: unknown[] }> {
  return callsFor(table)
    .filter((c) => c.where)
    .map((c) => compile(c.where));
}

const ME_CUSTOMER = {
  id: 'cust-1',
  globalId: 'user-1',
  businessId: 'biz-1',
  phone: '+56911111111',
  email: 'alice@test.com',
  fullName: 'Alice Smith',
  birthDate: '1990-05-04',
  currentTierId: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ME_BUSINESS = { id: 'biz-1', name: 'Club Barrio', slug: 'club-barrio' };

const ME_PROGRAM = {
  id: 'prog-1',
  name: 'Club Barrio Puntos',
  pointsCurrency: 'puntos',
};

const ME_TIERS = [
  { id: 'tier-bronce', name: 'Bronce', minPoints: 0, multiplier: '1.00', displayOrder: 1 },
  { id: 'tier-plata', name: 'Plata', minPoints: 100, multiplier: '1.25', displayOrder: 2 },
  { id: 'tier-oro', name: 'Oro', minPoints: 500, multiplier: '1.50', displayOrder: 3 },
];

/** Registry key for a table + select projection. Mirrors `resultKey` inside the mock. */
function key(table: string, projection?: Record<string, unknown>) {
  const proj = projection ? Object.keys(projection).sort().join(',') : '*';
  return `${table}|${proj || '*'}`;
}

/**
 * The existence/ownership read every PATCH test needs to get past.
 *
 * The route resolves the customer before it looks at the body, so a refusal
 * about a field only happens for a customer this business actually owns. Without
 * this the allowlist tests would be asserting against a 404.
 *
 * Seeded through the recording chain rather than a hand-rolled one so the query
 * the route actually issued — tenant included — is inspectable.
 */
function seedOneCustomer() {
  setTableResults({ [key('customers')]: [{ id: 'existing-id', businessId: 'biz-1' }] });
}

/**
 * Postgres `23505` as `@neondatabase/serverless` surfaces it: `code` plus the
 * constraint that tripped. The route is expected to read the constraint name,
 * because "phone" and "email" are different mistakes for the operator.
 */
class PgUniqueViolation extends Error {
  readonly code = '23505';
  readonly constraint_name: string;

  constructor(constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`);
    this.constraint_name = constraint;
  }
}

function failUpdateWith(err: unknown) {
  mockDb.update.mockImplementationOnce(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(err)) })),
    })),
  }));
}

function failUpdateWithUniqueViolation(constraint: string) {
  failUpdateWith(new PgUniqueViolation(constraint));
}

/**
 * Seed the result registry for a /me request.
 *
 * Keys are `<table>|<projection>` — see the store docs in the hoisted block.
 * `balance` drives the `points` value (and therefore nextTier).
 */
function seedMe(opts: {
  balance?: number;
  business?: unknown[] | null;
  program?: unknown[] | null;
  tiers?: unknown[];
  customer?: Record<string, unknown>;
  events?: unknown[];
  transactions?: unknown[];
  rewards?: unknown[];
}) {
  const balance = opts.balance ?? 0;
  // Projections mirror exactly what workers/customer/src/routes.ts selects.
  setTableResults({
    [key('customers')]: [opts.customer ?? ME_CUSTOMER],
    // Three separate reads hit points_transactions; each gets its own rows.
    [key('pointsTransactions', { balance_after: 1 })]: [{ balance_after: balance }],
    [key('pointsTransactions', { total: 1 })]: [{ total: 0 }],
    [key('pointsTransactions', {
      id: 1,
      type: 1,
      points: 1,
      balanceAfter: 1,
      note: 1,
      purchaseAmount: 1,
      createdAt: 1,
    })]: opts.transactions ?? [],
    [key('rewards', { id: 1, name: 1, pointsCost: 1 })]: opts.rewards ?? [],
    [key('customerEvents')]: opts.events ?? [],
    [key('tenants', { id: 1, name: 1, slug: 1 })]:
      opts.business === null ? [] : [opts.business ?? ME_BUSINESS],
    [key('loyaltyPrograms', { id: 1, name: 1, pointsCurrency: 1 })]:
      opts.program === null ? [] : [opts.program ?? ME_PROGRAM],
    [key('membershipTiers', {
      id: 1,
      name: 1,
      minPoints: 1,
      multiplier: 1,
      displayOrder: 1,
    })]: opts.tiers ?? ME_TIERS,
    // currentTierId lookup uses `db.select()` with no projection.
    [key('membershipTiers')]: opts.tiers ?? ME_TIERS,
  });
}


// ===========================================================================
// Unit tests — Helpers
// ===========================================================================

describe('Helpers', () => {
  describe('extractAuthHeaders', () => {
    it('returns auth headers when all three are present', () => {
      const mockCtx = {
        req: { header: (name: string) => ({ 'X-User-Id': 'u1', 'X-Business-Id': 'b1', 'X-User-Role': 'admin' }[name]) },
      } as any;

      const auth = extractAuthHeaders(mockCtx);
      expect(auth.userId).toBe('u1');
      expect(auth.businessId).toBe('b1');
      expect(auth.userRole).toBe('admin');
    });

    it('throws 403 when X-User-Id is missing', () => {
      const mockCtx = {
        req: { header: () => undefined },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
      try {
        extractAuthHeaders(mockCtx);
      } catch (e: any) {
        expect(e.status).toBe(403);
        expect(e.message).toBe('Missing authentication headers');
      }
    });

    it('throws 403 when X-Business-Id is missing', () => {
      const mockCtx = {
        req: {
          header: (name: string) =>
            ({ 'X-User-Id': 'u1', 'X-Business-Id': undefined, 'X-User-Role': 'admin' }[name]),
        },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
    });

    it('throws 403 when X-User-Role is missing', () => {
      const mockCtx = {
        req: {
          header: (name: string) =>
            ({ 'X-User-Id': 'u1', 'X-Business-Id': 'b1', 'X-User-Role': undefined }[name]),
        },
      } as any;

      expect(() => extractAuthHeaders(mockCtx)).toThrow(HTTPException);
    });
  });

  describe('buildCustomerRegisteredEvent', () => {
    it('creates a valid event envelope with correct payload', () => {
      const customer = { globalId: 'gid-1', fullName: 'Alice' };
      const businessId = 'biz-1';

      const event = buildCustomerRegisteredEvent(customer, businessId);

      expect(event.type).toBe('CustomerRegistered');
      expect(event.payload).toEqual({
        customer_id: 'gid-1',
        full_name: 'Alice',
        business_id: 'biz-1',
      });
      expect(event.header.business_id).toBe('biz-1');
      expect(event.specversion).toBe('1.0');
    });

    it('uses empty string for null fullName', () => {
      const customer = { globalId: 'gid-2', fullName: null };
      const event = buildCustomerRegisteredEvent(customer, 'biz-2');

      expect(event.payload).toEqual({
        customer_id: 'gid-2',
        full_name: '',
        business_id: 'biz-2',
      });
    });
  });

  describe('deriveRewardProgress', () => {
    const burger = { id: 'r-burger', name: 'Burger gratis', pointsCost: 100 };
    const combo = { id: 'r-combo', name: 'Combo', pointsCost: 250 };
    const papas = { id: 'r-papas', name: 'Papas medianas', pointsCost: 20 };

    it('picks the cheapest unaffordable reward as next, and the cheapest affordable one', () => {
      expect(deriveRewardProgress([combo, burger, papas], 30)).toEqual({
        nextReward: { id: 'r-burger', name: 'Burger gratis', pointsCost: 100, pointsMissing: 70 },
        affordableReward: { id: 'r-papas', name: 'Papas medianas', pointsCost: 20, pointsMissing: 0 },
        affordableRewardsCount: 1,
        activeRewardsCount: 3,
      });
    });

    it('breaks ties by name', () => {
      const b = { id: 'r-b', name: 'B', pointsCost: 100 };
      const a = { id: 'r-a', name: 'A', pointsCost: 100 };

      expect(deriveRewardProgress([b, a], 0).nextReward?.name).toBe('A');
      expect(deriveRewardProgress([b, a], 100).affordableReward?.name).toBe('A');
    });

    it('breaks a tie on cost and name by id, whatever the input order', () => {
      const first = { id: 'r-1', name: 'Café', pointsCost: 50 };
      const second = { id: 'r-2', name: 'Café', pointsCost: 50 };

      expect(deriveRewardProgress([second, first], 0).nextReward?.id).toBe('r-1');
      expect(deriveRewardProgress([first, second], 0).nextReward?.id).toBe('r-1');
    });

    it('treats a reward costing exactly the balance as affordable', () => {
      const result = deriveRewardProgress([burger], 100);

      expect(result.nextReward).toBeNull();
      expect(result.affordableReward?.id).toBe('r-burger');
      expect(result.affordableRewardsCount).toBe(1);
    });

    it('returns nulls and zero counts when there are no rewards', () => {
      expect(deriveRewardProgress([], 30)).toEqual({
        nextReward: null,
        affordableReward: null,
        affordableRewardsCount: 0,
        activeRewardsCount: 0,
      });
    });
  });

  describe('withRls', () => {
    it('calls setCurrentBusinessId with the business ID', async () => {
      const mockDbExec = { execute: vi.fn() };
      await withRls(mockDbExec, 'biz-1');
      expect(setCurrentBusinessId).toHaveBeenCalledWith('biz-1');
      expect(mockDbExec.execute).toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// Integration tests — CRUD Routes
// ===========================================================================

describe('CRUD Routes', () => {
  beforeEach(() => {
    resetMocks();
  });

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  describe('Auth', () => {
    it('returns 403 when auth headers are missing', async () => {
      const res = await request('GET', '/', { auth: false });

      expect(res.status).toBe(403);
      const body = await res.json() as any as any;
      expect(body.error.code).toBe('UNAUTHORIZED');
    });
  });

  // -----------------------------------------------------------------------
  // Upsert: PUT /
  // -----------------------------------------------------------------------

  describe('Upsert (PUT /)', () => {
    // -----------------------------------------------------------------------
    // Consents
    //
    // A consent is recorded in the same transaction as the customer it belongs
    // to, and the types are checked before anything is written. Both halves
    // matter: an unknown type must not leave a customer behind, and a consent
    // that cannot be recorded must not leave a customer behind either.
    // -----------------------------------------------------------------------

    it('records the consents the caller asked for', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PUT', '/v1/customers', {
        body: {
          fullName: 'Alice Smith',
          phone: '+56912345678',
          consents: { whatsapp: true, nearby_notifications: false },
        },
      });

      expect(res.status).toBe(201);
      expect(consentWrites).toEqual([
        expect.objectContaining({ consentType: 'whatsapp', granted: true }),
        expect.objectContaining({ consentType: 'nearby_notifications', granted: false }),
      ]);
    });

    it('leaves a consent alone when the caller did not mention it', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PUT', '/v1/customers', {
        body: { fullName: 'Alice Smith', phone: '+56912345678' },
      });

      expect(res.status).toBe(201);
      // Absent means "not mentioned", which is not the same as revoked.
      expect(consentWrites).toEqual([]);
    });

    it('rejects an unknown consent type without registering the customer', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PUT', '/v1/customers', {
        body: {
          fullName: 'Alice Smith',
          phone: '+56912345678',
          consents: { email: true },
        },
      });

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe('VALIDATION_ERROR');
      expect(data.error.message).toContain('email');
      // Nothing was written: a client that sent a typo is told so, and does not
      // leave a half-registered customer behind.
      expect(consentWrites).toEqual([]);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('rejects a consent whose value is not a boolean', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PUT', '/v1/customers', {
        body: {
          fullName: 'Alice Smith',
          phone: '+56912345678',
          consents: { whatsapp: 'yes' },
        },
      });

      expect(res.status).toBe(400);
      expect(consentWrites).toEqual([]);
    });

    it('creates customer and publishes event on first registration', async () => {
      // Select returns empty → no existing customer
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const body = { fullName: 'Alice Smith', phone: '+56912345678' };
      const res = await request('PUT', '/v1/customers', { body });

      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.event_published).toBe(true);
      expect(data.fullName).toBe('Alice Smith');
      expect(data.id).toBe('new-id');
      expect(mockPublish).toHaveBeenCalledTimes(1);
      // Schema validated
expect(mockValidate).toHaveBeenCalledWith(
          expect.anything(),
          'CustomerRegistered',
          expect.objectContaining({ customer_id: 'new-global-id' }),
        );
      });

      /**
       * The invariant the production outage broke.
       *
       * `validate()` cannot run in Cloudflare Workers at all: `ajv.compile()`
       * generates the validator from a string and the runtime forbids it, so it
       * throws `EvalError: Code generation from strings disallowed for this
       * context` on every registration. The insert has committed by the time that
       * happens, and the handler used to convert the throw into `500` — telling a
       * customer who had been registered that they had not been. A retry took the
       * upsert branch and returned 201, so a total outage looked like a flake.
       *
       * Both cases below are reachable in production rather than hypothetical:
       * the first is the current state of this endpoint, and the second is what
       * an unavailable queue does. Neither may rewrite a committed write.
       */
      it('still reports the customer when schema validation cannot run', async () => {
        mockDb.select.mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
          return chain;
        });

        mockValidate.mockRejectedValueOnce(
          new Error('EvalError: Code generation from strings disallowed for this context'),
        );

        const res = await request('PUT', '/v1/customers', {
          body: { fullName: 'Alice Smith', phone: '+56912345678' },
        });

        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.id).toBe('new-id');
        expect(data.fullName).toBe('Alice Smith');
      });

      it('reports the customer and the failed publish as separate facts', async () => {
        mockDb.select.mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
          return chain;
        });

        mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));

        const res = await request('PUT', '/v1/customers', {
          body: { fullName: 'Alice Smith', phone: '+56912345678' },
        });

        expect(res.status).toBe(201);
        const data = await res.json() as any;
        expect(data.id).toBe('new-id');
        expect(data.event_published).toBe(false);
      });

    it('returns 400 when required fields are missing', async () => {
      const res = await request('PUT', '/v1/customers', { body: { phone: '+56912345678' } as any });

      expect(res.status).toBe(400);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('updates existing customer without event on repeat upsert', async () => {
      // Select returns existing customer
      const existingCustomer = {
        id: 'existing-id',
        globalId: 'existing-global-id',
        businessId: 'biz-1',
        phone: '+56912345678',
        fullName: 'Alice Smith',
        email: null,
        birthDate: null,
      };
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([existingCustomer]).then(resolve);
        return chain;
      });

      const body = { fullName: 'Alice Updated', phone: '+56912345678', email: 'alice@test.com' };
      const res = await request('PUT', '/v1/customers', { body });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.fullName).toBe('Alice Updated');
      expect(data.email).toBe('alice@updated.com');

      // Event NOT published on repeat upsert
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('reports the customer but withholds the event when the schema rejects it', async () => {
      // No existing customer
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // Validate returns invalid
      mockValidate.mockResolvedValue({ valid: false, errors: ["payload full_name can't be empty"] });

      const body = { fullName: 'Alice Smith', phone: '+56912345678' };
      const res = await request('PUT', '/v1/customers', { body });

expect(res.status).toBe(201);
        const data = await res.json() as any;

        // The insert has already committed, so the customer exists and the response
        // says so. Returning 500 here is what told people they had not registered
        // while they were already in the database.
        expect(data.id).toBe('new-id');

        // The event is still withheld: a payload the registry rejects must not
        // reach the queue. That half of the old behaviour was correct and is kept.
        expect(data.event_published).toBe(false);
        expect(mockPublish).not.toHaveBeenCalled();
      });

      /**
       * A duplicate email in the same business used to be a 500.
       *
       * `uq_customers_business_email` is UNIQUE on (business_id, email) and the
       * upsert only looks up by phone, so the insert can violate it. Nothing caught
       * the violation, so it reached the top-level handler as `INTERNAL_ERROR` —
       * the one answer a registering customer cannot act on. The field is optional
       * on the form and people reuse their own address, so "internal error" read as
       * "try again" and failed identically forever.
       *
       * `PATCH` already translated `23505`; the two routes disagree about the same
       * constraint, and this pins the registration side now that it agrees.
       */
      it('answers a duplicate email with a 409 the form can show', async () => {
        mockDb.select.mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
          return chain;
        });

        mockDb.insert.mockImplementationOnce(() => {
          // The shape `@neondatabase/serverless` actually produces, captured by
          // running the failing insert against production: the code arrives on
          // `cause`, and the constraint name is on `cause.constraint` — there is no
          // `constraint_name` key at all. A fixture that invented `constraint_name`
          // would have kept this test green against a classifier that could never
          // match a real violation.
          const cause: any = new Error('duplicate key value violates unique constraint');
          cause.code = '23505';
          cause.constraint = 'uq_customers_business_email';
          cause.detail = 'Key (business_id, email)=(...) already exists.';
          const failure: any = new Error('Failed query: insert into "customers" ...');
          failure.code = undefined;
          failure.cause = cause;
          return {
            values: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(failure)) })),
          };
        });

        const res = await request('PUT', '/v1/customers', {
          body: {
            fullName: 'Alice Smith',
            phone: '+56912345678',
            email: 'taken@example.com',
          },
        });

        expect(res.status).toBe(409);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.EMAIL_TAKEN);

        // The register form drops to its generic copy once a message exceeds 180
        // characters, so the instruction that lets the customer finish has to fit.
        expect(data.error.message.length).toBeLessThanOrEqual(180);
        // Optional on that form, so the remedy is the one that unblocks them.
        expect(data.error.message).toMatch(/opcional/i);

        // Nothing was published: no customer exists to describe.
        expect(mockPublish).not.toHaveBeenCalled();
      });

      /**
       * The branch a returning customer lands in.
       *
       * The upsert looks the customer up by phone, so registering again with a
       * phone already on file takes the update branch — which writes to the same
       * unique index and had no classification at all. The first-time registration
       * of the same email answered 409 while the second one answered 500, and which
       * one you got depended on nothing the customer could see or control.
       */
      it('classifies a duplicate email on repeat registration too', async () => {
        mockDb.select.mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve([
              {
                id: 'existing-id',
                globalId: 'existing-global-id',
                businessId: 'biz-1',
                phone: '+56912345678',
                fullName: 'Alice Smith',
                email: null,
                birthDate: null,
              },
            ]).then(resolve);
          return chain;
        });

        mockDb.update.mockImplementationOnce(() => {
          const cause: any = new Error('duplicate key value violates unique constraint');
          cause.code = '23505';
          cause.constraint = 'uq_customers_business_email';
          const failure: any = new Error('Failed query: update "customers" ...');
          failure.cause = cause;
          const chain: any = {};
          chain.set = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.returning = vi.fn(() => Promise.reject(failure));
          return chain;
        });

        const res = await request('PUT', '/v1/customers', {
          body: {
            fullName: 'Alice Smith',
            phone: '+56912345678',
            email: 'taken@example.com',
          },
        });

        expect(res.status).toBe(409);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.EMAIL_TAKEN);
      });

      /**
       * The classifier returns `null` for anything that is not a unique violation,
       * and this is what that decision buys. A dropped connection reported as a
       * conflict sends whoever reads it hunting for a collision that does not
       * exist, which is a worse outcome than an honest 500.
       */
      it('lets a genuine insert failure surface instead of calling it a conflict', async () => {
        mockDb.select.mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
          return chain;
        });

        mockDb.insert.mockImplementationOnce(() => {
          const failure: any = new Error('connection terminated unexpectedly');
          failure.code = 'ECONNRESET';
          return {
            values: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(failure)) })),
          };
        });

        const res = await request('PUT', '/v1/customers', {
          body: { fullName: 'Alice Smith', phone: '+56912345678' },
        });

        expect(res.status).toBe(500);
        const data = await res.json() as any;
        expect(data.error.code).toBe('INTERNAL_ERROR');
      });
  });

  // -----------------------------------------------------------------------
  // List: GET /
  // -----------------------------------------------------------------------

  describe('List (GET /)', () => {
    it('returns paginated results with total count', async () => {
      const customers = Array.from({ length: 10 }, (_, i) => ({
        id: `c-${i}`,
        globalId: `gid-${i}`,
        businessId: 'biz-1',
        phone: `+569${String(i).padStart(8, '0')}`,
        fullName: `Customer ${i}`,
        email: `c${i}@test.com`,
        birthDate: null,
        deletedAt: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      }));

      // First select: count result
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 25 }]).then(resolve);
        return chain;
      });

      // Second select: data result
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve(customers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers?page=1&limit=10');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(10);
      expect(data.total).toBe(25);
      expect(data.page).toBe(1);
      expect(data.limit).toBe(10);
    });

    it('filters by search query', async () => {
      const matchingCustomers = [
        {
          id: 'c-1',
          globalId: 'gid-1',
          businessId: 'biz-1',
          phone: '+56911111111',
          fullName: 'Alice Wonderland',
          email: 'alice@test.com',
          birthDate: null,
          deletedAt: null,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ];

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 1 }]).then(resolve);
        return chain;
      });

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve(matchingCustomers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers?q=alice');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(1);
      expect(data.data[0].fullName).toContain('Alice');
      expect(data.total).toBe(1);
    });

    it('excludes soft-deleted customers', async () => {
      // Only active customers
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ total: 3 }]).then(resolve);
        return chain;
      });

      const activeCustomers = [
        { id: 'c-1', fullName: 'Alice', deletedAt: null },
        { id: 'c-2', fullName: 'Bob', deletedAt: null },
        { id: 'c-3', fullName: 'Charlie', deletedAt: null },
      ];

      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve(activeCustomers).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(3);
      expect(data.total).toBe(3);
      // Verify no customer has deletedAt set
      data.data.forEach((c: any) => {
        expect(c.deletedAt).toBeNull();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Profile: GET /:id
  // -----------------------------------------------------------------------

  describe('Profile (GET /:id)', () => {
    it('returns 360° profile with customer, events, and consents', async () => {
      const customerData = [
        {
          id: 'c-1',
          globalId: 'gid-1',
          businessId: 'biz-1',
          phone: '+56911111111',
          fullName: 'Alice Smith',
          email: 'alice@test.com',
          birthDate: null,
          deletedAt: null,
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        },
      ];

      const eventsData = [
        {
          id: 'e-1',
          customerId: 'c-1',
          businessId: 'biz-1',
          eventType: 'Registered',
          payload: {},
          createdAt: new Date('2026-01-01'),
        },
      ];

      const consentsData = [
        {
          id: 'cn-1',
          customerId: 'c-1',
          businessId: 'biz-1',
          consentType: 'marketing',
          granted: true,
          grantedAt: new Date('2026-01-01'),
          revokedAt: null,
          ipAddress: null,
          createdAt: new Date('2026-01-01'),
        },
      ];

      // 3 select calls in Promise.all: customer, events, consents
      mockDb.select
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(customerData).then(resolve);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(eventsData).then(resolve);
          return chain;
        })
        .mockImplementationOnce(() => {
          const chain: any = {};
          chain.from = vi.fn(() => chain);
          chain.where = vi.fn(() => chain);
          chain.limit = vi.fn(() => chain);
          chain.offset = vi.fn(() => chain);
          chain.orderBy = vi.fn(() => chain);
          chain.leftJoin = vi.fn(() => chain);
          chain.then = (resolve: (v: any) => any) =>
            Promise.resolve(consentsData).then(resolve);
          return chain;
        });

      const res = await request('GET', '/v1/customers/c-1');

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.id).toBe('c-1');
      expect(data.fullName).toBe('Alice Smith');
      expect(data.customer_events).toHaveLength(1);
      expect(data.customer_events[0].eventType).toBe('Registered');
      expect(data.consents).toHaveLength(1);
      expect(data.consents[0].consentType).toBe('marketing');
    });

    it('returns 404 for cross-business access (RLS isolation)', async () => {
      // No customer found for this business
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // Use a different business_id → no match (handled by where clause)
      const res = await request(
        'GET',
        '/c-1',
        { headers: { 'X-Business-Id': 'biz-other' } },
      );

      expect(res.status).toBe(404);
    });

    it('returns 404 for soft-deleted customer', async () => {
      // Customer exists but is deleted — query filters with isNull(deletedAt)
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('GET', '/v1/customers/c-deleted');

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Patch: PATCH /:id
  // -----------------------------------------------------------------------

  describe('Patch (PATCH /:id)', () => {
    it('updates only the provided fields', async () => {
      // Customer exists
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ id: 'existing-id', businessId: 'biz-1' }]).then(resolve);
        return chain;
      });

      const body = { email: 'newemail@test.com', fullName: 'New Name' };
      const res = await request('PATCH', '/v1/customers/existing-id', { body });

      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.fullName).toBe('Alice Updated');
      expect(data.email).toBe('alice@updated.com');

      // Verify update was called with the provided fields
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'newemail@test.com',
          fullName: 'New Name',
          updatedAt: expect.any(Date),
        }),
      );
    });

    // This test used to assert that a `businessId` in the body was *ignored*:
    // status 200, and neither spelling of the column reaching the UPDATE. The
    // property it was protecting — "the row does not move to another tenant" —
    // is unchanged, but the mechanism is now a refusal rather than a silent
    // strip. Silently dropping a field the operator typed is the exact failure
    // mode this allowlist exists to end, and a tenant move was the field most
    // worth refusing out loud.
    it('refuses a businessId in the body and never moves the row to another tenant', async () => {
      seedOneCustomer();

      const body = { fullName: 'Hacker', business_id: 'biz-evil', businessId: 'biz-evil' };
      const res = await request('PATCH', '/v1/customers/existing-id', { body });

      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.NOT_PATCHABLE);
      expect(data.error.message).toContain('businessId');
      expect(data.error.message).toContain('business_id');

      // No UPDATE at all, so no spelling of the tenant column was written.
      expect(mockDb.update).not.toHaveBeenCalled();

      // And the tenant filter still comes from the token, not the payload.
      const [lookup] = wheresFor('customers');
      expect(lookup.params).toContain('biz-1');
    });

    it('returns 404 when customer not found', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('PATCH', '/nonexistent', { body: { email: 'x@y.com' } });

      expect(res.status).toBe(404);
    });

    // -----------------------------------------------------------------------
    // The allowlist
    //
    // Before these, `const { businessId, ...updateData } = body` and the rest of
    // the body went into `.set()`. Every test here exists because that spread
    // turned a merchant's PATCH into a write on any of the fifteen columns.
    // -----------------------------------------------------------------------

    describe('allowlist', () => {
      /**
       * The one test that makes this endpoint acceptable.
       *
       * `global_id` is half of the Google Wallet `objectId`
       * (`<issuerId>.member-<globalId>`), so rewriting it does not "rename a
       * customer": it points the pass we issue at a different object, the object
       * already saved on their phone stops being theirs, and the old one is not
       * deleted from Google. There is no way back short of reissuing.
       */
      it('rejects globalId, and the column does not change', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { globalId: '11111111-2222-4333-8444-555555555555' },
        });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.NOT_PATCHABLE);
        // Named, not swallowed: an operator who sends this has to be told it did
        // not happen.
        expect(data.error.message).toContain('globalId');

        // The proof that matters — no UPDATE was issued at all.
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it.each([
        ['deletedAt', '1999-01-01T00:00:00.000Z'],
        ['id', 'other-id'],
        ['currentTierId', 'tier-oro'],
        ['memberCode', 'M-0001'],
        ['metadata', { tier: 'oro' }],
        ['createdAt', '1999-01-01T00:00:00.000Z'],
      ])('rejects %s', async (field, value) => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { [field]: value },
        });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.NOT_PATCHABLE);
        expect(data.error.message).toContain(field);
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it('applies each of the four editable fields', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: {
            fullName: 'Ana Updated',
            phone: '+56988887777',
            email: 'ana@updated.com',
            birthDate: '1991-02-03',
          },
        });

        expect(res.status).toBe(200);
        const updateSetFn = mockDb.update.mock.results[0]?.value.set;
        expect(updateSetFn).toHaveBeenCalledWith({
          fullName: 'Ana Updated',
          phone: '+56988887777',
          email: 'ana@updated.com',
          birthDate: '1991-02-03',
          updatedAt: expect.any(Date),
        });
      });

      it('reads its allowlist from the shared contract, not a local copy', async () => {
        for (const field of CUSTOMER_PATCHABLE_FIELDS) {
          seedOneCustomer();
          mockDb.update.mockClear();
          const res = await request('PATCH', '/v1/customers/existing-id', {
            body: { [field]: field === 'birthDate' ? '1990-01-01' : 'x' },
          });
          expect(res.status, `${field} must be editable`).toBe(200);
        }
      });

      /**
       * Whole-body rejection, and the reason for it.
       *
       * A partial application would be the friendlier answer — the valid half
       * lands, the invalid half is reported — and it is the wrong one. The
       * operator left believing the name changed when it did not is a worse
       * outcome than being told to fix the request and send it again: the first
       * one is discovered at the next phone call, the second one immediately.
       * So a body with one good field and one forbidden field writes nothing.
       */
      it('rejects the whole body when one field is editable and another is not', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { fullName: 'Ana Updated', globalId: '11111111-2222-4333-8444-555555555555' },
        });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.NOT_PATCHABLE);
        expect(data.error.message).toContain('globalId');

        // The editable field was NOT applied either. This is the assertion that
        // makes the test above worth writing.
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it('names every forbidden field in one answer', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { fullName: 'Ana', globalId: 'x', deletedAt: 'y' },
        });

        const data = await res.json() as any;
        expect(data.error.message).toContain('globalId');
        expect(data.error.message).toContain('deletedAt');
      });

      // A typo or a snake_case habit must produce the same clear refusal, not a
      // Postgres "column does not exist" surfacing as a 500.
      it('rejects a field that is not even a column', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { nombre: 'Ana' },
        });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.NOT_PATCHABLE);
        expect(data.error.message).toContain('nombre');
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it('lists what is editable, so the refusal is actionable', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { globalId: 'x' },
        });

        const data = await res.json() as any;
        for (const field of CUSTOMER_PATCHABLE_FIELDS) {
          expect(data.error.message).toContain(field);
        }
      });

      it('refuses a body that names no editable field', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', { body: {} });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.EMPTY);
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      it.each([
        ['an array', ['fullName']],
        ['a bare string', 'fullName'],
        ['a number', 42],
        ['null', null],
      ])('refuses a body that is %s rather than an object', async (_label, body) => {
        seedOneCustomer();

        const req = new Request(`${BASE}/v1/customers/existing-id`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': 'user-1',
            'X-Business-Id': 'biz-1',
            'X-User-Role': 'admin',
          },
          body: JSON.stringify(body),
        });
        const res = await app.fetch(req, TEST_ENV, TEST_EXECUTION_CTX);

        expect(res.status).toBe(400);
        expect(mockDb.update).not.toHaveBeenCalled();
      });
    });

    describe('partial updates do not blank untouched columns', () => {
      it('writes only the column that was sent, leaving the rest absent from the UPDATE', async () => {
        seedOneCustomer();

        await request('PATCH', '/v1/customers/existing-id', { body: { phone: '+56955554444' } });

        const updateSetFn = mockDb.update.mock.results[0]?.value.set as { mock: { calls: unknown[][] } };
        const payload = updateSetFn.mock.calls[0]![0] as Record<string, unknown>;
        // The danger is a key present with an `undefined` value: drizzle passes
        // those to Postgres as NULL, so the column the operator never touched
        // would be emptied by an edit of a different column.
        expect(Object.keys(payload).sort()).toEqual(['phone', 'updatedAt']);
        for (const key of ['email', 'birthDate', 'fullName']) {
          expect(payload).not.toHaveProperty(key);
        }
      });

      it('clears a nullable column only when null is spelled out', async () => {
        seedOneCustomer();

        await request('PATCH', '/v1/customers/existing-id', { body: { email: null } });

        const updateSetFn = mockDb.update.mock.results[0]?.value.set as { mock: { calls: unknown[][] } };
        const payload = updateSetFn.mock.calls[0]![0] as Record<string, unknown>;
        expect(payload.email).toBeNull();
        expect(payload).not.toHaveProperty('fullName');
      });

      /**
       * The write carries the tenant too, not only the read that found the row.
       *
       * There is no row-level security on these tables — `enableRls()` and
       * `createRlsPolicies()` in `packages/db/src/rls.ts` are applied by no
       * migration — so a `WHERE id = $1` on the UPDATE is a row identified only by
       * a value from the URL. The existence check narrows it, so this is
       * defence in depth rather than the only thing standing between tenants. It
       * is still worth having, and worth a test: a WHERE nobody compiles in a
       * suite is a WHERE that can be deleted without anything going red.
       */
      it('scopes the UPDATE itself to the tenant and to a live row', async () => {
        seedOneCustomer();

        await request('PATCH', '/v1/customers/existing-id', { body: { phone: '+56955554444' } });

        const [write] = updateCalls;
        const { sql: where, params } = compile(write.where);
        expect(where).toMatch(/"business_id"/);
        expect(where).toMatch(/"deleted_at"/);
        // The tenant in the WHERE is the token's, and the id is the path's.
        expect(params).toContain('biz-1');
        expect(params).toContain('existing-id');
      });

      it('rejects a value that is neither a string nor null', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { fullName: { toString: 'nope' } },
        });

        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.INVALID_VALUE);
        expect(data.error.message).toContain('fullName');
        expect(mockDb.update).not.toHaveBeenCalled();
      });

      // PUT strips whitespace from the phone before storing it. The unique index
      // and the POS equality lookup both read the stored value, so an unstripped
      // phone saved here would be a number the counter can never match.
      it('normalises the phone the same way registration does', async () => {
        seedOneCustomer();

        await request('PATCH', '/v1/customers/existing-id', {
          body: { phone: '+569 5555 4444' },
        });

        const updateSetFn = mockDb.update.mock.results[0]?.value.set as { mock: { calls: unknown[][] } };
        const payload = updateSetFn.mock.calls[0]![0] as Record<string, unknown>;
        expect(payload.phone).toBe('+56955554444');
      });
    });

    describe('uniqueness', () => {
      it('translates a duplicate phone into an answer the operator can use', async () => {
        seedOneCustomer();
        failUpdateWithUniqueViolation('uq_customers_business_phone');

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { phone: '+56999999999' },
        });

        // Probed, not assumed: before the guard this was
        // 500 {"code":"INTERNAL_ERROR","message":"Internal server error"}.
        expect(res.status).toBe(409);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.PHONE_TAKEN);
        expect(data.error.message).toMatch(/another customer in this business/i);
        // Named the way the operator thinks about it — the phone, not the index.
        expect(data.error.message).toMatch(/phone/i);
        expect(data.error.message).not.toMatch(/uq_customers/);
      });

      it('translates a duplicate email into its own code and message', async () => {
        seedOneCustomer();
        failUpdateWithUniqueViolation('uq_customers_business_email');

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { email: 'taken@elsewhere.com' },
        });

        expect(res.status).toBe(409);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.EMAIL_TAKEN);
        expect(data.error.message).toMatch(/another customer in this business/i);
        expect(data.error.message).toMatch(/email/i);
      });

      it('gives phone and email different codes, so the form can blame the right input', async () => {
        expect(CUSTOMER_PATCH_ERROR.PHONE_TAKEN).not.toBe(CUSTOMER_PATCH_ERROR.EMAIL_TAKEN);
      });

      /**
       * Saving a customer back with the phone they already have is a no-op the
       * operator performs constantly — the form submits all four fields, most of
       * them unchanged. Postgres excludes the row being updated from the unique
       * index, so this does not raise; the point of the test is that the guard
       * above did not add a "check first" query that would break it.
       */
      it('accepts a phone that is already this customer\'s own', async () => {
        seedOneCustomer();

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { phone: '+56912345678', fullName: 'Ana' },
        });

        expect(res.status).toBe(200);
        expect(mockDb.update).toHaveBeenCalledTimes(1);
      });

      it('lets an unrelated database failure through as a 500', async () => {
        seedOneCustomer();
        failUpdateWith(new Error('connection terminated unexpectedly'));

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { phone: '+56999999999' },
        });

        // Over-translating is its own lie: a broken database must not be
        // reported to a merchant as "that phone belongs to someone else".
        expect(res.status).toBe(500);
        const data = await res.json() as any;
        expect(data.error.code).toBe('INTERNAL_ERROR');
      });

      // A unique index this route cannot name — `uq_customers_business_member_code`
      // exists today — is still a conflict, not an internal error.
      it('still reports a conflict it has no specific message for', async () => {
        seedOneCustomer();
        failUpdateWithUniqueViolation('uq_customers_business_member_code');

        const res = await request('PATCH', '/v1/customers/existing-id', {
          body: { phone: '+56999999999' },
        });

        expect(res.status).toBe(409);
        const data = await res.json() as any;
        expect(data.error.code).toBe(CUSTOMER_PATCH_ERROR.CONFLICT);
        expect(data.error.message).toMatch(/another record/i);
      });
    });

  });

  // -----------------------------------------------------------------------
  // Delete: DELETE /:id
  // -----------------------------------------------------------------------

  describe('Delete (DELETE /:id)', () => {
    it('soft deletes customer and returns 204', async () => {
      // Customer exists
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) =>
          Promise.resolve([{ id: 'c-1', businessId: 'biz-1' }]).then(resolve);
        return chain;
      });

      const res = await request('DELETE', '/v1/customers/c-1');

      expect(res.status).toBe(204);
      expect(res.body).toBeNull();

      // Verify update was called with deletedAt
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
    });

    it('returns 404 when deleting non-existent customer', async () => {
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('DELETE', '/nonexistent');

      expect(res.status).toBe(404);
    });

    it('get after soft delete returns 404', async () => {
      // First, mark as deleted via select returning empty (simulates filter)
      mockDb.select.mockImplementationOnce(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      // GET /c-deleted-after-delete
      const res = await request('GET', '/v1/customers/c-deleted-after-delete');

      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // Self-profile: GET /me — loyalty "web pass" contract
  // -----------------------------------------------------------------------

  describe('Self-profile (GET /me)', () => {
    beforeEach(() => {
      resetMocks();
    });

    it('returns the reward progress derived from the active rewards', async () => {
      seedMe({
        balance: 30,
        rewards: [
          { id: 'r-combo', name: 'Combo', pointsCost: 250 },
          { id: 'r-burger', name: 'Burger gratis', pointsCost: 100 },
          { id: 'r-papas', name: 'Papas medianas', pointsCost: 20 },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.nextReward).toEqual({
        id: 'r-burger',
        name: 'Burger gratis',
        pointsCost: 100,
        pointsMissing: 70,
      });
      expect(body.data.affordableReward.name).toBe('Papas medianas');
      expect(body.data.affordableRewardsCount).toBe(1);
      expect(body.data.activeRewardsCount).toBe(3);
    });

    it('returns null rewards and zero counts when the tenant has no active rewards', async () => {
      seedMe({ balance: 30 });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.nextReward).toBeNull();
      expect(body.data.affordableReward).toBeNull();
      expect(body.data.affordableRewardsCount).toBe(0);
      expect(body.data.activeRewardsCount).toBe(0);
    });

    it('reads only active rewards of the caller business', async () => {
      // Sold out, expired, not yet valid and deleted rewards are filtered in
      // SQL, and so is every other tenant: the WHERE is the whole guarantee.
      seedMe({ balance: 30 });

      await request('GET', '/v1/customers/me');

      const [where] = wheresFor('rewards');
      expect(where).toBeDefined();
      expect(where!.sql).toContain('"rewards"."business_id" = $');
      expect(where!.params).toContain('biz-1');
      expect(where!.sql).toContain('"rewards"."deleted_at" is null');
      expect(where!.sql).toMatch(/"rewards"\."valid_from" is null or "rewards"\."valid_from" <= now\(\)/);
      expect(where!.sql).toMatch(/"rewards"\."valid_until" is null or "rewards"\."valid_until" > now\(\)/);
      expect(where!.sql).toMatch(/"rewards"\."stock" is null or "rewards"\."stock" > \$\d+/);
    });

    it('includes purchaseAmount as a number or null in recent_transactions', async () => {
      seedMe({
        balance: 30,
        transactions: [
          { id: 't1', type: 'earn', points: 20, balanceAfter: 30, note: null, purchaseAmount: '11400.00', createdAt: '2026-10-25T12:00:00.000Z' },
          { id: 't2', type: 'earn', points: 10, balanceAfter: 10, note: 'Bono', purchaseAmount: null, createdAt: '2026-10-20T12:00:00.000Z' },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.recent_transactions.map((t: any) => t.purchaseAmount)).toEqual([11400, null]);
    });

    it('reports a missing or unreadable purchaseAmount as null, never NaN', async () => {
      seedMe({
        balance: 30,
        transactions: [
          { id: 't1', type: 'earn', points: 20, balanceAfter: 30, note: null, createdAt: '2026-10-25T12:00:00.000Z' },
          { id: 't2', type: 'earn', points: 10, balanceAfter: 10, note: null, purchaseAmount: 'abc', createdAt: '2026-10-20T12:00:00.000Z' },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.recent_transactions.map((t: any) => t.purchaseAmount)).toEqual([null, null]);
    });

    it('returns the business name and slug', async () => {
      seedMe({ balance: 0 });

      const res = await request('GET', '/v1/customers/me');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.data.business).toEqual({
        id: 'biz-1',
        name: 'Club Barrio',
        slug: 'club-barrio',
      });
    });

    it('returns the program name and pointsCurrency, and nothing more', async () => {
      seedMe({ balance: 0 });

      const res = await request('GET', '/v1/customers/me');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.data.program).toEqual({
        id: 'prog-1',
        name: 'Club Barrio Puntos',
        pointsCurrency: 'puntos',
      });
      // Guard against widening the contract with the other program columns.
      expect(Object.keys(body.data.program).sort()).toEqual(['id', 'name', 'pointsCurrency']);
    });

    it('returns tiers ordered by displayOrder, with multiplier as a number', async () => {
      // Deliberately out of order in the fixture to prove the route orders,
      // rather than the route relying on insertion order from the DB.
      seedMe({
        balance: 0,
        tiers: [
          { id: 'tier-oro', name: 'Oro', minPoints: 500, multiplier: '1.50', displayOrder: 3 },
          { id: 'tier-bronce', name: 'Bronce', minPoints: 0, multiplier: '1.00', displayOrder: 1 },
          { id: 'tier-plata', name: 'Plata', minPoints: 100, multiplier: '1.25', displayOrder: 2 },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.data.tiers.map((t: any) => t.name)).toEqual(['Bronce', 'Plata', 'Oro']);
      expect(body.data.tiers.map((t: any) => t.displayOrder)).toEqual([1, 2, 3]);
      // numeric(4,2) arrives from Drizzle as a string — the contract says number.
      expect(body.data.tiers.map((t: any) => t.multiplier)).toEqual([1, 1.25, 1.5]);
      body.data.tiers.forEach((t: any) => {
        expect(typeof t.multiplier).toBe('number');
        expect(typeof t.minPoints).toBe('number');
      });
    });

    it('orders tiers by displayOrder then minPoints as a tiebreak', async () => {
      // Two tiers share displayOrder 1 — the tiebreak must be minPoints asc.
      seedMe({
        balance: 0,
        tiers: [
          { id: 'tier-late', name: 'Late', minPoints: 50, multiplier: '1.10', displayOrder: 1 },
          { id: 'tier-early', name: 'Early', minPoints: 10, multiplier: '1.05', displayOrder: 1 },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.tiers.map((t: any) => t.name)).toEqual(['Early', 'Late']);
    });

    it('nextTier is the first tier whose minPoints strictly exceeds the balance', async () => {
      // 150 points: Bronce(0) and Plata(100) are reached, Oro(500) is next.
      seedMe({ balance: 150 });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.points).toBe(150);
      expect(body.data.nextTier).toEqual({
        id: 'tier-oro',
        name: 'Oro',
        minPoints: 500,
        multiplier: 1.5,
        displayOrder: 3,
      });
    });

    it('nextTier is not the current tier when points equal its minPoints', async () => {
      // Exactly on the Plata threshold → must advance to Oro, not stay on Plata.
      seedMe({ balance: 100 });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.nextTier?.id).toBe('tier-oro');
    });

    it('nextTier is null at or above the top tier minPoints', async () => {
      seedMe({ balance: 500 });
      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;
      expect(body.data.nextTier).toBeNull();

      resetMocks();
      seedMe({ balance: 9999 });
      const res2 = await request('GET', '/v1/customers/me');
      const body2 = await res2.json() as any;
      expect(body2.data.nextTier).toBeNull();
    });

    it('returns program null and tiers [] when the tenant has no program', async () => {
      seedMe({ balance: 42, program: null, tiers: [] });

      const res = await request('GET', '/v1/customers/me');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      // The UI must be able to render an honest "being set up" empty state.
      expect(body.data.program).toBeNull();
      expect(body.data.tiers).toEqual([]);
      expect(body.data.nextTier).toBeNull();
      // ...and the business itself is still resolved.
      expect(body.data.business.slug).toBe('club-barrio');
    });

    it('returns business null when the tenant row cannot be resolved', async () => {
      seedMe({ balance: 0, business: null });

      const res = await request('GET', '/v1/customers/me');
      expect(res.status).toBe(200);

      const body = await res.json() as any;
      expect(body.data.business).toBeNull();
    });

    // -------------------------------------------------------------------
    // Tenant isolation
    //
    // There is no row-level security on these tables. The only thing standing
    // between tenants is an explicit business filter in each query, so the
    // filter is asserted directly against the compiled SQL the route emits.
    // -------------------------------------------------------------------

    it('scopes the business query by the authenticated businessId', async () => {
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me');

      const wheres = wheresFor('tenants');
      expect(wheres).toHaveLength(1);
      // tenants.id IS the business id — scoped by primary key.
      expect(wheres[0].sql).toContain('"tenants"."id" = $1');
      expect(wheres[0].params).toEqual(['biz-1']);
    });

    it('scopes the program query by the authenticated businessId', async () => {
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me');

      const wheres = wheresFor('loyaltyPrograms');
      expect(wheres).toHaveLength(1);
      expect(wheres[0].sql).toContain('"loyalty_programs"."business_id" = $1');
      expect(wheres[0].params).toEqual(['biz-1']);
    });

    it('scopes the tiers query by the authenticated businessId', async () => {
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me');

      // The route also queries membership_tiers by currentTierId; find the
      // business-scoped one specifically.
      const scoped = callsFor('membershipTiers').filter((c) => {
        const sql = compile(c.where).sql;
        return sql.includes('business_id');
      });
      expect(scoped).toHaveLength(1);
      expect(compile(scoped[0].where).sql).toContain('"membership_tiers"."business_id" = $1');
      expect(compile(scoped[0].where).params).toEqual(['biz-1']);
    });

    it('binds the caller businessId, so a different businessId cannot match', async () => {
      // The value bound to business_id is the authenticated header value, so a
      // request for another tenant filters on that tenant instead. If the scope
      // were dropped entirely, the bound param would be gone (or fixed).
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me', {
        headers: { 'X-Business-Id': 'biz-2' },
      });

      for (const table of ['tenants', 'loyaltyPrograms', 'membershipTiers']) {
        const compiled = wheresFor(table);
        expect(compiled.length).toBeGreaterThan(0);
        for (const w of compiled) {
          expect(w.sql).toMatch(/business_id"? = \$1|"tenants"\."id" = \$1/);
          expect(w.params).toEqual(['biz-2']);
          expect(w.params).not.toContain('biz-1');
        }
      }
    });

    it('orders the tiers query by displayOrder then minPoints', async () => {
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me');

      const scoped = callsFor('membershipTiers').filter((c) =>
        compile(c.where).sql.includes('business_id'),
      );
      expect(scoped).toHaveLength(1);

      const orderSql = scoped[0].orderBy
        .map((clause: any) => dialect.sqlToQuery(clause).sql)
        .join(', ');
      expect(orderSql).toContain('"membership_tiers"."display_order" asc');
      expect(orderSql).toContain('"membership_tiers"."min_points" asc');
      expect(orderSql.indexOf('display_order')).toBeLessThan(orderSql.indexOf('min_points'));
    });

    it('does not require a currentTierId to resolve the pass', async () => {
      // Business/program/tiers must resolve independently of the `tier` object.
      seedMe({ balance: 10, customer: { ...ME_CUSTOMER, currentTierId: null } });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.tier).toBeNull();
      expect(body.data.currentTier).toBeNull();
      expect(body.data.program.name).toBe('Club Barrio Puntos');
      expect(body.data.tiers).toHaveLength(3);
    });

    it('still returns every pre-existing field unchanged', async () => {
      seedMe({
        balance: 150,
        events: [{ id: 'e-1', eventType: 'customer.registered' }],
        transactions: [
          {
            id: 'tx-1',
            type: 'earn',
            points: 50,
            balanceAfter: 150,
            note: 'compra',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.id).toBe('cust-1');
      expect(body.data.globalId).toBe('user-1');
      expect(body.data.fullName).toBe('Alice Smith');
      expect(body.data.phone).toBe('+56911111111');
      expect(body.data.email).toBe('alice@test.com');
      expect(body.data.birthDate).toBe('1990-05-04');
      expect(body.data.points).toBe(150);
      expect(body.data.totalPointsEarned).toBe(0);
      expect(body.data.pointsLast30Days).toBe(0);
      expect(body.data.currentTierId).toBeNull();
      expect(body.data.customer_events).toHaveLength(1);
      expect(body.data.recent_transactions).toHaveLength(1);
      expect(body.data.recent_transactions[0].id).toBe('tx-1');
      expect(body.data.createdAt).toBe('2026-01-01T00:00:00.000Z');

      // The four new fields are present, and the pre-existing set is unchanged.
      expect(body.data).toHaveProperty('business');
      expect(body.data).toHaveProperty('program');
      expect(body.data).toHaveProperty('tiers');
      expect(body.data).toHaveProperty('nextTier');
    });

    it('still resolves the legacy tier object with a number multiplier', async () => {
      // currentTierId path is untouched by this change — it must keep working.
      seedMe({
        balance: 0,
        customer: { ...ME_CUSTOMER, currentTierId: 'tier-plata' },
        tiers: [ME_TIERS[1]],
      });

      const res = await request('GET', '/v1/customers/me');
      const body = await res.json() as any;

      expect(body.data.currentTierId).toBe('tier-plata');
      expect(body.data.currentTier).toBe('Plata');
      expect(body.data.tier).toEqual({ id: 'tier-plata', name: 'Plata', multiplier: 1.25 });
    });

    it('rejects a missing business header before reaching the handler', async () => {
      // The handler's own 401 branches are unreachable: the global middleware
      // in index.ts calls extractAuthHeaders() and throws 403 first.
      const res = await request('GET', '/v1/customers/me', {
        auth: false,
        headers: { 'X-User-Id': 'user-1' },
      });
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('records the profile_viewed background event', async () => {
      seedMe({ balance: 0 });
      await request('GET', '/v1/customers/me');
      await flushBackground();

      expect(mockPublish).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // 404 handler
  // -----------------------------------------------------------------------

  describe('404 handler', () => {
    it('returns JSON error for unknown routes', async () => {
      // POST is not defined, so no route matches → 404 handler fires
      const res = await request('POST', '/');

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error.code).toBe('NOT_FOUND');
    });
  });
});

// ===========================================================================
// POS lookup: GET /v1/customers/lookup
// ===========================================================================
//
// The counter has one customer in front of it and a phone number, an email or a
// scanned QR. This resolves exactly that person, with the pass state, the
// balance and the tier.
//
// Three things are load-bearing in this block and each has a test that fails if
// the guard is removed:
//
//   1. Tenant isolation rests on an explicit `business_id` in the WHERE clause.
//      There is no row-level security in this database (`enableRls()` is never
//      applied by any migration — see the note in routes.ts), so a missing
//      filter is a cross-tenant leak with no second line of defence.
//   2. The match is an equality against one column. A pattern match is how a
//      lookup silently becomes the customer list this surface must not be.
//   3. `not_issued` and `not_saved` are reported as the distinct values they
//      are. `not_issued` is a gap in OUR knowledge; `not_saved` is a definite
//      answer from Google. Collapsing them tells a merchant we know something
//      we do not.
// ===========================================================================

/** Projections mirror exactly what `lookupCustomer` selects. */
const LOOKUP_CUSTOMER_COLUMNS = {
  id: 1,
  globalId: 1,
  fullName: 1,
  phone: 1,
  email: 1,
  currentTierId: 1,
};
const LOOKUP_PASS_COLUMNS = { state: 1, lastSyncedAt: 1 };
const LOOKUP_BALANCE_COLUMNS = { balanceAfter: 1 };
const LOOKUP_TIER_COLUMNS = { id: 1, name: 1, multiplier: 1 };

const LOOKUP_CUSTOMER = {
  id: 'cust-lookup',
  globalId: 'a0000000-0000-4000-8000-000000000001',
  phone: '+56911111111',
  email: 'ana@test.com',
  fullName: 'Ana Ruiz',
  currentTierId: 'tier-oro',
};

const LOOKUP_TIER = { id: 'tier-oro', name: 'Oro', multiplier: '1.50' };

/**
 * Seed the registry for a lookup.
 *
 * `pass: null` seeds NO row, which is the honest "this customer was never
 * issued a save link" case — distinct from a row whose state is `not_issued`.
 */
function seedLookup(opts: {
  customer?: unknown[] | null;
  pass?: unknown[] | null;
  balance?: number | null;
  tier?: unknown[] | null;
} = {}) {
  setTableResults({
    [key('customers', LOOKUP_CUSTOMER_COLUMNS)]:
      opts.customer === null ? [] : (opts.customer ?? [LOOKUP_CUSTOMER]),
    [key('customerWalletPasses', LOOKUP_PASS_COLUMNS)]:
      opts.pass === null ? [] : (opts.pass ?? []),
    [key('pointsTransactions', LOOKUP_BALANCE_COLUMNS)]:
      opts.balance === null ? [] : [{ balanceAfter: opts.balance ?? 0 }],
    [key('membershipTiers', LOOKUP_TIER_COLUMNS)]:
      opts.tier === null ? [] : (opts.tier ?? [LOOKUP_TIER]),
  });
}

/** `?phone=`/`?email=`/`?globalId=` with the value encoded. */
function lookupPath(param: 'phone' | 'email' | 'globalId', value: string) {
  return `/v1/customers/lookup?${param}=${encodeURIComponent(value)}`;
}

/** The columns only the lookup filters on; `GET /v1/customers/:id` uses none. */
const IDENTIFIER_COLUMNS = [
  '"customers"."phone"',
  '"customers"."email"',
  '"customers"."global_id"',
];

/**
 * The compiled WHERE of the customer read the lookup issued.
 *
 * Requiring an identifier column is not decoration. `/v1/customers/lookup` also
 * matches the pre-existing `/v1/customers/:id` route, with `id = "lookup"`, so a
 * test that only asserted `business_id` would be satisfied by the profile route
 * and would have passed before this endpoint existed at all. Asserting the
 * identifier column is what makes the test about *this* route.
 */
function lookupCustomerWhere() {
  const scoped = wheresFor('customers').filter((w) =>
    IDENTIFIER_COLUMNS.some((col) => w.sql.includes(col)),
  );
  expect(scoped).toHaveLength(1);
  return scoped[0]!;
}

describe('Self update (PATCH /v1/customers/me)', () => {
  beforeEach(() => {
    resetMocks();
  });

  const AS_CUSTOMER = { 'X-User-Id': 'user-1', 'X-Business-Id': 'biz-1', 'X-User-Role': 'customer' };

  function patchMe(body: Record<string, unknown>, headers: Record<string, string> = AS_CUSTOMER) {
    return request('PATCH', '/v1/customers/me', { body, headers });
  }

  function expectNothingWritten() {
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  }

  it('updates the email and answers with the profile fields', async () => {
    const res = await patchMe({ email: 'nuevo@example.com' });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // The row the database returned, not the request echoed back.
    expect(body.data).toEqual({ fullName: 'Alice Updated', email: 'alice@updated.com', birthDate: null });

    expect(updateCalls).toHaveLength(1);
    const { updatedAt, ...written } = updateCalls[0]!.set;
    expect(written).toEqual({ email: 'nuevo@example.com' });
    expect(updatedAt).toBeInstanceOf(Date);
  });

  it('publishes customer.profile_updated with the fields that changed', async () => {
    await patchMe({ email: 'nuevo@example.com', fullName: 'Ada Lovelace' });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const event = mockPublish.mock.calls[0]![1];
    expect(event.type).toBe('CustomerProfileUpdated');
    expect(event.header.business_id).toBe('biz-1');
    expect(event.payload).toEqual({ customer_id: 'existing-global-id', changed_fields: ['email', 'fullName'] });
  });

  it('resolves the customer from the token headers, inside the token business only', async () => {
    await patchMe({ email: 'nuevo@example.com' });

    const where = compile(updateCalls[0]!.where);
    expect(where.sql).toMatch(/"customers"\."global_id" = \$\d+/);
    expect(where.sql).toMatch(/"customers"\."business_id" = \$\d+/);
    expect(where.sql).toMatch(/"customers"\."deleted_at" is null/);
    expect(where.params).toEqual(expect.arrayContaining(['user-1', 'biz-1']));
  });

  it('ignores an id in the body and refuses it as an unknown field', async () => {
    const res = await patchMe({ id: 'someone-else', email: 'nuevo@example.com' });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('VALIDATION_ERROR');
    expectNothingWritten();
  });

  it('refuses a phone change and writes nothing', async () => {
    const res = await patchMe({ phone: '+56900000000' });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('phone');
    expectNothingWritten();
  });

  it.each([
    ['an invalid email', { email: 'nuevo@' }, 'email'],
    ['an empty name', { fullName: '   ' }, 'fullName'],
    ['a cleared name', { fullName: null }, 'fullName'],
    ['an impossible birth date', { birthDate: '1990-02-30' }, 'birthDate'],
    ['a future birth date', { birthDate: '2999-01-01' }, 'birthDate'],
    ['a number as email', { email: 42 }, 'email'],
    ['an empty body', {}, 'fullName'],
  ])('refuses %s', async (_label, body, field) => {
    const res = await patchMe(body);

    expect(res.status).toBe(400);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.message).toContain(field);
    expectNothingWritten();
  });

  it('clears the email and the birth date with null, and trims the name', async () => {
    const res = await patchMe({ email: null, birthDate: null, fullName: '  Ada Lovelace  ' });

    expect(res.status).toBe(200);
    const { updatedAt: _ignored, ...written } = updateCalls[0]!.set;
    expect(written).toEqual({ email: null, birthDate: null, fullName: 'Ada Lovelace' });
  });

  it('answers 404 when the token has no customer row in this business', async () => {
    mockDb.update.mockImplementationOnce(() => {
      const chain: any = {
        set: vi.fn(() => chain),
        where: vi.fn(() => chain),
        returning: vi.fn(() => Promise.resolve([])),
      };
      return chain;
    });

    const res = await patchMe({ email: 'nuevo@example.com' });

    expect(res.status).toBe(404);
    expect((await res.json() as any).error.code).toBe('NOT_FOUND');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('answers 409 when another customer of the business holds the email', async () => {
    mockDb.update.mockImplementationOnce(() => {
      const chain: any = {
        set: vi.fn(() => chain),
        where: vi.fn(() => chain),
        returning: vi.fn(() =>
          Promise.reject(Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_customers_business_email' })),
        ),
      };
      return chain;
    });

    const res = await patchMe({ email: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect((await res.json() as any).error.code).toBe('CUSTOMER_EMAIL_TAKEN');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('still answers 200 when the event cannot be published', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));

    const res = await patchMe({ email: 'nuevo@example.com' });

    expect(res.status).toBe(200);
  });

  it('leaves the merchant edit by id untouched', async () => {
    mockDb.select.mockImplementationOnce(() => {
      const chain: any = {};
      chain.from = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => chain);
      chain.then = (resolve: (v: any) => any) =>
        Promise.resolve([{ id: 'existing-id', businessId: 'biz-1' }]).then(resolve);
      return chain;
    });

    const res = await request('PATCH', '/v1/customers/existing-id', { body: { phone: '+56 9 1234 5678' } });

    expect(res.status).toBe(200);
    expect(updateCalls[0]!.set.phone).toBe('+56912345678');
  });
});

describe('Staff-only customer routes refuse a customer token', () => {
  beforeEach(() => {
    resetMocks();
  });

  // Every route that reads or writes another customer is for the business
  // staff. The customer app only ever reads its own row through /me.
  const STAFF_ROUTES: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['PUT', '/v1/customers', { fullName: 'Intruso', phone: '+56900000000' }],
    ['GET', '/v1/customers', undefined],
    ['GET', '/v1/customers/by-global-id/3f2504e0-4f89-41d3-9a0c-0305e82c3301', undefined],
    ['GET', '/v1/customers/existing-id', undefined],
    ['PATCH', '/v1/customers/existing-id', { phone: '+56900000000' }],
    ['DELETE', '/v1/customers/existing-id', undefined],
  ];

  it.each(STAFF_ROUTES)('%s %s answers 403 and touches no row', async (method, path, body) => {
    const res = await request(method, path, {
      ...(body ? { body } : {}),
      headers: { 'X-User-Role': 'customer' },
    });

    expect(res.status).toBe(403);
    const payload = await res.json() as any;
    expect(payload.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('keeps the public registration open, which carries no token at all', async () => {
    const res = await request('PUT', '/v1/customers', {
      auth: false,
      body: { fullName: 'Ada Lovelace', phone: '+56912345678', businessSlug: 'cafe-del-barrio' },
    });

    // It took the public branch: the business is resolved from the slug, and
    // this mock holds no tenant for it. A 403 would mean the token gate ran.
    expect(res.status).toBe(404);
    const payload = await res.json() as any;
    expect(payload.error.message).toBe('Business "cafe-del-barrio" not found');
  });

  it('still lets a cashier list the customers', async () => {
    const res = await request('GET', '/v1/customers', { headers: { 'X-User-Role': 'cashier' } });

    expect(res.status).toBe(200);
  });
});

describe('POS lookup (GET /v1/customers/lookup)', () => {
  // The suite-wide reset lives inside `describe('CRUD Routes')`, so without this
  // these tests inherit the previous one's `select` mock — which is how a lookup
  // test ends up passing against a chain that ignores the registry.
  beforeEach(() => {
    resetMocks();
  });

  // -----------------------------------------------------------------------
  // 1. Tenant isolation — the test this whole surface hangs on
  // -----------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('scopes the customer query to the tenant in the token', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });

      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      expect(res.status).toBe(200);

      const where = lookupCustomerWhere();
      expect(where.sql).toContain('"customers"."business_id"');
      expect(where.params).toContain('biz-1');
    });

    it('scopes the pass, balance and tier reads to the same tenant', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });

      await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));

      // A pass row is read by customer_id; without tenant_id a customer id from
      // another tenant's read would be indistinguishable from this one's.
      expect(wheresFor('customerWalletPasses')[0].sql).toContain(
        '"customer_wallet_passes"."tenant_id"',
      );
      expect(wheresFor('pointsTransactions')[0].sql).toContain(
        '"points_transactions"."business_id"',
      );
      expect(wheresFor('membershipTiers')[0].sql).toContain(
        '"membership_tiers"."business_id"',
      );
    });

    it('ignores a businessId supplied in the query string', async () => {
      // A caller cannot redirect the lookup at another tenant. The only
      // businessId that reaches SQL is the one the gateway put in the headers.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });

      await request(
        'GET',
        `${lookupPath('phone', LOOKUP_CUSTOMER.phone)}&businessId=biz-other`,
      );

      const params = lookupCustomerWhere().params as unknown[];
      expect(params).toContain('biz-1');
      expect(params).not.toContain('biz-other');
    });

    it('answers "not registered" rather than another tenant\'s customer', async () => {
      // Behavioural half: with no row visible to this tenant, the honest answer
      // is the same 404 a cashier sees for an unknown person — never a row.
      mockDb.select.mockImplementation(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.orderBy = vi.fn(() => chain);
        chain.limit = vi.fn(() => chain);
        chain.then = (resolve: (v: any) => any) => Promise.resolve([]).then(resolve);
        return chain;
      });

      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone), {
        headers: { 'X-Business-Id': 'biz-other' },
      });

      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error.code).toBe('CUSTOMER_NOT_REGISTERED');
      // No identity of any kind leaks on the miss path.
      expect(JSON.stringify(body)).not.toContain('Ana');
      expect(body.data).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2. No list, ever
  // -----------------------------------------------------------------------

  describe('no list', () => {
    it('requires an identifier', async () => {
      seedLookup();
      const res = await request('GET', '/v1/customers/lookup');
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('LOOKUP_IDENTIFIER_REQUIRED');
    });

    it('refuses two identifiers at once', async () => {
      // One person, one way of naming them. Two identifiers is either a
      // confused client or the first step of a search that returns a list.
      seedLookup();
      const res = await request(
        'GET',
        `${lookupPath('phone', LOOKUP_CUSTOMER.phone)}&email=ana%40test.com`,
      );
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error.code).toBe('LOOKUP_IDENTIFIER_REQUIRED');
    });

    it('matches by equality, never by pattern', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });

      await request('GET', lookupPath('email', LOOKUP_CUSTOMER.email));

      const [where] = wheresFor('customers');
      // A wildcard anywhere in the identifier is how `%` finds eleven people.
      expect(where.params).not.toContain('%569%');
      expect(where.sql).not.toMatch(/like/i);
      // The whole identifier travels to SQL as one exact parameter.
      expect(where.params).toContain(LOOKUP_CUSTOMER.email);
    });

    it('never narrows the match to several customers', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(Array.isArray(body.data)).toBe(false);
      expect(Array.isArray(body.data.items)).toBe(false);
      expect(body.data.id).toBe(LOOKUP_CUSTOMER.id);
    });

    it('treats a wildcard a cashier typed as a literal, not a pattern', async () => {
      // `%` is the whole attack: under LIKE it matches every customer in the
      // tenant, which is the list this endpoint must not be able to produce.
      //
      // The suite's db mock resolves rows from a registry and never executes the
      // WHERE, so this asserts on the statement the route built. Swapping `eq`
      // for `ilike` is what breaks it.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      await request('GET', lookupPath('phone', '%'));

      const where = lookupCustomerWhere();
      expect(where.sql).not.toMatch(/like/i);
      expect(where.sql).toContain('"customers"."phone" =');
      // The wildcard is a bound value, never concatenated into the SQL text.
      expect(where.params).toContain('%');
    });

    it('binds the identifier as a parameter instead of splicing it into SQL', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      await request('GET', lookupPath('email', '%_@test.com'));

      const where = lookupCustomerWhere();
      expect(where.params).toContain('%_@test.com');
      expect(where.sql).not.toContain('%');
      expect(where.sql).not.toContain('_@');
    });
  });

  // -----------------------------------------------------------------------
  // 3. not_issued and not_saved are different facts
  // -----------------------------------------------------------------------

  describe('pass state honesty', () => {
    it('reports not_issued as our gap, not as "has no pass"', async () => {
      seedLookup({ pass: [{ state: 'not_issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      // Verbatim. The UI decides what to say; the API must not pre-judge it by
      // collapsing the state into a boolean.
      expect(body.data.pass.state).toBe('not_issued');
      expect(body.data.pass.hasPass).toBeUndefined();
    });

    it('reports not_saved as Google having checked', async () => {
      seedLookup({ pass: [{ state: 'not_saved', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(body.data.pass.state).toBe('not_saved');
      expect(body.data.pass.hasPass).toBeUndefined();
    });

    it('distinguishes no pass row at all from either state', async () => {
      // No row means a save link was never issued — a third fact, and not the
      // same as a row sitting at `not_issued`.
      seedLookup({ pass: null });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(body.data.pass.state).toBeNull();
    });

    it('keeps the three facts pairwise distinct across responses', async () => {
      const seen: unknown[] = [];
      for (const pass of [
        null,
        [{ state: 'not_issued', lastSyncedAt: null }],
        [{ state: 'not_saved', lastSyncedAt: null }],
        [{ state: 'issued', lastSyncedAt: null }],
      ]) {
        seedLookup({ pass });
        const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
        seen.push(((await res.json()) as any).data.pass.state);
      }

      expect(new Set(seen).size).toBe(4);
    });

    it('carries lastSyncedAt so a stale answer is visible', async () => {
      const syncedAt = new Date('2026-02-01T10:00:00.000Z');
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: syncedAt }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(body.data.pass.lastSyncedAt).toBe(syncedAt.toISOString());
    });
  });

  // -----------------------------------------------------------------------
  // 4. Two records for one phone is said out loud
  // -----------------------------------------------------------------------

  describe('ambiguous phone', () => {
    it('refuses to pick one of two customers', async () => {
      // `uq_customers_business_phone` should make this unreachable. The guard
      // is here because a constraint can be absent on an older database, and
      // `.limit(1)` would turn that into "we served a random person".
      seedLookup({
        customer: [
          LOOKUP_CUSTOMER,
          { ...LOOKUP_CUSTOMER, id: 'cust-other', fullName: 'Ana Ruiz Dos' },
        ],
      });

      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));

      expect(res.status).toBe(409);
      const body = await res.json() as any;
      expect(body.error.code).toBe('CUSTOMER_PHONE_AMBIGUOUS');
      // A cashier cannot act on this, and the response must not hand them one
      // of the two people to act on.
      expect(body.data).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('Ana Ruiz');
      expect(JSON.stringify(body)).not.toContain('cust-other');
    });

    it('does not report ambiguity for a single match', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      expect(res.status).toBe(200);
    });

    it('reads at most two rows, so the conflict is detectable', async () => {
      seedLookup({
        customer: [LOOKUP_CUSTOMER, { ...LOOKUP_CUSTOMER, id: 'cust-other' }],
      });
      await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));

      const [call] = callsFor('customers').filter((c) =>
        IDENTIFIER_COLUMNS.some((col) => compile(c.where).sql.includes(col)),
      );
      // `.limit(1)` would make the ambiguity check unreachable: the conflict
      // would be resolved by the database's row order, silently.
      expect(call?.limit).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 5. An honest 404, distinguishable from a system error
  // -----------------------------------------------------------------------

  describe('honest 404', () => {
    it('uses a code the UI can offer registration from', async () => {
      seedLookup({ customer: null });
      const res = await request('GET', lookupPath('phone', '+56999999999'));
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error.code).toBe('CUSTOMER_NOT_REGISTERED');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
    });

    it('is a different code from a bad request and from a refusal', async () => {
      seedLookup({ customer: null });
      const notFound = await (await request('GET', lookupPath('phone', '+56999999999'))).json() as any;
      const badRequest = await (await request('GET', '/v1/customers/lookup')).json() as any;
      const refused = await (
        await request('GET', lookupPath('phone', '+56999999999'), {
          headers: { 'X-User-Role': 'customer' },
        })
      ).json() as any;

      const codes = [notFound, badRequest, refused].map((b) => b.error.code);
      expect(new Set(codes).size).toBe(3);
    });

    it('treats a soft-deleted customer as not registered', async () => {
      // The filter that hides soft-deleted rows is the only thing between a
      // deleted customer and a 200 with their balance on the counter.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));

      const where = lookupCustomerWhere();
      expect(where.sql).toContain('"customers"."deleted_at"');
      expect(where.sql).toMatch(/is null/i);
    });
  });

  // -----------------------------------------------------------------------
  // 6. The QR path that already worked
  // -----------------------------------------------------------------------

  describe('QR path is untouched', () => {
    it('still resolves a customer by globalId', async () => {
      // No projection on this route — it selects the whole row.
      setTableResults({
        [key('customers')]: [LOOKUP_CUSTOMER],
        [key('pointsTransactions', { balance_after: 1 })]: [{ balance_after: 320 }],
        [key('membershipTiers')]: [LOOKUP_TIER],
      });

      const res = await request(
        'GET',
        `/v1/customers/by-global-id/${LOOKUP_CUSTOMER.globalId}`,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.id).toBe(LOOKUP_CUSTOMER.id);
      expect(body.data.points).toBe(320);
    });

    it('still resolves a globalId through the new route too', async () => {
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('globalId', LOOKUP_CUSTOMER.globalId));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.id).toBe(LOOKUP_CUSTOMER.id);
    });
  });

  // -----------------------------------------------------------------------
  // 7. No PII in the logs
  // -----------------------------------------------------------------------

  describe('no PII in logs', () => {
    it('logs nothing identifiable on any lookup path', async () => {
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        }),
      );

      const statuses: number[] = [];
      try {
        seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
        statuses.push(
          (await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone))).status,
        );

        seedLookup({ customer: null });
        statuses.push(
          (await request('GET', lookupPath('phone', '+56999999999'))).status,
        );

        seedLookup({
          customer: [LOOKUP_CUSTOMER, { ...LOOKUP_CUSTOMER, id: 'cust-other' }],
        });
        statuses.push(
          (await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone))).status,
        );

        seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
        statuses.push(
          (await request('GET', lookupPath('email', LOOKUP_CUSTOMER.email))).status,
        );
      } finally {
        for (const spy of spies) spy.mockRestore();
      }

      // The route really ran. Without this the assertions below also hold when
      // no endpoint exists and every call 404s at the router, which is how a
      // logging test passes without having exercised anything.
      expect(statuses).toEqual([200, 404, 409, 200]);

      const dump = lines.join('\n');
      expect(dump).not.toContain(LOOKUP_CUSTOMER.phone);
      expect(dump).not.toContain(LOOKUP_CUSTOMER.email);
      expect(dump).not.toContain(LOOKUP_CUSTOMER.fullName);
      expect(dump).not.toContain('+56999999999');
    });
  });

  // -----------------------------------------------------------------------
  // Roles: the counter surface, and why cashier belongs here
  // -----------------------------------------------------------------------

  describe('roles', () => {
    it('serves a cashier', async () => {
      // `users.role` defaults to 'cashier' (schema.ts). The person at the
      // counter is the whole reason this endpoint exists, so a deny-list that
      // excluded them would exclude the product.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone), {
        headers: { 'X-User-Role': 'cashier' },
      });
      expect(res.status).toBe(200);
    });

    it('refuses a customer token', async () => {
      // The customer app must not resolve other customers at the counter.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone), {
        headers: { 'X-User-Role': 'customer' },
      });
      expect(res.status).toBe(403);
      const body = await res.json() as any;
      expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    });
  });

  // -----------------------------------------------------------------------
  // The payload the counter renders
  // -----------------------------------------------------------------------

  describe('payload', () => {
    it('carries the balance and tier the cashier needs', async () => {
      seedLookup({
        balance: 1250,
        tier: [LOOKUP_TIER],
        pass: [{ state: 'issued', lastSyncedAt: null }],
      });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(body.data.points).toBe(1250);
      expect(body.data.currentTier).toBe('Oro');
      expect(body.data.tier.multiplier).toBe(1.5);
      expect(body.data.fullName).toBe('Ana Ruiz');
    });

    it('reports a null tier without failing', async () => {
      seedLookup({
        tier: null,
        customer: [{ ...LOOKUP_CUSTOMER, currentTierId: null }],
        pass: [{ state: 'issued', lastSyncedAt: null }],
      });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(res.status).toBe(200);
      expect(body.data.tier).toBeNull();
      expect(body.data.currentTier).toBeNull();
    });

    it('does not expose the member code', async () => {
      // The pass accountId is derived from it; a counter lookup has no use for
      // it and it is an identity value, so it stays out of this payload.
      seedLookup({ pass: [{ state: 'issued', lastSyncedAt: null }] });
      const res = await request('GET', lookupPath('phone', LOOKUP_CUSTOMER.phone));
      const body = await res.json() as any;

      expect(body.data.memberCode).toBeUndefined();
    });
  });
});

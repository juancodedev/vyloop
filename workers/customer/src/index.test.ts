import { setCurrentBusinessId } from '@vyloop/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { HTTPException } from 'hono/http-exception';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { extractAuthHeaders, buildCustomerRegisteredEvent, withRls } from './helpers';

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
  setTableResults,
  resetSelectCalls,
  recordingChain,
  setDialect,
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
  // the actual WHERE / ORDER BY the route produced.
  const selectCalls: Array<{ table: any; where: any; orderBy: any }> = [];

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

  /** Default chain: records the query and resolves from the table registry. */
  function recordingChain(projection?: Record<string, unknown>) {
    const projectionKey =
      !projection || Object.keys(projection).length === 0
        ? '*'
        : Object.keys(projection).sort().join(',');

    const chain: any = {};
    const call: { table: any; where: any; orderBy: any } = {
      table: undefined,
      where: undefined,
      orderBy: undefined,
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
    chain.limit = vi.fn(() => chain);
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
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([
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
            ]),
          ),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
    execute: vi.fn(() => Promise.resolve({ rows: [] })),
  };

  return {
    mockPublish,
    mockValidate,
    mockDb,
    recordingChain,
    tables,
    selectCalls,
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
    createdAt: timestamp('created_at', { withTimezone: true }),
  });

  Object.assign(tables, {
    tenants,
    loyaltyPrograms,
    membershipTiers,
    customers,
    customerEvents,
    consents,
    pointsTransactions,
  });

  return {
    createDb: vi.fn(() => mockDb),
    setCurrentBusinessId: vi.fn(() => ({})),
    tenants,
    loyaltyPrograms,
    membershipTiers,
    customers,
    customerEvents,
    consents,
    pointsTransactions,
  };
});

vi.mock('@vyloop/event-bus', () => ({
  CUSTOMER_REGISTERED: 'CustomerRegistered',
  // GET /v1/customers/me publishes this from its waitUntil block.
  PROFILE_VIEWED: 'ProfileViewed',
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
  mockDb.update.mockImplementation(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          Promise.resolve([
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
          ]),
        ),
      })),
    })),
  }));
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
      createdAt: 1,
    })]: opts.transactions ?? [],
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

    it('rejects invalid event schema before publishing', async () => {
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

      expect(res.status).toBe(500);
      const data = await res.json() as any;
      expect(data.error.code).toBe('VALIDATION_ERROR');

      // Event NOT published
      expect(mockPublish).not.toHaveBeenCalled();
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

    it('ignores business_id from request body', async () => {
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

      const body = { fullName: 'Hacker', business_id: 'biz-evil', businessId: 'biz-evil' };
      const res = await request('PATCH', '/v1/customers/existing-id', { body });

      expect(res.status).toBe(200);

      // Verify business_id was NOT passed to update.set
      const updateSetFn = mockDb.update.mock.results[0]?.value.set;
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.not.objectContaining({ businessId: expect.anything() }),
      );
      expect(updateSetFn).toHaveBeenCalledWith(
        expect.not.objectContaining({ business_id: expect.anything() }),
      );
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

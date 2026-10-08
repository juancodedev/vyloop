// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@vyloop/db', async () => {
  // `membershipTiers` gets a real pgTable so the predicates the routes build
  // compile to SQL a test can read. A flat `{}` would render an opaque chunk
  // and the tenant scope would be unobservable — the mock would accept a
  // cross-tenant comparison as happily as a correct one. `customers` and
  // `pointsTransactions` are real for the same reason: they are the two tables
  // the loyalty ownership check and the points read are scoped against.
  const { pgTable, uuid, integer, numeric, text, timestamp, jsonb } = await import('drizzle-orm/pg-core');
  const tierTable = pgTable('membership_tiers', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    name: text('name').notNull(),
    minPoints: integer('min_points').notNull(),
    multiplier: numeric('multiplier').notNull(),
    displayOrder: integer('display_order').notNull(),
  });
  const customerTable = pgTable('customers', {
    id: uuid('id').primaryKey(),
    globalId: uuid('global_id').notNull(),
    businessId: uuid('business_id').notNull(),
    currentTierId: uuid('current_tier_id'),
    deletedAt: timestamp('deleted_at'),
    // Read by `/v1/loyalty/passes/resolve` and `POST /v1/loyalty/checkins`. Real columns for the
    // reason the other tables are real: a flat `{}` renders an opaque predicate, so
    // a lookup that ignored `businessId` would pass the same test as one that
    // honoured it.
    memberCode: text('member_code'),
    fullName: text('full_name'),
  });
  const pointsTable = pgTable('points_transactions', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    type: text('type').notNull(),
    points: integer('points').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    referenceId: text('reference_id'),
    note: text('note'),
    createdAt: timestamp('created_at').notNull(),
  });
  // `checkins` is real for the same reason. Its tenant predicate and its
  // `onConflictDoNothing` target are both `businessId`, so a flat `{}` would make
  // every cross-tenant assertion on this table pass vacuously.
  const checkinTable = pgTable('checkins', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    memberCode: text('member_code').notNull(),
    paymentId: text('payment_id'),
    amountCents: integer('amount_cents').notNull(),
    items: jsonb('items'),
    note: text('note'),
    points: integer('points'),
    createdAt: timestamp('created_at').notNull(),
  });
  const table = {};
  return {
    createDb: vi.fn(),
    loyaltyPrograms: table,
    membershipTiers: tierTable,
    customers: customerTable,
    pointsTransactions: pointsTable,
    checkins: checkinTable,
    rewards: table,
    rewardGrants: table,
    schema: {},
    setCurrentBusinessId: vi.fn(),
  };
});

vi.mock('@vyloop/event-bus', () => ({
  publish: vi.fn(),
  consume: vi.fn(),
  createEnvelope: vi.fn((type, header, payload) => ({
    id: '00000000-0000-0000-0000-000000000000',
    type,
    source: 'vyloop.gateway',
    specversion: '1.0',
    time: new Date().toISOString(),
    header,
    payload,
  })),
  POINTS_ASSIGNED: 'PointsAssigned',
  REWARD_REDEEMED: 'RewardRedeemed',
  REWARD_AUTO_GRANTED: 'RewardAutoGranted',
  CUSTOMER_REGISTERED: 'CustomerRegistered',
}));

// ---------------------------------------------------------------------------
// Imports (happen after mock hoisting)
// ---------------------------------------------------------------------------

import { createDb } from '@vyloop/db';
import { publish } from '@vyloop/event-bus';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { isCustomerRole, isCounterSubject, requireOperatorRole } from './helpers';

import app from './index';

type MockFn = ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock DB builder — mimics Drizzle's thenable chain
// ---------------------------------------------------------------------------

type Builder = any;

function createBuilder(data: unknown = []): Builder {
  const p = Promise.resolve(data);
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.set = vi.fn(() => builder);
  builder.values = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);
  // Needed by `POST /v1/loyalty/checkins`, whose insert is `ON CONFLICT DO NOTHING`. The
  // mock cannot enforce the unique index, so the conflict branch of that route is
  // driven by what the insert returns — documented at each such test.
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.then = p.then.bind(p);
  builder.catch = p.catch.bind(p);
  builder.finally = p.finally.bind(p);
  return builder;
}

interface MockDb {
  select: MockFn;
  insert: MockFn;
  update: MockFn;
  delete: MockFn;
  execute: MockFn;
  transaction: MockFn;
}

function createMockDb(): MockDb {
  const db: MockDb = {
    select: vi.fn(() => createBuilder()),
    insert: vi.fn(() => createBuilder()),
    update: vi.fn(() => createBuilder()),
    delete: vi.fn(() => createBuilder()),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(),
  };
  db.transaction.mockImplementation(async (cb: (tx: MockDb & { execute: MockFn }) => unknown) => {
    const tx = createBuilder() as MockDb & { execute: MockFn };
    tx.execute = vi.fn(() => Promise.resolve({ rows: [] }));
    return cb(tx);
  });
  return db;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let mockDb: MockDb;

interface TestAuth {
  userId: string;
  businessId: string;
  userRole: string;
}

/** The operator the pre-existing tests were all written against. */
const OPERATOR_AUTH: TestAuth = { userId: 'user-1', businessId: 'biz-1', userRole: 'admin' };

/**
 * A merchant's payment terminal — the only subject the two checkin routes accept.
 *
 * `userId` is the JWT subject, and a counter's subject is namespaced `pos:<id>`.
 * The role is `terminal` and is *not* what the guard asks about: `issueToken`
 * types `role` as a free-form string, so a role allow-list would have to invent a
 * vocabulary the issuer does not define. The subject namespace is the marker, and
 * nothing the issuer hands out today can begin with `pos:` — every other subject
 * is a uuid (`customers.global_id` for the customer app, `users.id` for staff).
 */
const COUNTER_AUTH: TestAuth = {
  userId: 'pos:0f9c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  businessId: 'biz-1',
  userRole: 'terminal',
};

function reqAs(method: string, path: string, auth: TestAuth, body?: unknown) {
  const r = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': auth.userId,
      'X-Business-Id': auth.businessId,
      'X-User-Role': auth.userRole,
    },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  return app.fetch(r, {
    DATABASE_URL: 'postgres://mock',
    DOMAIN_EVENTS_QUEUE: {} as Queue,
    SCHEMA_REGISTRY: {} as KVNamespace,
  } as Record<string, unknown>);
}

function req(method: string, path: string, body?: unknown) {
  return reqAs(method, path, OPERATOR_AUTH, body);
}

const GET = (p: string) => req('GET', p);
const POST = (p: string, b?: unknown) => req('POST', p, b);
const PUT = (p: string, b?: unknown) => req('PUT', p, b);
const DELETE = (p: string) => req('DELETE', p);

/**
 * `POST` as a counter, for the two routes that accept nobody else.
 *
 * `POST` itself keeps defaulting to `OPERATOR_AUTH`, so the operator tests across
 * this file are untouched — only the checkin routes send this instead.
 */
const COUNTER_POST = (p: string, b?: unknown) => reqAs('POST', p, COUNTER_AUTH, b);

function setupDb() {
  mockDb = createMockDb();
  vi.mocked(createDb).mockReturnValue(mockDb as never);
}

// ============================================================================
// Tests
// ============================================================================

describe('Growth Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDb();
  });

  // ==========================================================================
  // GET /v1/loyalty/config
  // ==========================================================================

  describe('GET /v1/loyalty/config', () => {
    it('returns default config skeleton when no program exists', async () => {
      const res = await GET('/v1/loyalty/config');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('1.0');
      expect(json.data.program_name).toBe('Programa de beneficios');
      expect(json.data.is_active).toBe(true);
    });

    it('returns existing program config when program exists', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          {
            id: 'prog-1',
            earnRate: '2.5',
            name: 'Premium',
            pointsCurrency: 'puntos',
            minRedeemPoints: 200,
            pointsExpiryDays: 365,
            isActive: true,
          },
        ]),
      );

      const res = await GET('/v1/loyalty/config');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('2.5');
      expect(json.data.program_name).toBe('Premium');
      expect(json.data.points_currency).toBe('puntos');
      expect(json.data.min_redeem_points).toBe(200);
      expect(json.data.points_expiry_days).toBe(365);
      expect(json.data.is_active).toBe(true);
    });
  });

  // ==========================================================================
  // PUT /v1/loyalty/config
  // ==========================================================================

  describe('PUT /v1/loyalty/config', () => {
    it('updates an existing program when one exists', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Old Name' }]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '2.0', name: 'New Name' }]),
      );

      const res = await PUT('/v1/loyalty/config', {
        earn_rate: '2.0',
        program_name: 'New Name',
      });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('2.0');
      expect(json.data.program_name).toBe('New Name');
    });

    it('creates a new program when none exists (201)', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.5', name: 'New Program' }]),
      );

      const res = await PUT('/v1/loyalty/config', {
        earn_rate: '1.5',
        program_name: 'New Program',
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('1.5');
      expect(json.data.program_name).toBe('New Program');
    });

    it('uses defaults when body is empty for a new program', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', {});

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('1.0');
      expect(json.data.program_name).toBe('Programa de beneficios');
    });
  });

  // ==========================================================================
  // earn_by — the accumulation rule (§7.5 "Mecánica de acumulación")
  // ==========================================================================

  describe('PUT /v1/loyalty/config — earn_rate validation', () => {
    /**
     * An `earn_rate` the program cannot be run with. Every one of these has to
     * be refused at the door: `Number('abc')` is `NaN`, and `NaN` multiplied
     * into `points_transactions.points` corrupts the customer's balance with no
     * error anywhere in the request.
     */
    const UNUSABLE_RATES = [
      { label: 'not a number', value: 'abc' },
      { label: 'the literal string NaN', value: 'NaN' },
      { label: 'Infinity', value: 'Infinity' },
      { label: 'negative', value: '-1.0' },
      { label: 'zero', value: '0' },
      { label: 'absurd (above the ceiling)', value: '1000.01' },
    ] as const;

    it.each(UNUSABLE_RATES)('rejects an earn_rate that is $label', async ({ value }) => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_rate: value });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_EARN_RATE');
      // Nothing written: a rejected rate leaves the stored program as it was.
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('rejects an absurd earn_rate on the insert path too', async () => {
      // The create path is a different branch of the same handler, so a guard
      // that only covered the update branch would leave a brand new program
      // able to hold a rate the earn route cannot use.
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await PUT('/v1/loyalty/config', { earn_rate: 'abc', program_name: 'Nuevo' });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_EARN_RATE');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('accepts a usable earn_rate and stores it', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '2.5', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_rate: '2.5' });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('2.5');
      expect(mockDb.update).toHaveBeenCalledOnce();
    });

    it('accepts the earn_rate at the ceiling', async () => {
      // The boundary belongs to the program: 1000 is refused as absurd and 1000
      // exactly is a number a merchant could plausibly mean.
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1000.0000', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_rate: '1000' });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.data.earn_rate).toBe('1000.0000');
    });
  });

  describe('PUT /v1/loyalty/config — earn_by and the purchase unit', () => {
    it('rejects an earn_by the program cannot run', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_by: 'money' });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_EARN_BY');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'zero', value: 0 },
      { label: 'negative', value: -1000 },
      { label: 'absurd', value: 10_000_001 },
    ])('rejects an earn_unit_amount that is $label', async ({ value }) => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_unit_amount: value });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_EARN_UNIT_AMOUNT');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('switches the program to purchase with its money unit', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([
          {
            id: 'prog-1',
            earnRate: '1.0000',
            earnBy: 'purchase',
            earnUnitAmount: '500.00',
            name: 'Programa de beneficios',
          },
        ]),
      );

      const res = await PUT('/v1/loyalty/config', {
        earn_by: 'purchase',
        earn_unit_amount: 500,
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.data.earn_by).toBe('purchase');
      expect(json.data.earn_unit_amount).toBe('500.00');
    });

    it('refuses to switch to purchase without saying how much money a unit is', async () => {
      // `earn_by: 'purchase'` with the default $1.000 would silently start
      // paying out against a unit the merchant never chose.
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios' }]),
      );

      const res = await PUT('/v1/loyalty/config', { earn_by: 'purchase' });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_EARN_UNIT_AMOUNT');
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('GET /v1/loyalty/config — reports the rule it is actually running', () => {
    it('names the accumulation rule in the default skeleton', async () => {
      const res = await GET('/v1/loyalty/config');

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      // Not a placeholder: the dashboard renders this sentence verbatim, so an
      // absent rule here is what let it promise "1 punto por cada $1.000" to a
      // program that had no money in it.
      expect(json.data.earn_by).toBe('visit');
      expect(json.data.earn_unit_amount).toBe('1000.00');
    });

    it('reports the stored rule', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          {
            id: 'prog-1',
            earnRate: '2.5000',
            earnBy: 'purchase',
            earnUnitAmount: '250.00',
            name: 'Premium',
            pointsCurrency: 'puntos',
            minRedeemPoints: 200,
            pointsExpiryDays: 365,
            isActive: true,
          },
        ]),
      );

      const res = await GET('/v1/loyalty/config');

      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.data.earn_by).toBe('purchase');
      expect(json.data.earn_unit_amount).toBe('250.00');
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/points/assign — the accumulation rule
  // ==========================================================================

  describe('POST /v1/loyalty/points/assign — earning by purchase', () => {
    /**
     * `withRls` eats the first `execute`, so the ledger INSERT is the second.
     * Read back through the real dialect because the number that matters is a
     * bound parameter, not a string in the SQL.
     */
    function mockPurchaseEarn(overrides: {
      program?: Record<string, unknown>;
      customer?: Record<string, unknown>;
      tier?: Record<string, unknown>;
    } = {}) {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          {
            id: 'prog-1',
            earnRate: '1.0000',
            earnBy: 'purchase',
            earnUnitAmount: '1000.00',
            ...overrides.program,
          },
        ]),
      );
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: null, ...overrides.customer }]),
      );
      if (overrides.tier) {
        mockDb.select.mockReturnValueOnce(createBuilder([overrides.tier]));
      }
      // withRls
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', customer_id: 'cust-1', balance_after: 0, points: 0 }],
      });
    }

    /** The `points` value the ledger INSERT was asked to write. */
    function insertedPoints(): unknown {
      const statement = mockDb.execute.mock.calls[1]?.[0];
      const { params } = new PgDialect().sqlToQuery(statement as never);
      return params[2];
    }

    it('derives the points from the money amount, not from a caller point count', async () => {
      mockPurchaseEarn();

      // $12.500 at 1 point per $1.000, no tier.
      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-p-1',
      });

      expect(res.status).toBe(201);
      expect(insertedPoints()).toBe(12);
    });

    it('refuses to take the caller point count as the source of truth', async () => {
      // The whole defect: `points` is caller-computed, so a caller decides the
      // balance. With `earn_by: 'purchase'` the amount is the input, and its
      // absence is reported separately from a malformed one so the caller can tell
      // "wrong field" from "bad value".
      mockPurchaseEarn();

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: 9999,
        reference_id: 'ref-p-2',
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('AMOUNT_REQUIRED');
      expectNoLedgerWrite();
    });

    it('reports a missing amount even when nothing was sent at all', async () => {
      mockPurchaseEarn();

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        reference_id: 'ref-p-2b',
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('AMOUNT_REQUIRED');
      expectNoLedgerWrite();
    });

    it('applies the tier multiplier on top of the money rule', async () => {
      mockPurchaseEarn({
        customer: { currentTierId: 'tier-1' },
        tier: { id: 'tier-1', multiplier: '1.50' },
      });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-p-3',
      });

      expect(res.status).toBe(201);
      // floor(12500 * 1.0 / 1000 * 1.5) = 18
      expect(insertedPoints()).toBe(18);
    });

    it('honours a merchant rule of 3 points per $250', async () => {
      mockPurchaseEarn({ program: { earnRate: '3.0000', earnUnitAmount: '250.00' } });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 1000,
        reference_id: 'ref-p-4',
      });

      expect(res.status).toBe(201);
      // floor(1000 * 3 / 250) = 12
      expect(insertedPoints()).toBe(12);
    });

    it('rounds down, so the merchant never loses money to rounding', async () => {
      mockPurchaseEarn();

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 1999,
        reference_id: 'ref-p-5',
      });

      expect(res.status).toBe(201);
      expect(insertedPoints()).toBe(1);
    });

    /**
     * `withRls` opens the session before any of this is judged, so "no ledger
     * write" means the INSERT never ran — not that the database was never touched.
     */
    function expectNoLedgerWrite() {
      // `setCurrentBusinessId` is a mock returning undefined, so the withRls call
      // carries no compilable statement. Only the real ones are inspected.
      const statements = mockDb.execute.mock.calls
        .map((call) => call[0])
        .filter((arg) => arg !== undefined && arg !== null)
        .map((arg) => new PgDialect().sqlToQuery(arg as never).sql);
      expect(statements.filter((sql) => /points_transactions/.test(sql))).toEqual([]);
    }

    it.each([
      { label: 'zero', value: 0 },
      { label: 'negative', value: -5000 },
      { label: 'not a number', value: 'mucho' },
    ])('refuses an amount that is $label and writes nothing', async ({ value }) => {
      mockPurchaseEarn();

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: value,
        reference_id: 'ref-p-6',
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_AMOUNT');
      expectNoLedgerWrite();
    });
  });

  describe('POST /v1/loyalty/points/assign — earning by visit', () => {
    it('still takes the caller count, which is the whole mechanic of a visit', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'prog-1', earnRate: '1.0000', earnBy: 'visit', earnUnitAmount: '1000.00' },
        ]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 2 }] });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: 2,
        reference_id: 'ref-v-1',
      });

      expect(res.status).toBe(201);
      const statement = mockDb.execute.mock.calls[1]?.[0];
      const { params } = new PgDialect().sqlToQuery(statement as never);
      expect(params[2]).toBe(2);
    });

    it('refuses a money amount it cannot convert into visits', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'prog-1', earnRate: '1.0000', earnBy: 'visit', earnUnitAmount: '1000.00' },
        ]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 2 }] });

      // A visit program has no money rule, so silently ignoring the amount would
      // credit the count the caller happened to also send.
      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-v-2',
      });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VISIT_COUNT_REQUIRED');
    });
  });

  describe('POST /v1/loyalty/points/assign — a stored rate that cannot be used', () => {
    it('never lets NaN reach the ledger when the program holds a broken rate', async () => {
      // Legacy rows predate the write guard, so a bad rate can still be in the
      // database. Falling back to the default is the only safe move: the ledger
      // holds integers, and `NaN` there is a balance nobody can spend.
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: 'abc', earnBy: 'purchase', earnUnitAmount: '1000.00' }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 12 }] });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-bad-rate',
      });

      expect(res.status).toBe(201);
      const statement = mockDb.execute.mock.calls[1]?.[0];
      const { params } = new PgDialect().sqlToQuery(statement as never);
      // The broken rate is ignored in favour of 1.0, so the ledger still gets 12.
      expect(params[2]).toBe(12);
      expect(Number.isNaN(Number(params[2]))).toBe(false);
    });

    it('never lets NaN reach the ledger through a broken tier multiplier', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'prog-1', earnRate: '1.0000', earnBy: 'purchase', earnUnitAmount: '1000.00' },
        ]),
      );
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: 'tier-1' }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'tier-1', multiplier: 'N/A' }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 12 }] });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-bad-mult',
      });

      expect(res.status).toBe(201);
      const statement = mockDb.execute.mock.calls[1]?.[0];
      const { params } = new PgDialect().sqlToQuery(statement as never);
      expect(params[2]).toBe(12);
    });
  });

  // ==========================================================================
  // GET /v1/loyalty/tiers
  // ==========================================================================

  describe('GET /v1/loyalty/tiers', () => {
    it('returns empty list when no tiers exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await GET('/v1/loyalty/tiers');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toEqual([]);
    });

    it('returns tiers ordered by displayOrder', async () => {
      const tiers = [
        { id: 'tier-1', name: 'Bronze', minPoints: 0, displayOrder: 0 },
        { id: 'tier-2', name: 'Silver', minPoints: 100, displayOrder: 1 },
        { id: 'tier-3', name: 'Gold', minPoints: 500, displayOrder: 2 },
      ];
      mockDb.select.mockReturnValueOnce(createBuilder(tiers));

      const res = await GET('/v1/loyalty/tiers');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toHaveLength(3);
      expect((json.data[0] as Record<string, unknown>).name).toBe('Bronze');
      expect((json.data[2] as Record<string, unknown>).name).toBe('Gold');
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/tiers
  // ==========================================================================

  describe('POST /v1/loyalty/tiers', () => {
    it('creates a tier (201) when loyalty program exists', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', name: 'Loyalty Program' }]),
      );
      mockDb.insert.mockReturnValueOnce(
        createBuilder([
          { id: 'tier-1', name: 'Gold', minPoints: 500, multiplier: '2.0' },
        ]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Gold',
        min_points: 500,
        multiplier: 2.0,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Gold');
      expect(json.data.minPoints).toBe(500);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await POST('/v1/loyalty/tiers', { name: 'Gold' });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when no loyalty program exists', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Gold',
        min_points: 500,
        multiplier: 2.0,
      });

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ==========================================================================
  // Tier ladder coherence
  //
  // Ordered by (displayOrder ASC, minPoints ASC) — the same order
  // `GET /v1/loyalty/tiers` and the customer app render — a tenant's minPoints
  // must be non-decreasing. A rung that asks for fewer points than the rung
  // displayed before it is the `barro` defect: the customer pass announces the
  // highest level and then lists a reached rung underneath that claim.
  // ==========================================================================

  const dialect = new PgDialect();

  /**
   * A ladder read that behaves like the real tenant-scoped query.
   *
   * The predicate the route hands drizzle is compiled to SQL, and only the rows
   * that predicate admits are returned. Drop the `business_id` filter from the
   * query and the filter disappears with it, foreign rows leak in, and a
   * coherent ladder reads as broken. Without this the mock would ignore the
   * predicate and the tenant scope could not be tested at all.
   */
  function tenantScopedTiers(rows: Array<Record<string, unknown>>) {
    let admitted = rows;
    const predicates: Array<{ sql: string; params: unknown[] }> = [];

    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.limit = vi.fn(() => builder);
    builder.where = vi.fn((clause: unknown) => {
      if (clause === undefined) return builder;
      const query = dialect.sqlToQuery(clause as never);
      predicates.push(query);
      const businessId = query.params[0];
      admitted = rows.filter((row) => row.businessId === businessId);
      return builder;
    });
    builder.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(admitted).then(onFulfilled, onRejected);
    builder.catch = (onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(admitted).catch(onRejected);
    builder.finally = (onFinally?: () => void) => Promise.resolve(admitted).finally(onFinally);

    return Object.assign(builder, { predicates });
  }

  /** The dev tenant's ladder, exactly as it stood before the bad row. */
  const DEV_TENANT = 'biz-1';
  const devTenantLadder = [
    { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
    { id: 'tier-plata', businessId: DEV_TENANT, name: 'Plata', minPoints: 1000, displayOrder: 2 },
    { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
  ];

  describe('POST /v1/loyalty/tiers — ladder coherence', () => {
    /** program lookup, then the ladder read. */
    function mockProgramThenLadder(ladder: unknown) {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', name: 'Loyalty Program' }]));
      mockDb.select.mockReturnValueOnce(ladder as never);
    }

    it('rejects a tier whose minPoints is below an existing tier with a lower displayOrder (the barro case)', async () => {
      mockProgramThenLadder(tenantScopedTiers(devTenantLadder));

      const res = await POST('/v1/loyalty/tiers', {
        name: 'barro',
        min_points: 1,
        multiplier: 1.0,
        display_order: 4,
      });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, string>>;
      expect(json.error.code).toBe('TIER_ORDERING_CONFLICT');
      // Names both the offending tier and the tier it contradicts, with the
      // numbers — not a bare "invalid input" the caller cannot act on.
      expect(json.error.message).toContain('"barro"');
      expect(json.error.message).toContain('"Oro"');
      expect(json.error.message).toContain('1 points');
      expect(json.error.message).toContain('3000 points');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('accepts a normal tier that keeps the sequence non-decreasing', async () => {
      mockProgramThenLadder(tenantScopedTiers(devTenantLadder));
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'tier-diamante', name: 'Diamante', minPoints: 9000, displayOrder: 4 }]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Diamante',
        min_points: 9000,
        multiplier: 3.0,
        display_order: 4,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Diamante');
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });

    it('accepts two tiers sharing the same displayOrder and the same minPoints', async () => {
      // A shared threshold is a legitimate alias. Strictly-increasing would
      // over-constrain here and is exactly the mistake to avoid.
      mockProgramThenLadder(
        tenantScopedTiers([
          { id: 'tier-a', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-b', businessId: DEV_TENANT, name: 'Bronce Promo', minPoints: 0, displayOrder: 1 },
          { id: 'tier-c', businessId: DEV_TENANT, name: 'Plata', minPoints: 1000, displayOrder: 2 },
        ]),
      );
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'tier-c', name: 'Plata', minPoints: 1000, displayOrder: 2 }]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Plata',
        min_points: 1000,
        multiplier: 1.5,
        display_order: 2,
      });

      expect(res.status).toBe(201);
    });

    it('accepts a tier that shares displayOrder with an existing tier but asks for fewer points', async () => {
      // minPoints ASC is the tie-break inside a shared displayOrder. Without it
      // the 100-point tier lands after the 5000-point one and the ladder looks
      // broken when it is not.
      mockProgramThenLadder(
        tenantScopedTiers([
          { id: 'tier-a', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-b', businessId: DEV_TENANT, name: 'Oro', minPoints: 5000, displayOrder: 2 },
        ]),
      );
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'tier-c', name: 'Plata', minPoints: 100, displayOrder: 2 }]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Plata',
        min_points: 100,
        multiplier: 1.5,
        display_order: 2,
      });

      expect(res.status).toBe(201);
    });

    it('rejects when the ladder is already incoherent, not just when the new tier is the offender', async () => {
      // `barro` already in place: a new top rung is innocent, but the resulting
      // set still decreases. A check that only looks at the candidate's
      // immediate predecessor would wave this through.
      mockProgramThenLadder(
        tenantScopedTiers([
          ...devTenantLadder,
          { id: 'tier-barro', businessId: DEV_TENANT, name: 'barro', minPoints: 1, displayOrder: 4 },
        ]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Diamante',
        min_points: 9000,
        multiplier: 3.0,
        display_order: 5,
      });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, string>>;
      expect(json.error.code).toBe('TIER_ORDERING_CONFLICT');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('does not compare against another tenant\'s tiers', async () => {
      // The foreign ladder is incoherent on its own. Scoped correctly, only
      // this business's single rung is visible, so 100/2 is a valid first rung.
      const ladder = tenantScopedTiers([
        { id: 'mine', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
        { id: 'theirs-oro', businessId: 'biz-other', name: 'Oro', minPoints: 3000, displayOrder: 2 },
        { id: 'theirs-barro', businessId: 'biz-other', name: 'barro', minPoints: 1, displayOrder: 3 },
      ]);
      mockProgramThenLadder(ladder);
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'tier-plata', name: 'Plata', minPoints: 100, displayOrder: 2 }]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Plata',
        min_points: 100,
        multiplier: 1.5,
        display_order: 2,
      });

      expect(res.status).toBe(201);
      // The read really was filtered, and by this business's own id.
      expect(ladder.predicates).toHaveLength(1);
      expect(ladder.predicates[0].sql).toContain('business_id');
      expect(ladder.predicates[0].params).toEqual([DEV_TENANT]);
    });

    it('never names another tenant\'s tier in the rejection message', async () => {
      const ladder = tenantScopedTiers([
        ...devTenantLadder,
        { id: 'theirs', businessId: 'biz-other', name: 'Whisper', minPoints: 1, displayOrder: 9 },
      ]);
      mockProgramThenLadder(ladder);

      const res = await POST('/v1/loyalty/tiers', {
        name: 'barro',
        min_points: 1,
        multiplier: 1.0,
        display_order: 4,
      });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, string>>;
      expect(json.error.message).toContain('"Oro"');
      expect(json.error.message).not.toContain('Whisper');
    });
  });

  describe('PUT /v1/loyalty/tiers/:id — ladder coherence', () => {
    /** the tier lookup, then the ladder read. */
    function mockTierThenLadder(existing: unknown, ladder: unknown) {
      mockDb.select.mockReturnValueOnce(createBuilder([existing]));
      mockDb.select.mockReturnValueOnce(ladder as never);
    }

    it('rejects a change that would break the invariant', async () => {
      mockTierThenLadder(
        { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        tenantScopedTiers([
          { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-plata', businessId: DEV_TENANT, name: 'Plata', minPoints: 1000, displayOrder: 2 },
          { id: 'tier-diamante', businessId: DEV_TENANT, name: 'Diamante', minPoints: 9000, displayOrder: 4 },
        ]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-oro', { min_points: 12000 });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, string>>;
      expect(json.error.code).toBe('TIER_ORDERING_CONFLICT');
      expect(json.error.message).toContain('"Oro"');
      expect(json.error.message).toContain('"Diamante"');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('accepts a name-only change', async () => {
      // A rename that touches no threshold must go through, even though another
      // tier in the ladder shares this one's exact threshold.
      mockTierThenLadder(
        { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        tenantScopedTiers([
          { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-oro-legacy', businessId: DEV_TENANT, name: 'Oro Legacy', minPoints: 3000, displayOrder: 2 },
        ]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-oro', name: 'Oro', minPoints: 3000, displayOrder: 3 }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-oro', { name: 'Oro' });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.id).toBe('tier-oro');
      expect(mockDb.update).toHaveBeenCalledOnce();
    });

    it('accepts a tier moved earlier in display_order, so it is not compared against its own stored row', async () => {
      // Moving Oro to display_order 1 leaves the merged set coherent:
      // Bronce 0/1, Oro 3000/1, Diamante 9000/2. If the tier being updated stayed
      // in the comparison set at its stored position (3000/3), Diamante's 9000
      // would follow a 3000 and the ladder would read as broken.
      mockTierThenLadder(
        { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        tenantScopedTiers([
          { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-diamante', businessId: DEV_TENANT, name: 'Diamante', minPoints: 9000, displayOrder: 2 },
          // this row IS the tier being updated, at its stored position
          { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        ]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-oro', name: 'Oro', minPoints: 3000, displayOrder: 1 }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-oro', { display_order: 1 });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.displayOrder).toBe(1);
    });

    it('evaluates the merged result: raising min_points in step with display_order is accepted', async () => {
      // 12000 alone would break the ladder. Moving to display_order 5 makes the
      // stored result coherent, so judging the body without the stored
      // display_order would wrongly refuse the write.
      mockTierThenLadder(
        { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        tenantScopedTiers([
          { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-plata', businessId: DEV_TENANT, name: 'Plata', minPoints: 1000, displayOrder: 2 },
          { id: 'tier-diamante', businessId: DEV_TENANT, name: 'Diamante', minPoints: 9000, displayOrder: 4 },
        ]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-oro', name: 'Oro', minPoints: 12000, displayOrder: 5 }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-oro', {
        min_points: 12000,
        display_order: 5,
      });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.minPoints).toBe(12000);
      expect(json.data.displayOrder).toBe(5);
    });

    it('evaluates the merged result: lowering min_points without lowering display_order is rejected', async () => {
      // The stored display_order is what stays put, so Diamante still sorts
      // after Oro and the merged sequence 0 / 1000 / 3000 / 500 decreases.
      mockTierThenLadder(
        { id: 'tier-diamante', businessId: DEV_TENANT, name: 'Diamante', minPoints: 9000, displayOrder: 4 },
        tenantScopedTiers([
          { id: 'tier-bronce', businessId: DEV_TENANT, name: 'Bronce', minPoints: 0, displayOrder: 1 },
          { id: 'tier-plata', businessId: DEV_TENANT, name: 'Plata', minPoints: 1000, displayOrder: 2 },
          { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        ]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-diamante', { min_points: 500 });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, string>>;
      expect(json.error.code).toBe('TIER_ORDERING_CONFLICT');
      expect(json.error.message).toContain('"Diamante"');
      expect(json.error.message).toContain('"Oro"');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('reads the ladder under this tenant\'s own id', async () => {
      const ladder = tenantScopedTiers(devTenantLadder);
      mockTierThenLadder(
        { id: 'tier-oro', businessId: DEV_TENANT, name: 'Oro', minPoints: 3000, displayOrder: 3 },
        ladder,
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-oro', name: 'Oro', minPoints: 3000, displayOrder: 3 }]),
      );

      await PUT('/v1/loyalty/tiers/tier-oro', { name: 'Oro' });

      expect(ladder.predicates).toHaveLength(1);
      expect(ladder.predicates[0].sql).toContain('business_id');
      expect(ladder.predicates[0].params).toEqual([DEV_TENANT]);
    });
  });

  // ==========================================================================
  // PUT /v1/loyalty/tiers/:id
  // ==========================================================================

  describe('PUT /v1/loyalty/tiers/:id', () => {
    it('updates an existing tier', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Bronze', minPoints: 0, multiplier: '1.0' }]),
      );
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Silver', minPoints: 100, multiplier: '1.5' }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-1', {
        name: 'Silver',
        min_points: 100,
        multiplier: 1.5,
      });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Silver');
    });

    it('returns 404 when tier does not exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await PUT('/v1/loyalty/tiers/tier-unknown', { name: 'Gold' });

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns existing data when no fields to update', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Bronze', minPoints: 0, multiplier: '1.0' }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-1', {});

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Bronze');
    });
  });

  // ==========================================================================
  // DELETE /v1/loyalty/tiers/:id
  // ==========================================================================

  describe('DELETE /v1/loyalty/tiers/:id', () => {
    it('deletes a tier (204)', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-2', name: 'Silver', minPoints: 100 }]),
      );
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ total: 0 }]),
      );

      const res = await DELETE('/v1/loyalty/tiers/tier-2');

      expect(res.status).toBe(204);
    });

    it('returns 404 when tier does not exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await DELETE('/v1/loyalty/tiers/tier-unknown');

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 when deleting the lowest tier (min_points = 0)', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Bronze', minPoints: 0 }]),
      );

      const res = await DELETE('/v1/loyalty/tiers/tier-1');

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('PROTECTED_TIER');
    });

    it('returns 409 when tier has active customers', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-2', name: 'Silver', minPoints: 100 }]),
      );
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ total: 5 }]),
      );

      const res = await DELETE('/v1/loyalty/tiers/tier-2');

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('TIER_HAS_CUSTOMERS');
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/points/assign
  // ==========================================================================

  describe('POST /v1/loyalty/points/assign', () => {
    it('assigns points successfully (201) and publishes event', async () => {
      // program exists with earn_rate 2.0
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '2.0' }]),
      );
      // customer exists with tier
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: 'tier-1' }]),
      );
      // tier with multiplier 1.5
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', multiplier: '1.5' }]),
      );
      // withRls consumes the first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // execute returns the transaction
      mockDb.execute.mockResolvedValueOnce({
        rows: [
          { id: 'tx-1', balance_after: 300, customer_id: 'cust-1', business_id: 'biz-1', type: 'earn', points: 300, reference_id: 'ref-1' },
        ],
      });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.id).toBe('tx-1');

      // points = 100 * 2.0 (earn_rate) * 1.5 (multiplier) = 300
      expect(publish).toHaveBeenCalledOnce();
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await POST('/v1/loyalty/points/assign', { points: 100 });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when points is negative', async () => {
      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: -5,
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 409 on duplicate reference_id', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', earnRate: '1.0' }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      // withRls consumes the first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // The actual insert throws duplicate error
      mockDb.execute.mockRejectedValueOnce({
        message: 'duplicate key value violates unique constraint "uq_points_tx_reference"',
        code: '23505',
      });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: 50,
        reference_id: 'dup-ref',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('DUPLICATE_REFERENCE');
    });

    it('uses default earn_rate = 1.0 and multiplier = 1.0 when no program or customer tier', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([])); // no program
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: undefined }]));
      // withRls consumes the first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: 50 }],
      });

      const res = await POST('/v1/loyalty/points/assign', {
        customer_id: 'cust-1',
        points: 50,
        reference_id: 'ref-2',
      });

      expect(res.status).toBe(201);
      expect(publish).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/rewards
  // ==========================================================================

  describe('POST /v1/loyalty/rewards', () => {
    it('creates a reward (201)', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([])); // no duplicate name
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card', pointsCost: 500 }]),
      );

      const res = await POST('/v1/loyalty/rewards', {
        name: 'Gift Card',
        points_cost: 500,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Gift Card');
    });

    it('returns 400 without name', async () => {
      const res = await POST('/v1/loyalty/rewards', { points_cost: 500 });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 without points_cost', async () => {
      const res = await POST('/v1/loyalty/rewards', { name: 'Gift Card' });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when points_cost is not a positive integer', async () => {
      const res = await POST('/v1/loyalty/rewards', {
        name: 'Bad',
        points_cost: 0,
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate name', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'existing' }]));

      const res = await POST('/v1/loyalty/rewards', {
        name: 'Gift Card',
        points_cost: 500,
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('DUPLICATE_REWARD_NAME');
    });
  });

  // ==========================================================================
  // GET /v1/loyalty/rewards (list)
  // ==========================================================================

  describe('GET /v1/loyalty/rewards (list)', () => {
    it('returns paginated rewards', async () => {
      const rewards = [
        { id: 'rw-1', name: 'Gift Card', pointsCost: 500 },
        { id: 'rw-2', name: 'Discount 10%', pointsCost: 200 },
      ];
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 2 }])); // count
      mockDb.select.mockReturnValueOnce(createBuilder(rewards)); // items

      const res = await GET('/v1/loyalty/rewards');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toHaveLength(2);
      const meta = json.meta as unknown as Record<string, unknown>;
      expect(meta.total).toBe(2);
      expect(meta.page).toBe(1);
      expect(meta.per_page).toBe(20);
    });

    it('supports ?category= filter', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 1 }]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card', category: 'gift' }]),
      );

      const res = await GET('/v1/loyalty/rewards?category=gift');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toHaveLength(1);
    });

    it('supports ?active=true filter', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 1 }]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Active Reward' }]),
      );

      const res = await GET('/v1/loyalty/rewards?active=true');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toHaveLength(1);
    });

    it('supports custom pagination', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 50 }]));
      mockDb.select.mockReturnValueOnce(
        createBuilder(Array.from({ length: 5 }, (_, i) => ({ id: `rw-${i}` }))),
      );

      const res = await GET('/v1/loyalty/rewards?page=3&per_page=5');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      expect(json.data).toHaveLength(5);
      const meta = json.meta as unknown as Record<string, unknown>;
      expect(meta.page).toBe(3);
      expect(meta.per_page).toBe(5);
    });

    it('clamps per_page to max 100', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 200 }]));
      mockDb.select.mockReturnValueOnce(
        createBuilder(Array.from({ length: 100 }, (_, i) => ({ id: `rw-${i}` }))),
      );

      const res = await GET('/v1/loyalty/rewards?per_page=999');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown[]>;
      const meta = json.meta as unknown as Record<string, unknown>;
      expect(meta.per_page).toBe(100);
    });
  });

  // ==========================================================================
  // GET /v1/loyalty/rewards/:id
  // ==========================================================================

  describe('GET /v1/loyalty/rewards/:id', () => {
    it('returns a reward by id', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card', pointsCost: 500 }]),
      );

      const res = await GET('/v1/loyalty/rewards/rw-1');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.id).toBe('rw-1');
    });

    it('returns 404 when reward not found', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await GET('/v1/loyalty/rewards/rw-unknown');

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ==========================================================================
  // PUT /v1/loyalty/rewards/:id
  // ==========================================================================

  describe('PUT /v1/loyalty/rewards/:id', () => {
    it('updates a reward', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Old Name', pointsCost: 500 }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([])); // no name collision
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'New Name', pointsCost: 600 }]),
      );

      const res = await PUT('/v1/loyalty/rewards/rw-1', {
        name: 'New Name',
        points_cost: 600,
      });

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('New Name');
    });

    it('returns 404 when reward does not exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await PUT('/v1/loyalty/rewards/rw-unknown', { name: 'Nope' });

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });

    it('returns 409 on duplicate name', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Original', pointsCost: 500 }]),
      );
      // Name collision: another reward already has the new proposed name
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-2' }]),
      );

      const res = await PUT('/v1/loyalty/rewards/rw-1', {
        name: 'Duplicated', // Different from existing — triggers collision check
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('DUPLICATE_REWARD_NAME');
    });

    it('returns existing data when no fields to update', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Same Name', pointsCost: 500 }]),
      );

      const res = await PUT('/v1/loyalty/rewards/rw-1', {});

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.name).toBe('Same Name');
    });
  });

  // ==========================================================================
  // DELETE /v1/loyalty/rewards/:id
  // ==========================================================================

  describe('DELETE /v1/loyalty/rewards/:id', () => {
    it('soft-deletes a reward', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card' }]),
      );

      const res = await DELETE('/v1/loyalty/rewards/rw-1');

      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.data.id).toBe('rw-1');
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('returns 404 when reward does not exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await DELETE('/v1/loyalty/rewards/rw-unknown');

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/rewards/redeem
  // ==========================================================================

  describe('POST /v1/loyalty/rewards/redeem', () => {
    it('redeems points without reward_id (201)', async () => {
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] });
      // insert
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: 400, customer_id: 'cust-1' }],
      });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'ref-redeem-1',
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, unknown>;
      expect((json.data as Record<string, unknown>).id).toBe('tx-1');
      expect(json.fulfilled).toBe(100);
      expect(json.requested).toBe(100);
      expect(json.partial).toBe(false);
      expect(publish).toHaveBeenCalledOnce();
    });

    it('returns 400 on missing fields', async () => {
      const res = await POST('/v1/loyalty/rewards/redeem', { points: 100 });

      expect(res.status).toBe(400);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 on negative points', async () => {
      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: -1,
        reference_id: 'bad',
      });

      expect(res.status).toBe(400);
    });

    it('returns 409 on duplicate reference', async () => {
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] });
      // insert throws duplicate error — caught by try/catch
      mockDb.execute.mockRejectedValueOnce({
        message: 'duplicate key value violates unique constraint "uq_points_tx_reference"',
        code: '23505',
      });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'dup-ref',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('DUPLICATE_REFERENCE');
    });

    it('returns 409 insufficient balance', async () => {
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query returns 50 < 100
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 50 }] });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('returns 201 partial when partial:true and balance < requested', async () => {
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query returns 30 < 100
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 30 }] });
      // partial insert
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: 0 }],
      });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'ref-partial',
        partial: true,
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, unknown>;
      expect(json.partial).toBe(true);
      expect(json.fulfilled).toBe(30);
      expect(json.requested).toBe(100);
    });

    it('returns 409 when balance is 0 even with partial:true', async () => {
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query returns 0
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 0 }] });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reference_id: 'ref-zero',
        partial: true,
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INSUFFICIENT_BALANCE');
    });

    // --- Reward catalog validations ---

    it('returns 404 when reward_id does not exist', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-unknown',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(404);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('REWARD_NOT_FOUND');
    });

    it('returns 404 when reward is deleted', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', deletedAt: '2025-01-01', pointsCost: 50 }]),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(404);
    });

    it('returns 409 when reward is not yet active (validFrom in the future)', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', validFrom: futureDate, pointsCost: 50 }]),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('REWARD_INACTIVE');
    });

    it('returns 409 when reward has expired', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', validUntil: pastDate, pointsCost: 50 }]),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('REWARD_INACTIVE');
    });

    it('returns 409 when reward is out of stock', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', stock: 0, pointsCost: 50 }]),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('REWARD_OUT_OF_STOCK');
    });

    it('returns 409 when points are insufficient for the reward', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', stock: 10, pointsCost: 500 }]),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-1',
      });

      expect(res.status).toBe(409);
      const json = await res.json() as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INSUFFICIENT_POINTS');
    });

    it('redeems with reward_id successfully in a transaction (201)', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', stock: 10, pointsCost: 50, name: 'Gift Card' }]),
      );
      // withRls consumes first execute
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      // balance query
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] });

      const txExec = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 450 }] })
        .mockResolvedValueOnce({ rows: [] });
      mockDb.transaction.mockImplementationOnce(async (cb: (tx: { execute: MockFn }) => unknown) => {
        return cb({ execute: txExec });
      });

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-1',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-full',
      });

      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, unknown>;
      expect((json.data as Record<string, unknown>).id).toBe('tx-1');
      expect(json.fulfilled).toBe(100);
      expect(json.partial).toBe(false);
      expect(txExec).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // Customer ownership
  //
  // `X-Business-Id` scopes to the TENANT and says nothing about which customer
  // inside it. Both loyalty routes also took a `customer_id` from the client,
  // so a customer could omit it and read the whole tenant's movement history,
  // or name someone else and spend their balance.
  //
  // The token is now the only authority for the `customer` role: the subject
  // (`X-User-Id`, a `globalId`) is resolved to the tenant's own customer row,
  // and a `customer_id` that disagrees is a 403 rather than a silent rewrite.
  // Operator and admin are untouched — the dashboard POS redeems on behalf of a
  // scanned customer, and the read route still lists the tenant when they name
  // nobody.
  // ==========================================================================

  const CUSTOMER = { userId: 'gid-alice', businessId: DEV_TENANT, userRole: 'customer' };

  /** A second merchant: the tenant an id from here must never be honoured in. */
  const OTHER_TENANT = 'biz-2';

  /**
   * `cust-alice-biz2` deliberately comes FIRST. It is the same person in
   * another merchant, and it shares her `globalId` — so a lookup that resolves
   * the subject but forgets the `business_id` scope lands on the wrong
   * customer instead of accidentally landing on the right one. Ordering the
   * rows this way is what makes that mistake observable rather than invisible.
   */
  const CUSTOMER_ROWS = [
    { id: 'cust-alice-biz2', globalId: 'gid-alice', businessId: OTHER_TENANT, deletedAt: null },
    { id: 'cust-alice', globalId: 'gid-alice', businessId: DEV_TENANT, deletedAt: null },
    { id: 'cust-bob', globalId: 'gid-bob', businessId: DEV_TENANT, deletedAt: null },
    { id: 'cust-withdrawn', globalId: 'gid-dana', businessId: DEV_TENANT, deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'cust-carol', globalId: 'gid-carol', businessId: OTHER_TENANT, deletedAt: null },
  ];

  const TRANSACTION_ROWS = [
    { id: 'tx-alice-1', businessId: DEV_TENANT, customerId: 'cust-alice', type: 'earn', points: 500, balanceAfter: 500, referenceId: 'sale-1', note: 'compra', createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'tx-alice-2', businessId: DEV_TENANT, customerId: 'cust-alice', type: 'redeem', points: 200, balanceAfter: 300, referenceId: 'redeem-1', note: 'Gift Card', createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'tx-bob-1', businessId: DEV_TENANT, customerId: 'cust-bob', type: 'earn', points: 900, balanceAfter: 900, referenceId: 'sale-2', note: 'compra', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'tx-carol-1', businessId: OTHER_TENANT, customerId: 'cust-carol', type: 'earn', points: 4000, balanceAfter: 4000, referenceId: 'sale-3', note: 'compra', createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  /**
   * Read the `col = $n` pairs out of a compiled predicate, mapped to the
   * fixture key they constrain.
   *
   * A column the SQL does not mention is simply absent from the result: that
   * is the whole point. A lookup that stops filtering on a column stops
   * filtering on it, foreign rows are admitted, and the test sees them.
   */
  function predicateScope(
    clause: unknown,
    columns: Record<string, string>,
  ): { entries: Array<{ column: string; key: string; value: unknown }>; isNull: (column: string) => boolean } {
    const query = dialect.sqlToQuery(clause as never);
    const entries: Array<{ column: string; key: string; value: unknown }> = [];

    for (const [column, key] of Object.entries(columns)) {
      const match = new RegExp(`"${column}" = \\$(\\d+)`).exec(query.sql);
      if (match) {
        entries.push({ column, key, value: query.params[Number(match[1]) - 1] });
      }
    }

    return {
      entries,
      isNull: (column: string) => query.sql.includes(`"${column}" is null`),
    };
  }

  /**
   * A `select` that behaves like the real one: the predicate is compiled to
   * SQL and only the rows that predicate admits are returned. `limit` is
   * honoured, because a scope that admits the wrong rows is only dangerous
   * when the wrong row survives the `limit(1)`.
   */
  function filteredBuilder<T>(resolve: (clause: unknown) => T[]): Builder {
    let result: T[] = [];
    let take = Number.POSITIVE_INFINITY;

    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.orderBy = vi.fn(() => builder);
    builder.where = vi.fn((clause: unknown) => {
      result = resolve(clause);
      return builder;
    });
    builder.limit = vi.fn((n: number) => {
      take = n;
      return builder;
    });
    builder.offset = vi.fn(() => builder);
    const settled = () => Promise.resolve(result.slice(0, take));
    builder.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
      settled().then(onFulfilled, onRejected);
    builder.catch = (onRejected?: (r: unknown) => unknown) => settled().catch(onRejected);
    builder.finally = (onFinally?: () => void) => settled().finally(onFinally);

    return builder as Builder;
  }

  /** The subject lookup, scoped by exactly the columns it filters on. */
  function subjectLookup(rows: Array<Record<string, unknown>>) {
    return filteredBuilder((clause) => {
      const scope = predicateScope(clause, { global_id: 'globalId', business_id: 'businessId' });
      return rows.filter(
        (row) =>
          scope.entries.every(({ key, value }) => row[key] === value) &&
          (!scope.isNull('deleted_at') || row.deletedAt == null),
      );
    });
  }

  /** The points read, tenant- and customer-scoped by whatever it filters on. */
  function pointsRead(rows: Array<Record<string, unknown>>) {
    const admitted = (clause: unknown) => {
      const scope = predicateScope(clause, {
        business_id: 'businessId',
        customer_id: 'customerId',
        type: 'type',
      });
      return rows.filter((row) => scope.entries.every(({ key, value }) => row[key] === value));
    };

    return {
      // The route runs the count and the page together; count is built first.
      count: filteredBuilder((clause) => [{ total: admitted(clause).length }]),
      items: filteredBuilder((clause) =>
        admitted(clause).map((row) => ({
          id: row.id,
          customer_id: row.customerId,
          type: row.type,
          points: row.points,
          balance_after: row.balanceAfter,
          reference_id: row.referenceId,
          note: row.note,
          created_at: row.createdAt,
        })),
      ),
    };
  }

  /** Compile the raw statements a route handed `db.execute`, params included. */
  function executedStatements(): string[] {
    return mockDb.execute.mock.calls
      .map((call) => call[0])
      .filter((arg) => arg !== undefined && arg !== null)
      .map((arg) => {
        const { sql: text, params } = dialect.sqlToQuery(arg as never);
        return `${text} :: ${JSON.stringify(params)}`;
      });
  }

  /** Nothing in the response may name a customer other than the caller's. */
  function expectNoLeakedIds(raw: string, forbidden: string[]) {
    for (const id of forbidden) {
      expect(raw).not.toContain(id);
    }
  }

  describe('GET /v1/loyalty/points/transactions — customer ownership', () => {
    /** subject lookup, then the count and the page. */
    function mockReadAs(
      auth: TestAuth,
      customers: Array<Record<string, unknown>> = CUSTOMER_ROWS,
      rows: Array<Record<string, unknown>> = TRANSACTION_ROWS,
    ) {
      const read = pointsRead(rows);
      // Queued off the same predicate the route uses, so the mock cannot
      // quietly stop matching the route's shape if that predicate changes.
      const selects = isCustomerRole({ userId: auth.userId, businessId: auth.businessId, userRole: auth.userRole })
        ? [subjectLookup(customers), read.count, read.items]
        : [read.count, read.items];
      for (const builder of selects) {
        mockDb.select.mockReturnValueOnce(builder as never);
      }
    }

    it('gives a customer their own transactions when customer_id is omitted', async () => {
      mockReadAs(CUSTOMER);

      const res = await reqAs('GET', '/v1/loyalty/points/transactions', CUSTOMER);

      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: Array<{ id: string; customer_id: string }>; meta: { total: number } };
      // Omitting the id used to mean "the whole tenant". It means "me" now.
      expect(json.meta.total).toBe(2);
      expect(json.data.map((tx) => tx.id).sort()).toEqual(['tx-alice-1', 'tx-alice-2']);
      expect(json.data.every((tx) => tx.customer_id === 'cust-alice')).toBe(true);
      expectNoLeakedIds(raw, ['cust-bob', 'cust-carol', 'cust-alice-biz2']);
    });

    it('accepts a customer naming their own id', async () => {
      mockReadAs(CUSTOMER);

      const res = await reqAs(
        'GET',
        '/v1/loyalty/points/transactions?customer_id=cust-alice',
        CUSTOMER,
      );

      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(json.meta.total).toBe(2);
      expect(json.data.map((tx) => tx.id).sort()).toEqual(['tx-alice-1', 'tx-alice-2']);
    });

    it('refuses a customer naming another customer in the same tenant (403)', async () => {
      mockDb.select.mockReturnValueOnce(subjectLookup(CUSTOMER_ROWS) as never);

      const res = await reqAs(
        'GET',
        '/v1/loyalty/points/transactions?customer_id=cust-bob',
        CUSTOMER,
      );

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_ID_MISMATCH');
      expect(json.data).toBeUndefined();
      // The points read never ran: the other customer's rows were never queried.
      expect(mockDb.select).toHaveBeenCalledOnce();
      expectNoLeakedIds(raw, ['cust-bob', 'tx-bob-1']);
    });

    it('refuses a customer naming a customer in another tenant, and leaks nothing', async () => {
      mockDb.select.mockReturnValueOnce(subjectLookup(CUSTOMER_ROWS) as never);

      const res = await reqAs(
        'GET',
        '/v1/loyalty/points/transactions?customer_id=cust-carol',
        CUSTOMER,
      );

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_ID_MISMATCH');
      // The named id is never echoed and never looked up, so the 403 cannot be
      // told apart from one for an id that does not exist.
      expect(mockDb.select).toHaveBeenCalledOnce();
      expectNoLeakedIds(raw, ['cust-carol', 'tx-carol-1', '4000']);
    });

    it('refuses a customer whose subject has no row in this tenant', async () => {
      mockDb.select.mockReturnValueOnce(subjectLookup([]) as never);

      const res = await reqAs('GET', '/v1/loyalty/points/transactions', {
        ...CUSTOMER,
        userId: 'gid-zed',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_SELF_NOT_FOUND');
    });

    it('refuses a customer whose row in this tenant is withdrawn', async () => {
      mockDb.select.mockReturnValueOnce(subjectLookup(CUSTOMER_ROWS) as never);

      const res = await reqAs('GET', '/v1/loyalty/points/transactions', {
        ...CUSTOMER,
        userId: 'gid-dana',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_SELF_NOT_FOUND');
    });

    it('still lets an operator name an explicit customer', async () => {
      mockReadAs(OPERATOR_AUTH);

      const res = await GET('/v1/loyalty/points/transactions?customer_id=cust-bob');

      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(json.meta.total).toBe(1);
      expect(json.data[0].id).toBe('tx-bob-1');
      // No subject lookup: the operator path does not resolve a customer.
      expect(mockDb.select).toHaveBeenCalledTimes(2);
    });

    it('still lists the whole tenant for an operator who names no customer', async () => {
      mockReadAs(OPERATOR_AUTH);

      const res = await GET('/v1/loyalty/points/transactions');

      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(json.meta.total).toBe(3);
      expect(json.data.map((tx) => tx.id).sort()).toEqual(['tx-alice-1', 'tx-alice-2', 'tx-bob-1']);
    });

    it('still honours the type filter for an operator', async () => {
      mockReadAs(OPERATOR_AUTH);

      const res = await GET('/v1/loyalty/points/transactions?type=redeem');

      expect(res.status).toBe(200);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(json.meta.total).toBe(1);
      expect(json.data[0].id).toBe('tx-alice-2');
    });
  });

  describe('POST /v1/loyalty/rewards/redeem — customer ownership', () => {
    /** subject lookup only; the balance and the insert are raw `execute` calls. */
    function mockSubject(customers: Array<Record<string, unknown>> = CUSTOMER_ROWS) {
      mockDb.select.mockReturnValueOnce(subjectLookup(customers) as never);
    }

    it('refuses a customer redeeming for another customer and writes nothing', async () => {
      mockSubject();
      // Only withRls should reach the database.
      mockDb.execute.mockResolvedValue({ rows: [] });

      const res = await reqAs('POST', '/v1/loyalty/rewards/redeem', CUSTOMER, {
        customer_id: 'cust-bob',
        points: 100,
        reference_id: 'ref-steal',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_ID_MISMATCH');
      // One statement only: the RLS session variable. No balance read, no
      // INSERT, no event — nothing was spent.
      expect(mockDb.execute).toHaveBeenCalledOnce();
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expectNoLeakedIds(raw, ['cust-bob', '900']);
    });

    it('refuses before the reward catalog is even read', async () => {
      mockSubject();
      mockDb.execute.mockResolvedValue({ rows: [] });

      const res = await reqAs('POST', '/v1/loyalty/rewards/redeem', CUSTOMER, {
        customer_id: 'cust-bob',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'ref-steal-2',
      });

      expect(res.status).toBe(403);
      // Ownership is decided first, so a foreign id cannot even be used to
      // probe which rewards the tenant stocks.
      expect(mockDb.select).toHaveBeenCalledOnce();
      expect(mockDb.execute).toHaveBeenCalledOnce();
    });

    it('refuses a customer naming a customer in another tenant, and leaks nothing', async () => {
      mockSubject();
      mockDb.execute.mockResolvedValue({ rows: [] });

      const res = await reqAs('POST', '/v1/loyalty/rewards/redeem', CUSTOMER, {
        customer_id: 'cust-carol',
        points: 100,
        reference_id: 'ref-cross-tenant',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('CUSTOMER_ID_MISMATCH');
      expect(mockDb.execute).toHaveBeenCalledOnce();
      expectNoLeakedIds(raw, ['cust-carol', '4000']);
    });

    it('redeems a customer with no customer_id against their own balance', async () => {
      mockSubject();
      mockDb.execute.mockResolvedValueOnce({ rows: [] }); // withRls
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] }); // balance
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-new', balance_after: 400 }] }); // insert

      const res = await reqAs('POST', '/v1/loyalty/rewards/redeem', CUSTOMER, {
        points: 100,
        reference_id: 'ref-own',
      });

      expect(res.status).toBe(201);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: { id: string }; fulfilled: number };
      expect(json.data.id).toBe('tx-new');
      expect(json.fulfilled).toBe(100);
      // Every statement names the caller's own resolved id.
      const statements = executedStatements();
      expect(statements.some((s) => s.includes('"cust-alice"'))).toBe(true);
      expect(statements.some((s) => s.includes('cust-bob') || s.includes('cust-carol'))).toBe(false);
      expect(publish).toHaveBeenCalledOnce();
    });

    it('accepts a customer naming their own id', async () => {
      mockSubject();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-new', balance_after: 400 }] });

      const res = await reqAs('POST', '/v1/loyalty/rewards/redeem', CUSTOMER, {
        customer_id: 'cust-alice',
        points: 100,
        reference_id: 'ref-own-explicit',
      });

      expect(res.status).toBe(201);
      const statements = executedStatements();
      expect(statements.some((s) => s.includes('"cust-alice"'))).toBe(true);
    });

    it('still lets an operator redeem for an explicit customer (the POS path)', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', stock: 10, pointsCost: 50, name: 'Gift Card' }]),
      );
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 900 }] });

      const txExec = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'tx-pos', balance_after: 800 }] })
        .mockResolvedValueOnce({ rows: [] });
      mockDb.transaction.mockImplementationOnce(async (cb: (tx: { execute: MockFn }) => unknown) =>
        cb({ execute: txExec }),
      );

      const res = await POST('/v1/loyalty/rewards/redeem', {
        customer_id: 'cust-bob',
        points: 100,
        reward_id: 'rw-1',
        reference_id: 'pos-1',
      });

      expect(res.status).toBe(201);
      const raw = await res.text();
      const json = JSON.parse(raw) as { data: { id: string } };
      expect(json.data.id).toBe('tx-pos');
      // No subject lookup: the operator id is honoured as sent.
      expect(mockDb.select).toHaveBeenCalledOnce();
      const posStatements = txExec.mock.calls
        .map((call) => dialect.sqlToQuery(call[0] as never).params)
        .flat();
      expect(posStatements).toContain('cust-bob');
    });

    it('still rejects an operator who names no customer', async () => {
      const res = await POST('/v1/loyalty/rewards/redeem', { points: 100, reference_id: 'ref-x' });

      expect(res.status).toBe(400);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ==========================================================================
  // Operator-only write routes — the customer role is refused
  //
  // `X-Business-Id` says which tenant, never who inside it, and the gateway
  // enforces no scopes, so before this guard any authenticated customer token
  // could rewrite the loyalty program, reshape the tier ladder, restock the
  // reward catalog, and — through `points/assign`, whose `points` is validated
  // only as `>= 1` — mint an arbitrary balance and then spend it through the
  // one route that is legitimately theirs.
  //
  // Two properties are asserted for every route, not just the status:
  //
  //   1. Nothing was written. The guard runs before the body is parsed, before
  //      the program or catalog is read, and before `withRls` — so the whole
  //      database is untouched, not merely un-mutated.
  //   2. The answer is the same either way. The guard reads nothing, so a
  //      request that would have succeeded and one that would have failed get
  //      the same 403 with the same body. The tenant's ids, names and balances
  //      are not observable through it.
  //
  // Reads stay open: the customer app legitimately reads the reward catalog and
  // its own transaction history, so a refusal here is about writes only.
  // `POST /v1/loyalty/rewards/redeem` is the one write that stays open, and the
  // PR #115 tests above pin both of its roles.
  // ==========================================================================

  /** A second operator role, to show the guard keys on `customer` alone. */
  const STAFF: TestAuth = { userId: 'user-2', businessId: DEV_TENANT, userRole: 'staff' };

  /**
   * Not one statement was sent, and no event was published.
   *
   * `createDb` is included because that is the earliest point a guarded route
   * could have touched the database: the guard is ahead of it.
   */
  function expectNoDbContact() {
    expect(createDb).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  }

  describe('PUT /v1/loyalty/config — operator only', () => {
    it('refuses a customer rewriting the loyalty program and writes nothing', async () => {
      const res = await reqAs('PUT', '/v1/loyalty/config', CUSTOMER, {
        earn_rate: '999',
        program_name: 'Owned By Me',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      // The 403 says nothing about whether a program exists, and rewrites
      // nothing: an earn_rate of 999 would otherwise apply to every customer.
      expect(raw).not.toContain('999');
      expectNoDbContact();
    });

    it('still lets an operator rewrite the loyalty program', async () => {
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '3.0', name: 'Gold' }]),
      );

      const res = await reqAs('PUT', '/v1/loyalty/config', OPERATOR_AUTH, {
        earn_rate: '3.0',
        program_name: 'Gold',
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  describe('POST /v1/loyalty/tiers — operator only', () => {
    it('refuses a customer creating a tier and writes nothing', async () => {
      const res = await reqAs('POST', '/v1/loyalty/tiers', CUSTOMER, {
        name: 'Diamond',
        min_points: 9000,
        multiplier: 3.0,
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      expectNoDbContact();
    });

    it('still lets an operator create a tier', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', name: 'Loyalty Program' }]));
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Diamond', minPoints: 9000, displayOrder: 4 }]),
      );

      const res = await POST('/v1/loyalty/tiers', {
        name: 'Diamond',
        min_points: 9000,
        multiplier: 3.0,
        display_order: 4,
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  describe('PUT /v1/loyalty/tiers/:id — operator only', () => {
    it('refuses a customer and does not reveal whether the tier exists', async () => {
      // The very same request from an operator answers 404 for this id (pinned
      // above). Identical 403 here, so the id space is not a probe.
      const res = await reqAs('PUT', '/v1/loyalty/tiers/tier-unknown', CUSTOMER, {
        name: 'Mine Now',
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      expectNoDbContact();
    });

    it('still lets an operator update a tier', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Bronze', minPoints: 0, displayOrder: 1 }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Silver', minPoints: 100, displayOrder: 1 }]),
      );

      const res = await PUT('/v1/loyalty/tiers/tier-1', { name: 'Silver', min_points: 100 });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockDb.update).toHaveBeenCalledOnce();
    });
  });

  describe('POST /v1/loyalty/points/assign — operator only', () => {
    it('refuses a customer crediting themselves and inserts no points_transactions row', async () => {
      // The exploit: `points` is only ever checked for `>= 1`, so an unbounded
      // credit would land in points_transactions and then be spendable through
      // `redeem`, which is a route the customer app may legitimately call.
      const res = await reqAs('POST', '/v1/loyalty/points/assign', CUSTOMER, {
        customer_id: 'cust-alice',
        points: 1000000,
        reference_id: 'self-credit',
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      // The raw INSERT is the only thing that ever writes this table, and it
      // was never reached — no row, no balance_after, no PointsAssigned event.
      expect(mockDb.execute).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expectNoDbContact();
      // The refusal echoes neither the amount nor the customer's own id.
      expect(raw).not.toContain('1000000');
      expect(raw).not.toContain('cust-alice');
    });

    it('still lets an operator (staff) assign points', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', earnRate: '1.0' }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: 50, customer_id: 'cust-1' }],
      });

      const res = await reqAs('POST', '/v1/loyalty/points/assign', STAFF, {
        customer_id: 'cust-1',
        points: 50,
        reference_id: 'staff-credit',
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(publish).toHaveBeenCalledOnce();
    });
  });

  describe('POST /v1/loyalty/rewards — operator only', () => {
    it('refuses a customer creating a reward and writes nothing', async () => {
      const res = await reqAs('POST', '/v1/loyalty/rewards', CUSTOMER, {
        name: 'Unlimited Points',
        points_cost: 1,
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      expectNoDbContact();
    });

    it('refuses before the reward catalog is even read', async () => {
      // Mirrors the PR #115 test of the same name on `redeem`. This name is
      // already taken, so an operator gets 409 DUPLICATE_REWARD_NAME out of a
      // catalog read. A customer gets 403 without the read ever running, so the
      // catalog cannot be used to learn which names are free.
      const res = await reqAs('POST', '/v1/loyalty/rewards', CUSTOMER, {
        name: 'Gift Card',
        points_cost: 500,
      });

      expect(res.status).toBe(403);
      const raw = await res.text();
      const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      expect(json.error.code).not.toBe('DUPLICATE_REWARD_NAME');
      expect(raw).not.toContain('Gift Card');
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('still lets an operator create a reward', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card', pointsCost: 500 }]),
      );

      const res = await POST('/v1/loyalty/rewards', {
        name: 'Gift Card',
        points_cost: 500,
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });
  });

  describe('PUT /v1/loyalty/rewards/:id — operator only', () => {
    it('refuses a customer and does not reveal whether the reward exists', async () => {
      const res = await reqAs('PUT', '/v1/loyalty/rewards/rw-unknown', CUSTOMER, {
        points_cost: 1,
      });

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      expectNoDbContact();
    });

    it('still lets an operator update a reward', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card', pointsCost: 500 }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([]));
      mockDb.update.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card Plus', pointsCost: 600 }]),
      );

      const res = await PUT('/v1/loyalty/rewards/rw-1', {
        name: 'Gift Card Plus',
        points_cost: 600,
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockDb.update).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /v1/loyalty/tiers/:id — operator only', () => {
    it('refuses a customer deleting a tier and deletes no row', async () => {
      const res = await reqAs('DELETE', '/v1/loyalty/tiers/tier-1', CUSTOMER);

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      // The handler would otherwise answer 404 for this id, 409 for the base
      // tier, 409 for a tier with members, and 204 for a deletable one. The
      // refusal is the same in all four cases and reaches no query.
      expectNoDbContact();
    });

    it('still lets an operator delete a tier', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'tier-1', name: 'Silver', minPoints: 100 }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 0 }]));

      const res = await DELETE('/v1/loyalty/tiers/tier-1');

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(204);
      expect(mockDb.delete).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /v1/loyalty/rewards/:id — operator only', () => {
    it('refuses a customer soft-deleting a reward and deletes no row', async () => {
      const res = await reqAs('DELETE', '/v1/loyalty/rewards/rw-1', CUSTOMER);

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      // The soft-delete is an UPDATE, and the pre-existing 404 for an unknown id
      // is not observable through the refusal.
      expect(mockDb.update).not.toHaveBeenCalled();
      expectNoDbContact();
    });

    it('still lets an operator soft-delete a reward', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'rw-1', name: 'Gift Card' }]),
      );

      const res = await DELETE('/v1/loyalty/rewards/rw-1');

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(200);
      expect(mockDb.update).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/points/assign — a counter is refused, and indistinguishably
  //
  // `requireOperatorRole` denied by *exclusion*: it refused the customer role and
  // passed everything else, so a till's token — `sub: 'pos:<terminalId>'`, minted
  // by the public `POST /v1/auth/pos/token` — sailed through and could send
  // `points` directly. That is the escalation: a terminal reports that a sale
  // happened and sends `amount_cents`; what the sale is worth is the tenant's
  // earn rule's decision, which is precisely what `POST /v1/loyalty/checkins`
  // exists to apply. Sending points bypasses it.
  //
  // Three properties are asserted here, and the second is the one a per-kind
  // error code would have quietly broken:
  //
  //   1. The counter is refused with `OPERATOR_ROLE_REQUIRED` and nothing is
  //      written — the guard is ahead of `createDb`, so there is no statement to
  //      observe at all.
  //   2. That refusal is byte-identical to the customer's. Same status, same code,
  //      same message.
  //   3. The refusal is *narrow*: a subject that merely resembles `pos:` is not a
  //      counter, so nothing here became a prefix blanket.
  // ==========================================================================

  describe('POST /v1/loyalty/points/assign — a counter is refused like a customer', () => {
    /**
     * Subjects that resemble the counter marker without being one.
     *
     * A guard written as `sub.startsWith('pos')` would refuse all of these, and
     * three of them are things the issuer could plausibly hand out one day. The
     * marker is `pos:` with something behind it — the colon separates a namespace
     * a uuid can never occupy, and the empty remainder is refused because a marker
     * with no terminal in it is not a terminal.
     */
    const NEAR_MISS_SUBJECTS: { label: string; userId: string }[] = [
      { label: 'pos with no separator', userId: 'pos' },
      { label: 'pos with no terminal behind it', userId: 'pos:' },
      { label: 'a longer word starting with pos', userId: 'postal-terminal-1' },
      { label: 'a different separator', userId: 'pos_terminal-1' },
      { label: 'the same letters in another case', userId: 'POS:terminal-1' },
      { label: 'an ordinary operator subject', userId: 'user-1' },
    ];

    /** The body a counter would send: points, no amount, straight to the balance. */
    const COUNTER_ASSIGN_BODY = {
      customer_id: 'cust-1',
      points: 9999,
      reference_id: 'ref-escalation',
    };

    it('refuses a counter assigning points and writes nothing', async () => {
      const res = await reqAs(
        'POST',
        '/v1/loyalty/points/assign',
        COUNTER_AUTH,
        COUNTER_ASSIGN_BODY,
      );

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('OPERATOR_ROLE_REQUIRED');
      // Not merely "no points were added": no statement reached the database. The
      // guard runs ahead of `createDb`, so there is nothing to undo and nothing
      // for a caller to have observed on the way in.
      expectNoDbContact();
    });

    it('answers a counter exactly as it answers a customer — same status, code and message', async () => {
      // Asserted explicitly rather than by each field separately matching a
      // literal, because the two refusals must be *indistinguishable*. A distinct
      // code per subject kind would still pass the first test in this block and
      // would tell an unauthenticated caller which kinds of subject this system
      // issues — the one thing a guard on a credential it does not recognise must
      // not do.
      const fromCounter = await reqAs(
        'POST',
        '/v1/loyalty/points/assign',
        COUNTER_AUTH,
        COUNTER_ASSIGN_BODY,
      );
      const fromCustomer = await reqAs(
        'POST',
        '/v1/loyalty/points/assign',
        CUSTOMER,
        COUNTER_ASSIGN_BODY,
      );

      expect(fromCounter.status).toBe(fromCustomer.status);
      expect(fromCounter.status).toBe(403);

      // The whole body, byte for byte. This route's error envelope carries only
      // `code` and `message`, so equality here is the whole refusal and nothing
      // else can be hiding behind it.
      expect(await fromCounter.text()).toBe(await fromCustomer.text());

      const body = (await (
        await reqAs('POST', '/v1/loyalty/points/assign', COUNTER_AUTH, COUNTER_ASSIGN_BODY)
      ).json()) as Record<string, Record<string, unknown>>;
      expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    });

    it.each(NEAR_MISS_SUBJECTS)(
      'does not widen into a prefix blanket — $label still assigns',
      async ({ userId }) => {
        // These are the subjects a `startsWith('pos')` check would have caught and
        // this guard must not: a bare `pos`, the same letters inside a longer word,
        // a different separator, the same letters in another case, and `pos:` with
        // no terminal behind it. The assertion is made at the route, not at the
        // predicate, because "still assigns" is the claim that actually matters:
        // the denial is scoped to the counter namespace rather than to anything
        // that resembles it.
        mockDb.select.mockReturnValueOnce(
          createBuilder([
            {
              id: 'prog-1',
              earnRate: '1.0000',
              earnBy: 'purchase',
              earnUnitAmount: '1000.00',
            },
          ]),
        );
        mockDb.select.mockReturnValueOnce(
          createBuilder([{ id: 'cust-1', currentTierId: null }]),
        );
        mockDb.execute.mockResolvedValueOnce({ rows: [] });
        mockDb.execute.mockResolvedValueOnce({
          rows: [{ id: 'tx-1', customer_id: 'cust-1', balance_after: 12, points: 12 }],
        });

        const res = await reqAs(
          'POST',
          '/v1/loyalty/points/assign',
          { userId, businessId: 'biz-1', userRole: 'terminal' },
          { customer_id: 'cust-1', amount_pesos: 12500, reference_id: 'ref-near-miss' },
        );

        expect(res.status).toBe(201);
        // And the narrowing is the shared predicate's, not a copy of it.
        expect(
          isCounterSubject({ userId, businessId: 'biz-1', userRole: 'terminal' }),
        ).toBe(false);
        expect(
          requireOperatorRole({ userId, businessId: 'biz-1', userRole: 'terminal' }),
        ).toEqual({ ok: true });
      },
    );

    it('still lets an ordinary operator assign points', async () => {
      // The other direction, and the one that would break if the guard had been
      // written as "refuse anything that is not `user-1`" or as a role allow-list
      // over subjects. `mockPurchaseEarn` is the same stub the pre-existing
      // operator cases use, so a pass here is a pass on the real earn path.
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'prog-1', earnRate: '1.0000', earnBy: 'purchase', earnUnitAmount: '1000.00' },
        ]),
      );
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: null }]),
      );
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', customer_id: 'cust-1', balance_after: 12, points: 12 }],
      });

      const res = await reqAs('POST', '/v1/loyalty/points/assign', OPERATOR_AUTH, {
        customer_id: 'cust-1',
        amount_pesos: 12500,
        reference_id: 'ref-operator-ok',
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(mockDb.execute).toHaveBeenCalled();
    });
  });

  describe('read routes — still open to a customer', () => {
    it('lets a customer read the loyalty config', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0', name: 'Programa de beneficios', isActive: true }]),
      );

      const res = await reqAs('GET', '/v1/loyalty/config', CUSTOMER);

      expect(res.status).toBe(200);
    });

    it('lets a customer read the reward catalog', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ total: 1 }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'rw-1', name: 'Gift Card' }]));

      const res = await reqAs('GET', '/v1/loyalty/rewards', CUSTOMER);

      expect(res.status).toBe(200);
    });
  });

  // ==========================================================================
  // The pass projection
  //
  // A pass balance used to move only when the holder opened the app or when the
  // daily sweep ran — both *pull*, neither aware a sale happened. These tests
  // pin the trigger that fixed it, and they pin it as a *trigger*: what matters
  // is that the sale is unaffected by the projection, not that any particular
  // promise was handed to `waitUntil` in any particular order.
  //
  // `reqAs` is untouched. It drives `app.fetch(request, env)` with no
  // `ExecutionContext` and no `WALLET`, which is exactly the shape every
  // pre-existing test in this file was written against — so the helper below
  // adds the two things the projection needs rather than changing the one every
  // other test shares.
  // ==========================================================================

  describe('the pass projection on a ledger change', () => {
    interface Deferred {
      promise: Promise<unknown>;
      settle: (value?: unknown) => void;
      fail: (err: unknown) => void;
      settled: () => boolean;
    }

    /**
     * A promise the test resolves by hand.
     *
     * A promise that is never resolved would prove the same thing and prove it
     * worse: an `await` on it and the whole suite hangs until the timeout, which
     * reports as a crashed run rather than as a failed assertion. Handing the
     * test the switch is what lets it say "the response came back while the
     * projection was still pending" as an assertion.
     */
    function deferred(): Deferred {
      let resolve!: (value?: unknown) => void;
      let reject!: (err: unknown) => void;
      let done = false;

      const promise = new Promise<unknown>((res, rej) => {
        resolve = (value?: unknown) => {
          done = true;
          res(value);
        };
        reject = (err: unknown) => {
          done = true;
          rej(err);
        };
      });

      return { promise, settle: resolve, fail: reject, settled: () => done };
    }

    /** The promises the handler handed to `waitUntil`, in order. */
    function backgroundWork(): {
      waited: Promise<unknown>[];
      waitUntil: (promise: Promise<unknown>) => void;
    } {
      const waited: Promise<unknown>[] = [];
      return { waited, waitUntil: (promise) => void waited.push(promise) };
    }

    function walletEnv(reconcileCustomer: MockFn): Record<string, unknown> {
      return {
        DATABASE_URL: 'postgres://mock',
        DOMAIN_EVENTS_QUEUE: {} as Queue,
        SCHEMA_REGISTRY: {} as KVNamespace,
        WALLET: { reconcileCustomer },
      };
    }

    function postWithWallet(
      path: string,
      body: unknown,
      reconcileCustomer: MockFn,
      waitUntil: (promise: Promise<unknown>) => void,
    ) {
      const r = new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': OPERATOR_AUTH.userId,
          'X-Business-Id': OPERATOR_AUTH.businessId,
          'X-User-Role': OPERATOR_AUTH.userRole,
        },
        body: JSON.stringify(body),
      });

      // The execution context is the third argument, which is where the Workers
      // runtime puts it — Hono reads it from there and exposes it as
      // `c.executionCtx`. Passing it is what makes the "not awaited" claim
      // testable at all: with no context, the handler has nowhere to hand the
      // projection to and the test would pass for the wrong reason.
      return app.fetch(
        r,
        walletEnv(reconcileCustomer) as never,
        { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
      );
    }

    /** The two `execute` calls the earn path makes: the RLS session, then the ledger insert. */
    function stubEarnLedger(balanceAfter = 300) {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', earnRate: '1.0' }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: balanceAfter, customer_id: 'cust-1' }],
      });
    }

    /** The three `execute` calls the plain redeem path makes: RLS, balance, insert. */
    function stubRedeemLedger(balance = 500, balanceAfter = 400) {
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance }] });
      mockDb.execute.mockResolvedValueOnce({
        rows: [{ id: 'tx-1', balance_after: balanceAfter, customer_id: 'cust-1' }],
      });
    }

    it('asks the wallet to project the customer the ledger row was written for', async () => {
      const { waited, waitUntil } = backgroundWork();
      const reconcileCustomer = vi.fn(async () => ({ kind: 'patched' }));
      stubEarnLedger();

      const res = await postWithWallet(
        '/v1/loyalty/points/assign',
        { customer_id: 'cust-1', points: 50, reference_id: 'ref-proj' },
        reconcileCustomer,
        waitUntil,
      );

      expect(res.status).toBe(201);
      // Both halves of the pair, and the tenant from the token rather than from
      // anything the body supplied. A projection with the wrong tenant reads
      // another merchant's pass, and with the wrong customer reads nobody's.
      expect(reconcileCustomer).toHaveBeenCalledExactlyOnceWith({
        tenantId: OPERATOR_AUTH.businessId,
        customerId: 'cust-1',
      });
      expect(waited).toHaveLength(1);
    });

    it('answers 201 without waiting for a Google call that never returns', async () => {
      // Not the status code on its own: a handler that awaited the projection
      // would still eventually answer 201. The claim is that the response came
      // back while the projection was still pending, and `settled()` is how that
      // is observable — nothing else in this test can settle that promise.
      const projection = deferred();
      const { waitUntil } = backgroundWork();
      stubEarnLedger();

      const res = await postWithWallet(
        '/v1/loyalty/points/assign',
        { customer_id: 'cust-1', points: 50, reference_id: 'ref-slow' },
        vi.fn(() => projection.promise),
        waitUntil,
      );

      expect(res.status).toBe(201);
      expect(projection.settled()).toBe(false);

      // And the work is still ours to complete, which is the other half of
      // "not awaited": the projection was handed off, not dropped.
      projection.settle();
      await expect(projection.promise).resolves.toBeUndefined();
    });

    it('answers 201 when the projection fails, and hands the failure over already handled', async () => {
      // Two separate claims, and both are load-bearing. The sale must not fail —
      // that is why the handler catches at all. And the promise `waitUntil`
      // received must not be the rejected one: a rejected background task is
      // attributed to the invocation that spawned it, and an unhandled rejection
      // in a worker log is indistinguishable from a real fault in a report
      // someone has to triage at 06:00.
      const projection = deferred();
      const { waited, waitUntil } = backgroundWork();
      stubEarnLedger();

      const res = await postWithWallet(
        '/v1/loyalty/points/assign',
        { customer_id: 'cust-1', points: 50, reference_id: 'ref-fail' },
        vi.fn(() => projection.promise),
        waitUntil,
      );

      expect(res.status).toBe(201);

      projection.fail(new Error('google is unreachable'));
      await expect(waited[0]).resolves.toBeUndefined();
    });

    it('answers 201 when the wallet binding throws on dispatch', async () => {
      // Not the same failure as a rejected promise, and the reason it is tested
      // separately is the `try` the call sits in: this one is synchronous, so it
      // would be caught by the handler's own error handling — where a 23505 is
      // being translated into a 409 — and reported as a 500 for a request whose
      // ledger row was already written.
      const { waitUntil } = backgroundWork();
      stubEarnLedger();

      const res = await postWithWallet(
        '/v1/loyalty/points/assign',
        { customer_id: 'cust-1', points: 50, reference_id: 'ref-throw' },
        vi.fn(() => {
          throw new Error('the binding is not a worker');
        }),
        waitUntil,
      );

      expect(res.status).toBe(201);
    });

    it('projects nothing when the ledger row was not written', async () => {
      // The projection is fired after the insert, so every refusal before it
      // leaves the pass alone. A duplicate reference is the interesting one: the
      // balance did not move, and the row that exists is the one the first
      // request wrote — projecting again would be a second, identical write to
      // Google for a sale that never happened.
      const { waitUntil } = backgroundWork();
      const reconcileCustomer = vi.fn(async () => ({ kind: 'patched' }));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'prog-1', earnRate: '1.0' }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockRejectedValueOnce({
        message: 'duplicate key value violates unique constraint "uq_points_tx_reference"',
        code: '23505',
      });

      const res = await postWithWallet(
        '/v1/loyalty/points/assign',
        { customer_id: 'cust-1', points: 50, reference_id: 'dup-ref' },
        reconcileCustomer,
        waitUntil,
      );

      expect(res.status).toBe(409);
      expect(reconcileCustomer).not.toHaveBeenCalled();
    });

    it('still answers 201 when no wallet binding is bound at all', async () => {
      // The shape every pre-existing test in this file drives `app.fetch` with.
      // `Bindings` says `WALLET` is required and the runtime does not make it so,
      // and a missing binding is one of the ways this projection is unavailable —
      // all of which the contract answers the same way: the sale is correct, the
      // pass converges on the next sweep.
      stubEarnLedger();

      const r = new Request('http://localhost/v1/loyalty/points/assign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': OPERATOR_AUTH.userId,
          'X-Business-Id': OPERATOR_AUTH.businessId,
          'X-User-Role': OPERATOR_AUTH.userRole,
        },
        body: JSON.stringify({ customer_id: 'cust-1', points: 50, reference_id: 'ref-nobinding' }),
      });

      const res = await app.fetch(r, {
        DATABASE_URL: 'postgres://mock',
        DOMAIN_EVENTS_QUEUE: {} as Queue,
        SCHEMA_REGISTRY: {} as KVNamespace,
      } as Record<string, unknown>);

      expect(res.status).toBe(201);
    });

    it('asks the wallet to project after a redemption, on the non-transactional path', async () => {
      const { waited, waitUntil } = backgroundWork();
      const reconcileCustomer = vi.fn(async () => ({ kind: 'patched' }));
      stubRedeemLedger();

      const res = await postWithWallet(
        '/v1/loyalty/rewards/redeem',
        { customer_id: 'cust-1', points: 100, reference_id: 'ref-redeem-proj' },
        reconcileCustomer,
        waitUntil,
      );

      expect(res.status).toBe(201);
      expect(reconcileCustomer).toHaveBeenCalledExactlyOnceWith({
        tenantId: OPERATOR_AUTH.businessId,
        customerId: 'cust-1',
      });
      expect(waited).toHaveLength(1);
    });

    it('projects only after the redemption transaction commits', async () => {
      // The one claim the earn path cannot make. With a `reward_id` the ledger
      // write and the stock decrement share a transaction, and a projection
      // dispatched from inside it would ask the wallet to read a balance the
      // transaction can still roll back — leaving Google's pass holding a
      // redemption the ledger never committed, in the direction that lets a
      // customer spend points they do not have.
      //
      // The order array is the assertion: the handler's own `await
      // performRedeem()` has to resolve before `reconcileCustomer` is called at
      // all. A projection moved inside the transaction body puts 'reconcile'
      // between 'ledger' and 'commit'.
      const order: string[] = [];
      const { waitUntil } = backgroundWork();
      const reconcileCustomer = vi.fn(async () => {
        order.push('reconcile');
        return { kind: 'patched' };
      });

      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ balance: 500 }] });
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'rw-1', name: 'Coffee', pointsCost: 100, stock: 5, validFrom: null, validUntil: null },
        ]),
      );
      mockDb.transaction.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
        const tx = createBuilder() as MockDb & { execute: MockFn };
        tx.execute = vi.fn(async (statement: never) => {
          // Two statements share this transaction — the ledger row and the
          // stock decrement — so the order array names both. A projection fired
          // between them would be a redemption Google knows about and the
          // catalog does not.
          const sqlText = new PgDialect().sqlToQuery(statement).sql;
          order.push(sqlText.includes('points_transactions') ? 'ledger' : 'stock');
          return { rows: [{ id: 'tx-9', balance_after: 400, customer_id: 'cust-1' }] };
        });
        await cb(tx);
        order.push('commit');
        return { rows: [{ id: 'tx-9', balance_after: 400, customer_id: 'cust-1' }] };
      });

      const res = await postWithWallet(
        '/v1/loyalty/rewards/redeem',
        { customer_id: 'cust-1', points: 100, reward_id: 'rw-1', reference_id: 'ref-tx' },
        reconcileCustomer,
        waitUntil,
      );

      expect(res.status).toBe(201);
      expect(order).toEqual(['ledger', 'stock', 'commit', 'reconcile']);
    });

    it('projects nothing when a redemption is refused', async () => {
      // The balance this call would have projected is the pre-redemption one,
      // because no redemption happened. Firing on the refusal would be a no-op
      // write at best and, on a redemption that is refused for a reason the
      // wallet cannot see, a projection of a number the customer never had.
      const { waitUntil } = backgroundWork();
      const reconcileCustomer = vi.fn(async () => ({ kind: 'patched' }));
      stubRedeemLedger(50);

      const res = await postWithWallet(
        '/v1/loyalty/rewards/redeem',
        { customer_id: 'cust-1', points: 100, reference_id: 'ref-short' },
        reconcileCustomer,
        waitUntil,
      );

      expect(res.status).toBe(409);
      expect(reconcileCustomer).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/passes/resolve — the scan, at the till, before the money moves
  // ==========================================================================

  describe('POST /v1/loyalty/passes/resolve', () => {
    it('answers known:true with the customer and their real name', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: null }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ fullName: 'Ada Lovelace' }]));

      const res = await COUNTER_POST('/v1/loyalty/passes/resolve', { member_code: 'ABC-1234' });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.known).toBe(true);
      expect(json.data.customer_id).toBe('cust-1');
      // `full_name` is `customers.fullName`, the column that actually exists. A
      // made-up name here would be a field the merchant's screen renders blank.
      expect(json.data.display_name).toBe('Ada Lovelace');
    });

    it('answers known:false for a code nobody has, and still 200', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await COUNTER_POST('/v1/loyalty/passes/resolve', { member_code: 'NOPE-0000' });

      // The number that matters is this one. A 404 here reads to a terminal as
      // "do not sell", and refusing a merchant's sale because a pass was not
      // found is the failure this whole route exists to prevent.
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data).toEqual({ known: false });
      // And it creates nothing: a lookup that wrote would be a second thing to
      // reconcile when it went wrong.
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('never credits points', async () => {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId: null }]),
      );
      mockDb.select.mockReturnValueOnce(createBuilder([{ fullName: 'Ada Lovelace' }]));

      await COUNTER_POST('/v1/loyalty/passes/resolve', { member_code: 'ABC-1234' });

      // Scanning happens before the payment settles. Crediting here would pay for
      // a sale that might still be abandoned at the till.
      const statements = mockDb.execute.mock.calls
        .map((call) => call[0])
        .filter((arg) => arg !== undefined && arg !== null)
        .map((arg) => new PgDialect().sqlToQuery(arg as never).sql);
      expect(statements.filter((sql) => /points_transactions/.test(sql))).toEqual([]);
    });

    it('scopes the lookup to the credential, so a code is not global', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const r = await COUNTER_POST('/v1/loyalty/passes/resolve', { member_code: 'ABC-1234' });

      // `businessId` in the rendered SQL is the whole tenant boundary: `member_code`
      // is unique per business, so the credential's scope is what makes the lookup
      // unambiguous. A body-supplied business_id would be the caller choosing its
      // own scope, which is why there is no such field.
      const statement = mockDb.select.mock.results[0]?.value?.where?.mock.calls[0]?.[0];
      expect(statement).toBeDefined();
      const { sql: rendered } = new PgDialect().sqlToQuery(statement as never);
      expect(rendered).toContain('"customers"."business_id"');
      expect(rendered).toContain('"customers"."member_code"');
      // A withdrawn membership must not keep resolving at the till.
      expect(rendered).toContain('"customers"."deleted_at"');
      expect(r.status).toBe(200);
    });

    it.each([
      { label: 'absent', body: {} },
      { label: 'not a string', body: { member_code: 1234 } },
      { label: 'empty', body: { member_code: '' } },
    ])('answers 200 with known:false when the code is $label', async ({ body }) => {
      // Answered, not refused. This route does not veto a sale, and a malformed
      // scan is a malformed scan rather than a reason to stop charging.
      const res = await COUNTER_POST('/v1/loyalty/passes/resolve', body);

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data).toEqual({ known: false });
      // Nothing looked up, so nothing can leak and nothing can be written.
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/checkins — the fact, after the money moves
  // ==========================================================================

  describe('POST /v1/loyalty/checkins', () => {
    /**
     * A `visit` program with no tier, so the credited number is legible in the
     * assertions below.
     */
    function stubProgram(overrides: Record<string, unknown> = {}) {
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          {
            id: 'prog-1',
            earnRate: '1.0000',
            earnBy: 'visit',
            earnUnitAmount: '1000.00',
            ...overrides,
          },
        ]),
      );
    }

    /** The customer the code resolves to. `currentTierId: null` unless overridden. */
    function stubMember(currentTierId: string | null = null) {
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'cust-1', currentTierId }]),
      );
    }

    function stubLedger(balanceAfter = 5) {
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: balanceAfter }] });
    }

    /** The ledger INSERT the route ran. `withRls` ate the first `execute`. */
    function ledgerStatement(): SQL {
      // `mockDb.execute` is untyped, so the statement comes back as `any`.
      return mockDb.execute.mock.calls[1]?.[0] as SQL;
    }

    /**
     * The `reference_id` the ledger INSERT was asked to write.
     *
     * The bound parameters are read rather than interpolated, and the index is
     * counted off the real parameter order — `business_id`, `customer_id`,
     * `points`, then the `balance_after` subquery's own `customer_id` and `points`,
     * then `reference_id`, then `note`. The subquery's parameters are the reason a
     * reader cannot just take "the last one before note": they are interleaved.
     */
    function ledgerReference(): unknown {
      const { params } = new PgDialect().sqlToQuery(ledgerStatement() as never);
      return params[5];
    }

    /** The `points` value the ledger INSERT was asked to write. */
    function ledgerPoints(): unknown {
      const { params } = new PgDialect().sqlToQuery(ledgerStatement() as never);
      return params[2];
    }

    /** The row the route inserted, as the route passed it to `values()`. */
    function insertedValues(): Record<string, unknown> {
      return mockDb.insert.mock.results[0]?.value?.values?.mock.calls[0]?.[0];
    }

    /**
     * The `points` the route wrote back onto the checkin.
     *
     * `update()` takes the table as its only argument, so the patch is on the
     * builder it returned rather than on a second call argument.
     */
    function updatedPoints(): Record<string, unknown> {
      return mockDb.update.mock.results[0]?.value?.set?.mock.calls[0]?.[0];
    }

    /**
     * `withRls` opens the session before anything is judged, so "no ledger write"
     * means the INSERT never ran — not that the database was never touched. The
     * session statement itself carries no compilable SQL here, because
     * `setCurrentBusinessId` is mocked to return undefined.
     */
    function ledgerStatements(): string[] {
      return mockDb.execute.mock.calls
        .map((call) => call[0])
        .filter((arg) => arg !== undefined && arg !== null)
        .map((arg) => new PgDialect().sqlToQuery(arg as never).sql)
        .filter((sql) => /points_transactions/.test(sql));
    }

    it('records the sale and credits the customer (201)', async () => {
      stubMember();
      stubProgram();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(
        createBuilder([
          {
            id: 'chk-1',
            businessId: 'biz-1',
            customerId: 'cust-1',
            memberCode: 'ABC-1234',
            paymentId: 'pay-1',
            amountCents: 12500,
            items: null,
            note: null,
            points: null,
          },
        ]),
      );
      stubLedger(3);

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-1',
        member_code: 'ABC-1234',
        amount_cents: 12500,
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.points).toBe(1);
      // `reference_id` is the payment id: the event is already named when it
      // reaches us, so the ledger's own `uq_points_tx_reference` dedupes it for
      // free without a second key.
      expect(ledgerReference()).toBe('pay-1');
      // And the member_code the terminal sent is stored verbatim alongside the
      // resolved uuid, because codes get reassigned and only the string can still
      // answer "what was actually scanned".
      expect(insertedValues()).toMatchObject({
        memberCode: 'ABC-1234',
        paymentId: 'pay-1',
        amountCents: 12500,
      });
    });

    it('credits under the tenant\'s money rule when the program earns by purchase', async () => {
      stubMember();
      stubProgram({ earnBy: 'purchase', earnRate: '1.0000', earnUnitAmount: '1000.00' });
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(createBuilder([{ id: 'chk-1', amountCents: 1250000 }]));
      stubLedger(12);

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-2',
        member_code: 'ABC-1234',
        amount_cents: 1250000,
      });

      expect(res.status).toBe(201);
      // $12.500 at 1 point per $1.000 → 12. The cents-to-pesos step is a unit
      // conversion, not a decision about the amount: `amount_cents` is what the
      // rail settled and the tenant's unit is in pesos.
      expect(ledgerPoints()).toBe(12);
    });

    it('applies the customer\'s tier multiplier on top of the rule', async () => {
      stubMember('tier-1');
      stubProgram();
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'tier-1', multiplier: '2.00' }]));
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(createBuilder([{ id: 'chk-1', amountCents: 5000 }]));
      stubLedger(2);

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-3',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      expect(res.status).toBe(201);
      // One visit × rate 1 × tier 2, through the same shared formula the assign
      // route uses. Two copies of this rule is two rules.
      expect(ledgerPoints()).toBe(2);
    });

    it('answers 200 and credits nothing when the same payment arrives again', async () => {
      // The insert conflicts, so it returns no row. The existing row already has
      // points, which means the credit landed on the first attempt.
      stubMember();
      mockDb.insert.mockReturnValueOnce(createBuilder([]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'chk-1', paymentId: 'pay-1', points: 1, amountCents: 5000 }]),
      );

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-1',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.points).toBe(1);
      // The acceptance criterion: the same payment sent twice accumulates once.
      // No ledger write, no event, no pass projection.
      expect(publish).not.toHaveBeenCalled();
      expect(ledgerStatements()).toEqual([]);
    });

    it('finishes the credit a previous attempt left pending, and answers 200', async () => {
      // The load-bearing case. The row exists with `points IS NULL`: the sale was
      // recorded and the credit never landed. A retry that could only decline to
      // double-credit would turn every transient failure into a customer who paid
      // and never accumulated — and the terminal's message is the only evidence
      // that an attribution happened at all.
      stubMember();
      mockDb.insert.mockReturnValueOnce(createBuilder([]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'chk-1', paymentId: 'pay-4', points: null, amountCents: 5000, note: null },
        ]),
      );
      stubProgram();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      stubLedger(4);

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-4',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.points).toBe(1);
      // The credit actually ran this time, against the same reference.
      expect(ledgerReference()).toBe('pay-4');
      // And it is recorded back onto the checkin, which is what turns "pending"
      // into "done" and stops the row showing up in the backlog query.
      expect(updatedPoints()).toEqual({ points: 1 });
    });

    it('does not credit twice when the ledger already holds the reference', async () => {
      // The narrower partial failure: the ledger row landed, then the process died
      // before writing `points` back. The unique violation is the evidence that the
      // money already moved, so it must not be retried as a fresh credit.
      stubMember();
      mockDb.insert.mockReturnValueOnce(createBuilder([]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([
          { id: 'chk-1', paymentId: 'pay-5', points: null, amountCents: 5000, note: null },
        ]),
      );
      stubProgram();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockRejectedValueOnce({
        message: 'duplicate key value violates unique constraint "uq_points_tx_reference"',
        code: '23505',
      });

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-5',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      // The checkin is brought up to date so the backlog clears, but no second
      // credit was written: the customer ends with one, not two.
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.points).toBe(1);
      expect(updatedPoints()).toEqual({ points: 1 });
    });

    it('records the sale without points when the program\'s unit is unusable, rather than refusing it', async () => {
      // A `purchase` program with an unreadable unit. The sale genuinely happened
      // and the customer is owed for it, so failing the request would throw away a
      // real sale over a configuration problem on our side — the trade the
      // non-negotiable rule forbids. The row lands with `points IS NULL`, which is
      // a backlog somebody can find with one query.
      stubMember();
      stubProgram({ earnBy: 'purchase', earnUnitAmount: 'not-a-number' });
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'chk-1', paymentId: 'pay-6', amountCents: 5000, points: null }]),
      );

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-6',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.points).toBeNull();
      // No ledger write, and `points` is left NULL rather than zeroed: zero would
      // look credited and close the backlog with a lie.
      expect(ledgerStatements()).toEqual([]);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('records a manual entry with no payment_id and no dedupe', async () => {
      // The documented weaker path. `payment_id` is NULL, and Postgres' `NULL !=
      // NULL` means the unique index does not collide — nothing breaks, it simply
      // cannot protect this path from its own double entry. The checkin's own id is
      // used as the ledger reference so the credit is at least attributable.
      stubMember();
      stubProgram();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(createBuilder([{ id: 'chk-manual', amountCents: 5000 }]));
      stubLedger(1);

      const res = await COUNTER_POST('/v1/loyalty/checkins', { member_code: 'ABC-1234', amount_cents: 5000 });

      expect(res.status).toBe(201);
      expect(insertedValues()).toMatchObject({ paymentId: null });
      expect(ledgerReference()).toBe('chk-manual');
    });

    it('stores items as sent, without checking them against the amount', async () => {
      // `items` is best-effort metadata and `amount_cents` is authoritative. A
      // mismatch must not refuse a real sale: we hold no catalogue to reconcile
      // against, and the merchant's system owns the product identity.
      stubMember();
      stubProgram();
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(createBuilder([{ id: 'chk-1', amountCents: 5000 }]));
      stubLedger(1);

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-7',
        member_code: 'ABC-1234',
        amount_cents: 5000,
        items: [{ product_ref: 'x', name: 'Café', qty: 2, unit_price_cents: 250 }],
      });

      expect(res.status).toBe(201);
      // The amount is stored exactly as sent, and nothing reconciles the two.
      expect(insertedValues()).toMatchObject({
        amountCents: 5000,
        items: [{ product_ref: 'x', name: 'Café', qty: 2, unit_price_cents: 250 }],
      });
    });

    it('inspects the conflict target on (business_id, payment_id)', async () => {
      stubMember();
      mockDb.insert.mockReturnValueOnce(createBuilder([]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'chk-1', paymentId: 'pay-8', points: 1, amountCents: 5000 }]),
      );

      await COUNTER_POST('/v1/loyalty/checkins', { payment_id: 'pay-8', member_code: 'ABC-1234', amount_cents: 5000 });

      // The dedupe has to be the unique index's, decided by Postgres in the same
      // statement. A read-then-write would let two concurrent retries of one
      // payment both insert, and the loser would fail as an unhandled error rather
      // than answering 200.
      const statement = mockDb.insert.mock.results[0]?.value?.onConflictDoNothing?.mock.calls[0]?.[0];
      expect(statement).toBeDefined();
      expect(statement.target).toHaveLength(2);
    });

    it.each([
      // The member code is present in every case here, so the amount is what these
      // are about. A request missing both is judged on the member code first and is
      // asserted separately below.
      { label: 'absent', body: { member_code: 'ABC-1234' } },
      { label: 'a string', body: { member_code: 'ABC-1234', amount_cents: 'mucho' } },
      { label: 'a decimal', body: { member_code: 'ABC-1234', amount_cents: 50.5 } },
      { label: 'zero', body: { member_code: 'ABC-1234', amount_cents: 0 } },
      { label: 'negative', body: { member_code: 'ABC-1234', amount_cents: -5000 } },
    ])('answers 400 and writes nothing when the amount is $label', async ({ body }) => {
      const res = await COUNTER_POST('/v1/loyalty/checkins', body);

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_AMOUNT_CENTS');
      // The sale has already happened at this point, so the check must run before
      // the database is touched at all — not merely before the insert.
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.execute).not.toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('answers 400 when there is no member_code to attribute the sale to', async () => {
      const res = await COUNTER_POST('/v1/loyalty/checkins', { amount_cents: 5000 });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('INVALID_MEMBER_CODE');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('answers 404 and writes nothing when the code belongs to nobody', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([]));

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-9',
        member_code: 'GONE-0000',
        amount_cents: 5000,
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('MEMBER_CODE_NOT_FOUND');
      // Nothing is written. A sale with no member has no identity to attach to,
      // and inventing one would put points on somebody else's balance for a
      // purchase they did not make. `withRls` has already opened the session by
      // this point, so the claim is about writes rather than about contact.
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(ledgerStatements()).toEqual([]);
    });
  });

  // ==========================================================================
  // POST /v1/loyalty/passes/resolve and POST /v1/loyalty/checkins — counter only
  //
  // These two routes had no role guard at all, and that was the defect: not a
  // wrong guard, an absent one. `POST /v1/auth/customer/token` is public and mints
  // `role: 'customer'`, so before this every customer could scan-resolve any
  // member_code and then report a fabricated sale against an arbitrary
  // `member_code`, crediting whatever the tenant's earn rule made of it.
  //
  // The subject here is a *third* kind, not "not a customer". `requireOperatorRole`
  // would be wrong here for a product reason, not only a security one: the
  // terminal never sends points, it sends `amount_cents`, and the earn rule on the
  // tenant's program decides what that is worth. Refusing the counter the way the
  // dashboard operator is refused would refuse the only legitimate caller.
  //
  // Two properties are asserted, same as the operator guard above:
  //
  //   1. Nothing was written, and nothing was read — the guard is ahead of the
  //      body parse, ahead of `createDb` and ahead of `withRls`.
  //   2. The answer does not depend on what the request would otherwise have
  //      done, so the tenant cannot be probed through the refusal.
  // ==========================================================================

  /** The two routes, paired with a body each accepts. */
  const COUNTER_ROUTES = [
    { path: '/v1/loyalty/checkins', body: { payment_id: 'pay-1', member_code: 'ABC-1234', amount_cents: 5000 } },
    { path: '/v1/loyalty/passes/resolve', body: { member_code: 'ABC-1234' } },
  ] as const;

  /**
   * Not one statement was sent. `createDb` is included because that is the
   * earliest point a guarded route could have reached the database at all.
   */
  function expectNoWrite() {
    expect(createDb).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  }

  /**
   * The customer role exactly as the public token endpoint mints it: the subject
   * is that customer's `global_id`, a uuid — which is also why a customer can
   * never be mistaken for a counter subject.
   */
  const CUSTOMER_TOKEN: TestAuth = {
    userId: 'c0ffee00-0000-4000-8000-000000000001',
    businessId: 'biz-1',
    userRole: 'customer',
  };

  describe('the counter subject', () => {
    it('records the sale for a terminal, and credits it', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.select.mockReturnValueOnce(
        createBuilder([{ id: 'prog-1', earnRate: '1.0000', earnBy: 'visit', earnUnitAmount: '1000.00' }]),
      );
      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.insert.mockReturnValueOnce(
        createBuilder([{ id: 'chk-1', businessId: 'biz-1', customerId: 'cust-1', amountCents: 5000 }]),
      );
      mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 2 }] });

      const res = await COUNTER_POST('/v1/loyalty/checkins', {
        payment_id: 'pay-1',
        member_code: 'ABC-1234',
        amount_cents: 5000,
      });

      expect(res.status).not.toBe(403);
      expect(res.status).toBe(201);
      expect(mockDb.insert).toHaveBeenCalledOnce();
    });

    it('resolves the pass for a terminal', async () => {
      mockDb.select.mockReturnValueOnce(createBuilder([{ id: 'cust-1', currentTierId: null }]));
      mockDb.select.mockReturnValueOnce(createBuilder([{ fullName: 'Ada Lovelace' }]));

      const res = await COUNTER_POST('/v1/loyalty/passes/resolve', { member_code: 'ABC-1234' });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: Record<string, unknown> };
      expect(json.data.known).toBe(true);
    });
  });

  describe('a customer token is refused on both', () => {
    it.each(COUNTER_ROUTES)('refuses $path with the counter code and writes nothing', async ({ path, body }) => {
      const res = await reqAs('POST', path, CUSTOMER_TOKEN, body);

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('COUNTER_SUBJECT_REQUIRED');
      // The report of a *completed sale* is the merchant's terminal's to make. A
      // customer asserting one would be crediting themselves points off a purchase
      // that never happened, which is exactly the defect `requireOperatorRole` was
      // written for on `points/assign`.
      expect(mockDb.insert).not.toHaveBeenCalled();
      expectNoWrite();
    });
  });

  describe('an operator token is refused on both — the dashboard is not a counter', () => {
    it.each(COUNTER_ROUTES)('refuses $path, because the gap was the absence of a guard', async ({ path, body }) => {
      // `requireOperatorRole` would pass this token, so the operator case is the
      // one that proves the new guard is doing work rather than inheriting the old
      // one's leniency: a merchant logged into the dashboard cannot report a
      // terminal's sale. The manual path it would want is `points/assign`, which
      // the dashboard already calls and which stays operator-guarded.
      const res = await reqAs('POST', path, OPERATOR_AUTH, body);

      expect(res.status).toBe(403);
      const json = (await res.json()) as Record<string, Record<string, unknown>>;
      expect(json.error.code).toBe('COUNTER_SUBJECT_REQUIRED');
      expect(mockDb.insert).not.toHaveBeenCalled();
      expectNoWrite();
    });
  });

  describe('a subject that only looks like a counter is refused on both', () => {
    // The marker is `pos:` and the prefix must be *exact*: a bare `pos`, a `pos`
    // with no separator, or the same letters in a different case is not a counter
    // subject. Every other subject the issuer hands out is a uuid, so there is
    // nothing legitimate that can begin this way.
    const NEAR_MISSES: { label: string; userId: string }[] = [
      { label: 'pos with no separator', userId: 'pos' },
      { label: 'pos with no terminal behind it', userId: 'pos:' },
      { label: 'a longer word starting with pos', userId: 'postal-terminal-1' },
      { label: 'a different separator', userId: 'pos_terminal-1' },
      { label: 'the same letters in another case', userId: 'POS:terminal-1' },
      { label: 'a plain operator subject', userId: 'user-1' },
    ];

    it.each(NEAR_MISSES)(
      'refuses $label on checkins and on passes/resolve',
      async ({ userId }) => {
        const auth: TestAuth = { userId, businessId: 'biz-1', userRole: 'terminal' };

        const checkin = await reqAs(
          'POST',
          '/v1/loyalty/checkins',
          auth,
          { payment_id: 'pay-1', member_code: 'ABC-1234', amount_cents: 5000 },
        );
        const resolve = await reqAs(
          'POST',
          '/v1/loyalty/passes/resolve',
          auth,
          { member_code: 'ABC-1234' },
        );

        expect(checkin.status).toBe(403);
        expect(resolve.status).toBe(403);
        const checkinJson = (await checkin.json()) as Record<string, Record<string, unknown>>;
        expect(checkinJson.error.code).toBe('COUNTER_SUBJECT_REQUIRED');
        expect(mockDb.insert).not.toHaveBeenCalled();
        expectNoWrite();
      },
    );
  });

  describe('the refusal is the same either way — no existence oracle', () => {
    it('answers one refusal for a sale that would have been recorded and one that would not', async () => {
      // A counter recording the first body gets 201 (pinned in the describe above);
      // a counter sending the second gets 400 INVALID_AMOUNT_CENTS. The operator
      // gets the same 403 and the same bytes for both, so the guard is ahead of the
      // body parse and the refusal leaks nothing about what would have happened.
      const valid = { payment_id: 'pay-1', member_code: 'ABC-1234', amount_cents: 5000 };
      const rejectedByValidation = { ...valid, amount_cents: 0 };

      const accepted = await reqAs('POST', '/v1/loyalty/checkins', OPERATOR_AUTH, valid);
      const refused = await reqAs('POST', '/v1/loyalty/checkins', OPERATOR_AUTH, rejectedByValidation);

      expect(accepted.status).toBe(403);
      expect(refused.status).toBe(403);
      expect(await accepted.text()).toBe(await refused.text());
      expectNoWrite();
    });

    it('answers one refusal on passes/resolve whether or not the code is one anybody has', async () => {
      // A counter gets 200 `known: false` for a code nobody has (pinned above). The
      // operator must not be able to tell that answer from the refusal, or the
      // route becomes a membership oracle for any authenticated token. A body is
      // readable once, so the three responses are drained before they are compared.
      const someoneElses = { member_code: 'ABC-1234' };
      const nobody = { member_code: 'NOPE-0000' };
      const missing = {};

      const first = await reqAs('POST', '/v1/loyalty/passes/resolve', OPERATOR_AUTH, someoneElses);
      const second = await reqAs('POST', '/v1/loyalty/passes/resolve', OPERATOR_AUTH, nobody);
      const third = await reqAs('POST', '/v1/loyalty/passes/resolve', OPERATOR_AUTH, missing);

      const statuses = [first.status, second.status, third.status];
      const bodies = await Promise.all([first.text(), second.text(), third.text()]);

      expect(statuses).toEqual([403, 403, 403]);
      expect(new Set(bodies).size).toBe(1);
      expectNoWrite();
    });
  });
});

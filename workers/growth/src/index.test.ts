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
  const { pgTable, uuid, integer, numeric, text, timestamp } = await import('drizzle-orm/pg-core');
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
  const table = {};
  return {
    createDb: vi.fn(),
    loyaltyPrograms: table,
    membershipTiers: tierTable,
    customers: customerTable,
    pointsTransactions: pointsTable,
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
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { isCustomerRole } from './helpers';

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
});

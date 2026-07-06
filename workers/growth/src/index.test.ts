// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@vyloop/db', () => {
  const table = {};
  return {
    createDb: vi.fn(),
    loyaltyPrograms: table,
    membershipTiers: table,
    customers: table,
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
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function req(method: string, path: string, body?: unknown) {
  const r = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': 'user-1',
      'X-Business-Id': 'biz-1',
      'X-User-Role': 'admin',
    },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  return app.fetch(r, {
    DATABASE_URL: 'postgres://mock',
    DOMAIN_EVENTS_QUEUE: {} as Queue,
    SCHEMA_REGISTRY: {} as KVNamespace,
  } as Record<string, unknown>);
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
});

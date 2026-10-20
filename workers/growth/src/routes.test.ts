/// <reference types="node" />
// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('@vyloop/db', async () => {
  // The tables are real, for the reason they are real in `index.test.ts`: a
  // flat `{}` renders an opaque predicate, so a lookup that ignored the
  // tenant would pass the same assertion as one that honoured it.
  const { pgTable, uuid, text, timestamp, jsonb, integer, numeric } = await import(
    'drizzle-orm/pg-core'
  );

  const branchTable = pgTable('branches', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    name: text('name').notNull(),
  });

  const customerTable = pgTable('customers', {
    id: uuid('id').primaryKey(),
    globalId: uuid('global_id').notNull(),
    businessId: uuid('business_id').notNull(),
    currentTierId: uuid('current_tier_id'),
    deletedAt: timestamp('deleted_at'),
    memberCode: text('member_code'),
    fullName: text('full_name'),
  });

  const checkinTable = pgTable('checkins', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    branchId: uuid('branch_id'),
    memberCode: text('member_code').notNull(),
    paymentId: text('payment_id'),
    amountCents: integer('amount_cents').notNull(),
    items: jsonb('items'),
    note: text('note'),
    points: integer('points'),
    createdAt: timestamp('created_at').notNull(),
  });

  const customerEventTable = pgTable('customer_events', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    eventType: text('event_type').notNull(),
    branchId: uuid('branch_id'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at').notNull(),
  });

  const programTable = pgTable('loyalty_programs', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    earnBy: text('earn_by'),
    earnRate: numeric('earn_rate'),
    earnUnitAmount: numeric('earn_unit_amount'),
  });

  const tierTable = pgTable('membership_tiers', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    programId: uuid('program_id').notNull(),
    name: text('name').notNull(),
    minPoints: integer('min_points').notNull(),
    multiplier: numeric('multiplier').notNull(),
    displayOrder: integer('display_order').notNull(),
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
  const actual = await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');

  return {
    createDb: vi.fn(),
    branches: branchTable,
    customers: customerTable,
    checkins: checkinTable,
    customerEvents: customerEventTable,
    loyaltyPrograms: programTable,
    membershipTiers: tierTable,
    pointsTransactions: pointsTable,
    settledPayments: table,
    tenants: table,
    rewards: table,
    rewardGrants: table,
    posTerminals: table,
    hashPassword: actual.hashPassword,
    verifyPassword: actual.verifyPassword,
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
  CUSTOMER_CHECKED_IN: 'CustomerCheckedIn',
}));

// ---------------------------------------------------------------------------
// Imports (after the mock hoisting)
// ---------------------------------------------------------------------------

import { createDb, customerEvents } from '@vyloop/db';
import { publish } from '@vyloop/event-bus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import router from './routes';

/** The mocked `publish`, so its calls can be read. */
const publishMock = publish as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type Builder = any;

function createBuilder(data: unknown = []): Builder {
  const promise = Promise.resolve(data);
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.set = vi.fn(() => builder);
  builder.values = vi.fn(() => builder);
  builder.orderBy = vi.fn(() => builder);
  builder.offset = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.then = promise.then.bind(promise);
  builder.catch = promise.catch.bind(promise);
  builder.finally = promise.finally.bind(promise);
  return builder;
}

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  return {
    select: vi.fn(() => createBuilder()),
    insert: vi.fn(() => createBuilder()),
    update: vi.fn(() => createBuilder()),
    delete: vi.fn(() => createBuilder()),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

let mockDb: MockDb;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The venue the sale happened at. */
const BRANCH_ID = '11111111-1111-4111-8111-111111111111';

/** A venue of another tenant. */
const OTHER_TENANT_BRANCH_ID = '22222222-2222-4222-8222-222222222222';

/** A merchant's payment terminal — the only subject the checkin route accepts. */
const COUNTER_AUTH = {
  'X-User-Id': 'pos:0f9c1d2e-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
  'X-Business-Id': 'biz-1',
  'X-User-Role': 'terminal',
};

const mockEnv = {
  DATABASE_URL: 'postgres://mock',
  DOMAIN_EVENTS_QUEUE: {} as Queue,
  DELIVERY_QUEUE: { send: vi.fn() } as unknown as Queue,
  SCHEMA_REGISTRY: {} as KVNamespace,
};

function post(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/v1/loyalty/checkins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...COUNTER_AUTH },
    body: JSON.stringify(body),
  });
  return Promise.resolve(router.fetch(request, mockEnv as never));
}

/** The row the route inserted, as the route passed it to `values()`. */
function insertedValues(call = 0): Record<string, unknown> {
  const builder = mockDb.insert.mock.results[call]?.value as {
    values: { mock: { calls: unknown[][] } };
  };
  return builder?.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

/** The table the route inserted into. */
function insertedTable(call = 0): unknown {
  return mockDb.insert.mock.calls[call]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb = createMockDb();
  vi.mocked(createDb).mockReturnValue(mockDb as never);

  // The venue the sale happened at.
  mockDb.select.mockReturnValueOnce(createBuilder([{ id: BRANCH_ID }]));
  // The customer the scanned code resolves to.
  mockDb.select.mockReturnValueOnce(
    createBuilder([{ id: 'cust-1', globalId: 'global-1', currentTierId: null }]),
  );
  // The tenant's accumulation rule.
  mockDb.select.mockReturnValueOnce(
    createBuilder([
      { id: 'prog-1', earnRate: '1.0000', earnBy: 'visit', earnUnitAmount: '1000.00' },
    ]),
  );
  // The checkin row.
  mockDb.insert.mockReturnValueOnce(
    createBuilder([
      {
        id: 'chk-1',
        businessId: 'biz-1',
        customerId: 'cust-1',
        branchId: BRANCH_ID,
        memberCode: 'ABC-1234',
        paymentId: 'pay-1',
        amountCents: 5000,
        items: null,
        note: null,
        points: null,
      },
    ]),
  );
  // The ledger row.
  mockDb.execute.mockResolvedValueOnce({ rows: [] });
  mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 1 }] });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/loyalty/checkins — the venue', () => {
  it('records the sale at the venue and reports the interaction', async () => {
    const res = await post({
      payment_id: 'pay-1',
      member_code: 'ABC-1234',
      amount_cents: 5000,
      branch_id: BRANCH_ID,
    });

    expect(res.status).toBe(201);

    // The sale carries the venue.
    expect(insertedValues(0)).toMatchObject({ branchId: BRANCH_ID });

    // And the interaction with that venue is recorded, so that a campaign
    // aimed at the venue has an audience to find.
    expect(insertedTable(1)).toBe(customerEvents);
    expect(insertedValues(1)).toMatchObject({
      businessId: 'biz-1',
      customerId: 'cust-1',
      eventType: 'customer.checked_in',
      branchId: BRANCH_ID,
    });
  });

  it('publishes the interaction to the delivery queue, by the customer global id', async () => {
    await post({
      payment_id: 'pay-1',
      member_code: 'ABC-1234',
      amount_cents: 5000,
      branch_id: BRANCH_ID,
    });

    // The interaction is published to the delivery queue, and the event
    // carries the customer's global id — the id every customer event carries.
    const checkedIn = publishMock.mock.calls.find(
      (call: unknown[]) => (call[1] as { type: string }).type === 'CustomerCheckedIn',
    );
    expect(checkedIn).toBeDefined();
    const [queue, event] = checkedIn as [unknown, { type: string; payload: any }];
    expect(queue).toBe(mockEnv.DELIVERY_QUEUE);
    expect(event.payload).toEqual({
      customer_id: 'global-1',
      business_id: 'biz-1',
      branch_id: BRANCH_ID,
      checkin_id: 'chk-1',
    });
  });

  it('answers 404 for a venue of another tenant', async () => {
    // The venue is not there, as far as this tenant is concerned. A 403 would
    // say "it exists, and it is not yours"; the answer is the same either way.
    mockDb.select.mockReset();
    mockDb.select.mockReturnValueOnce(createBuilder([]));

    const res = await post({
      payment_id: 'pay-1',
      member_code: 'ABC-1234',
      amount_cents: 5000,
      branch_id: OTHER_TENANT_BRANCH_ID,
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('BRANCH_NOT_FOUND');
    // Nothing was written: a sale at a venue that is not the tenant's is not
    // a sale this route can record.
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(
      publishMock.mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'CustomerCheckedIn',
      ),
    ).toBeUndefined();
  });

  it('answers 400 for a venue that is not a uuid', async () => {
    const res = await post({
      payment_id: 'pay-1',
      member_code: 'ABC-1234',
      amount_cents: 5000,
      branch_id: 'not-a-uuid',
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('INVALID_BRANCH_ID');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('records a sale with no venue, and reports no interaction', async () => {
    // The venue is optional. A sale without one is a sale, and it is not an
    // interaction with a place, so there is nothing to publish.
    mockDb.select.mockReset();
    mockDb.select.mockReturnValueOnce(
      createBuilder([{ id: 'cust-1', globalId: 'global-1', currentTierId: null }]),
    );
    mockDb.select.mockReturnValueOnce(
      createBuilder([
        { id: 'prog-1', earnRate: '1.0000', earnBy: 'visit', earnUnitAmount: '1000.00' },
      ]),
    );
    mockDb.insert.mockReturnValueOnce(
      createBuilder([
        {
          id: 'chk-1',
          businessId: 'biz-1',
          customerId: 'cust-1',
          memberCode: 'ABC-1234',
          paymentId: 'pay-1',
          amountCents: 5000,
          items: null,
          note: null,
          points: null,
        },
      ]),
    );
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    mockDb.execute.mockResolvedValueOnce({ rows: [{ id: 'tx-1', balance_after: 1 }] });

    const res = await post({
      payment_id: 'pay-1',
      member_code: 'ABC-1234',
      amount_cents: 5000,
    });

    expect(res.status).toBe(201);
    expect(insertedValues(0)).toMatchObject({ branchId: null });
    // No interaction row, and no interaction published: there was no
    // interaction with a place.
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(
      publishMock.mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'CustomerCheckedIn',
      ),
    ).toBeUndefined();
  });
});

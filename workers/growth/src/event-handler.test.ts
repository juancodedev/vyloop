import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** A thenable query chain that resolves to `value`. */
function chain<T>(value?: T) {
  const val: unknown = value !== undefined ? value : [];
  const c = {
    from: () => c,
    where: () => c,
    limit: () => c,
    orderBy: () => c,
    offset: () => c,
    values: () => c,
    set: vi.fn(() => c),
    returning: vi.fn().mockResolvedValue([]),
    then: (fn: (v: unknown) => unknown) => Promise.resolve(val).then(fn),
  };
  return c;
}

const dbMock = {
  insert: vi.fn(() => chain()),
  select: vi.fn(() => chain()),
  update: vi.fn(() => chain()),
  execute: vi.fn().mockResolvedValue({ rows: [{ balance: 1200 }] }),
};

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  customers: { id: 'customers.id', businessId: 'business_id', globalId: 'global_id', currentTierId: 'current_tier_id' },
  membershipTiers: { id: 'membership_tiers.id', businessId: 'business_id', minPoints: 'min_points', name: 'name' },
  loyaltyPrograms: { id: 'loyalty_programs.id', businessId: 'business_id' },
  rewards: { id: 'rewards.id', businessId: 'business_id', name: 'name', autoGrantThreshold: 'auto_grant_threshold' },
  rewardBranches: { rewardId: 'reward_id', branchId: 'branch_id' },
  rewardGrants: { id: 'reward_grants.id', customerId: 'customer_id', rewardId: 'reward_id' },
}));

const publish = vi.hoisted(() => vi.fn(async (_queue: unknown, _event: unknown) => undefined));

vi.mock('@vyloop/event-bus', () => ({
  publish,
  createEnvelope: (type: string, header: unknown, payload: unknown) => ({
    id: 'evt',
    type,
    source: 'growth',
    specversion: '1.0',
    time: '2026-10-21T12:00:00Z',
    header,
    payload,
  }),
  CUSTOMER_CHECKED_IN: 'CustomerCheckedIn',
  REWARD_AUTO_GRANTED: 'RewardAutoGranted',
  REWARD_AVAILABLE_AT_BRANCH: 'RewardAvailableAtBranch',
}));

const { handleEvent } = await import('./event-handler');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Env = Parameters<typeof handleEvent>[2];

function env(withDelivery = true): Env {
  const base = {
    DATABASE_URL: 'postgres://test',
    DOMAIN_EVENTS_QUEUE: { send: vi.fn() },
    SCHEMA_REGISTRY: {},
  };

  return (withDelivery ? { ...base, DELIVERY_QUEUE: { send: vi.fn() } } : base) as unknown as Env;
}

function pointsAssignedEvent() {
  return {
    id: 'evt-1',
    type: 'PointsAssigned',
    source: 'test',
    specversion: '1.0',
    time: '2026-10-21T12:00:00Z',
    header: { business_id: 'biz-1', timestamp: '2026-10-21T12:00:00Z' },
    payload: {
      customer_id: 'cust-1',
      points_assigned: 200,
      points_multiplier: 1,
      total_points: 1200,
      reference_id: 'ref-1',
      assignment_id: 'asg-1',
    },
  } as never;
}

const reward = { id: 'reward-1', name: 'Café gratis', autoGrantThreshold: 1000 };

/**
 * Queue the reads the handler makes, in order: the customer, the tier, the
 * auto-grant candidates, the existing grant, then the reward's venue scope.
 */
function queueReads(opts: { scope?: unknown[]; existingGrant?: unknown[] } = {}) {
  dbMock.select.mockReturnValueOnce(
    chain([{ id: 'cust-1', globalId: 'global-1', currentTierId: null }]),
  );
  dbMock.select.mockReturnValueOnce(chain([])); // no eligible tier
  dbMock.select.mockReturnValueOnce(chain([reward]));
  dbMock.select.mockReturnValueOnce(chain(opts.existingGrant ?? []));
  dbMock.select.mockReturnValueOnce(chain(opts.scope ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  // The only insert on this path is the grant, and its id is what the
  // announcement has to carry.
  dbMock.insert.mockReturnValueOnce(
    Object.assign(chain(), { returning: vi.fn().mockResolvedValue([{ id: 'grant-1' }]) }),
  );
  dbMock.insert.mockReturnValue(chain());
});

// ---------------------------------------------------------------------------
// The venue-scoped announcement
// ---------------------------------------------------------------------------

describe('PointsAssigned auto-grant', () => {
  it('announces a scoped grant once, on the delivery queue', async () => {
    queueReads({ scope: [{ branchId: 'branch-1' }, { branchId: 'branch-2' }] });

    const bindings = env();
    await handleEvent(pointsAssignedEvent(), {} as never, bindings as never);

    expect(publish).toHaveBeenCalledTimes(2);
    const [domainQueue, domainEvent] = publish.mock.calls[0] as unknown as [unknown, { type: string }];
    expect(domainQueue).toBe(bindings.DOMAIN_EVENTS_QUEUE);
    expect(domainEvent.type).toBe('RewardAutoGranted');

    const [deliveryQueue, deliveryEvent] = publish.mock.calls[1] as unknown as [
      unknown,
      { type: string; payload: Record<string, unknown> },
    ];
    expect(deliveryQueue).toBe(bindings.DELIVERY_QUEUE);
    expect(deliveryEvent.type).toBe('RewardAvailableAtBranch');
    expect(deliveryEvent.payload).toMatchObject({
      customer_id: 'global-1', // the id a push delivery resolves
      reward_id: 'reward-1',
      reward_name: 'Café gratis',
      grant_id: 'grant-1',
      branch_ids: ['branch-1', 'branch-2'],
    });
  });

  it('does not announce an unscoped grant', async () => {
    queueReads({ scope: [] });

    await handleEvent(pointsAssignedEvent(), {} as never, env());

    // A reward good everywhere is what RewardAutoGranted already says; the
    // announcement exists to say *where*.
    expect(publish).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0][1] as { type: string }).type).toBe('RewardAutoGranted');
  });

  it('does not announce a grant that already existed', async () => {
    queueReads({ existingGrant: [{ id: 'grant-old' }] });

    await handleEvent(pointsAssignedEvent(), {} as never, env());

    expect(publish).not.toHaveBeenCalled();
  });

  it('records the grant but skips the announcement when the binding is missing', async () => {
    queueReads({ scope: [{ branchId: 'branch-1' }] });

    await expect(
      handleEvent(pointsAssignedEvent(), {} as never, env(false)),
    ).resolves.toBeUndefined();

    // The grant is the record; a missing queue must not fail the points that
    // produced it.
    expect(publish).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0][1] as { type: string }).type).toBe('RewardAutoGranted');
  });
});

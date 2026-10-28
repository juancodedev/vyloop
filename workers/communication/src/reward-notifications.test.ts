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
    innerJoin: () => c,
    values: () => c,
    returning: vi.fn().mockResolvedValue([]),
    then: (fn: (v: unknown) => unknown) => Promise.resolve(val).then(fn),
  };
  return c;
}

const dbMock = {
  insert: vi.fn(() => chain()),
  select: vi.fn(() => chain()),
  update: vi.fn(() => chain()),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  // The tenant transaction hands the callback this same mock as its handle.
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock)),
};

vi.mock('@vyloop/db', async () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  // The real helper, so a test sees the `set_config` it really issues.
  withTenantTransaction: (await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db'))
    .withTenantTransaction,
  messageLog: { id: 'message_log.id', businessId: 'business_id', customerId: 'customer_id', channel: 'channel', createdAt: 'created_at', content: 'content' },
  customers: { id: 'customers.id', businessId: 'business_id', globalId: 'global_id', deletedAt: 'deleted_at' },
  branches: { id: 'branches.id', businessId: 'business_id', name: 'name' },
}));

const deliverPushNotification = vi.hoisted(() =>
  vi.fn(async (_message: Record<string, unknown>, _businessId: string) => ({
    delivered: 1,
    failed: 0,
    removed: 0,
    subscriptions: 1,
  })),
);

vi.mock('./push-delivery', () => ({ deliverPushNotification }));

const {
  describeRewardVenues,
  handleRewardAvailableAtBranch,
  REWARD_REFERENCE_PREFIX,
} = await import('./reward-notifications');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const env = {
  DATABASE_URL: 'postgres://test',
  DELIVERY_QUEUE: {} as unknown,
  SCHEMA_REGISTRY: {} as unknown,
  VAPID_PUBLIC_KEY: 'pub',
  VAPID_PRIVATE_KEY: 'priv',
  VAPID_SUBJECT: 'mailto:test@example.com',
} as unknown as Parameters<typeof handleRewardAvailableAtBranch>[2];

const payload = {
  customer_id: '123e4567-e89b-12d3-a456-426614174000',
  reward_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  reward_name: 'Café gratis',
  grant_id: 'c4d5e6f7-8a9b-0c1d-2e3f-456789abcdef',
  branch_ids: ['b0000000-0000-4000-8000-000000000001'],
  granted_at: '2026-10-21T12:00:00Z',
};

/** The customer read, the cap read, then the venue read. */
function queueReads(opts: {
  customer?: unknown[];
  announced?: unknown[];
  venues?: unknown[];
}) {
  dbMock.select.mockReturnValueOnce(chain(opts.customer ?? [{ id: 'cust-internal' }]));
  dbMock.select.mockReturnValueOnce(chain(opts.announced ?? []));
  dbMock.select.mockReturnValueOnce(
    chain(opts.venues ?? [{ id: payload.branch_ids[0], name: 'Providencia' }]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  deliverPushNotification.mockResolvedValue({
    delivered: 1,
    failed: 0,
    removed: 0,
    subscriptions: 1,
  });
});

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

describe('describeRewardVenues', () => {
  it('names the venue when the reward is scoped to exactly one', () => {
    expect(describeRewardVenues(['Providencia'], 1)).toBe('en Providencia');
  });

  it('names the count when the reward is scoped to several', () => {
    // Q5: naming one of several would send the customer to the wrong place.
    expect(describeRewardVenues(['Providencia', 'Las Condes'], 2)).toBe('en 2 locales');
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe('handleRewardAvailableAtBranch', () => {
  it('announces the reward at the venue it was scoped to', async () => {
    queueReads({});

    const outcome = await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    expect(outcome).toEqual({ result: 'sent', delivered: 1 });
    expect(deliverPushNotification).toHaveBeenCalledTimes(1);

    const [message, businessId] = deliverPushNotification.mock.calls[0] as unknown as [
      { customer_id: string; title: string; body: string; url: string; reference_id: string },
      string,
    ];
    expect(businessId).toBe('biz-1');
    expect(message.customer_id).toBe(payload.customer_id);
    expect(message.title).toContain('Café gratis');
    expect(message.body).toContain('Providencia');
    expect(message.url).toBe('/profile/rewards');
    expect(message.reference_id).toBe(`${REWARD_REFERENCE_PREFIX}${payload.grant_id}`);
  });

  it('carries no balance in the body', async () => {
    queueReads({});

    await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    const [message] = deliverPushNotification.mock.calls[0] as unknown as [{ title: string; body: string }];
    // A push body is read by whoever holds the phone. Points, balance and the
    // customer's name stay in the app.
    expect(`${message.title} ${message.body}`).not.toMatch(/punto|saldo|balance/i);
    expect(`${message.title} ${message.body}`).not.toMatch(/\d{2,}/);
  });

  it('does not deliver without consent', async () => {
    queueReads({});
    // Consent and the browser check live inside the delivery, so this is what
    // "no consent" looks like from here: nothing was reached.
    deliverPushNotification.mockResolvedValue({
      delivered: 0,
      failed: 0,
      removed: 0,
      subscriptions: 1,
    });

    const outcome = await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    expect(outcome).toEqual({ result: 'not_delivered', delivered: 0 });
  });

  it('sends once on redelivery, because the reference is the grant', async () => {
    queueReads({});
    queueReads({});

    await handleRewardAvailableAtBranch(payload, 'biz-1', env);
    await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    const refs = deliverPushNotification.mock.calls.map(
      (call) => (call[0] as { reference_id: string }).reference_id,
    );
    // The delivery layer skips a reference it already decided; a stable
    // reference is what makes a redelivered event harmless.
    expect(refs[0]).toBe(refs[1]);
  });

  it('acknowledges without delivering when a reward was announced today', async () => {
    queueReads({ announced: [{ id: 'ml-1' }] });

    const outcome = await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    expect(outcome).toEqual({ result: 'capped', delivered: 0 });
    expect(deliverPushNotification).not.toHaveBeenCalled();
  });

  it('never resolves a deleted customer, so the announcement reaches no one', async () => {
    // Pinned rather than assumed: deleting an account is an `UPDATE` of
    // `deleted_at`, so the row is still there to be found by its global id. The
    // fake tables are plain strings, so the predicate renders the column name as
    // a bound value; what is asserted is that `deleted_at` is tested for null.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const lookup = chain([]);
    const where = vi.fn((_predicate: unknown) => lookup);
    dbMock.select.mockReturnValueOnce({ ...lookup, from: () => ({ ...lookup, where }) } as never);

    const outcome = await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    const rendered = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never);
    expect(rendered.params).toContain('deleted_at');
    expect(rendered.sql).toMatch(/\$\d+ is null/);
    expect(outcome).toEqual({ result: 'no_customer', delivered: 0 });
    expect(deliverPushNotification).not.toHaveBeenCalled();
  });

  it('acknowledges when the customer is unknown', async () => {
    dbMock.select.mockReturnValueOnce(chain([]));

    const outcome = await handleRewardAvailableAtBranch(payload, 'biz-1', env);

    expect(outcome).toEqual({ result: 'no_customer', delivered: 0 });
    expect(deliverPushNotification).not.toHaveBeenCalled();
  });
});

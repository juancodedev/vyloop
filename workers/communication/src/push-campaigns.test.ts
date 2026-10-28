import type { KVNamespace, Queue, Fetcher } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const dbMock: any = {
  select: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', async () => {
  // The tables are real for the same reason they are real in the growth
  // worker's tests: a flat `{}` renders an opaque predicate, so a query that
  // ignored the tenant or the window would pass the same assertion as one
  // that honoured them.
  const { pgTable, uuid, text, timestamp } = await import('drizzle-orm/pg-core');

  const customerEventsTable = pgTable('customer_events', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    eventType: text('event_type').notNull(),
    branchId: uuid('branch_id'),
    createdAt: timestamp('created_at').notNull(),
  });

  const customersTable = pgTable('customers', {
    id: uuid('id').primaryKey(),
    globalId: uuid('global_id').notNull(),
    businessId: uuid('business_id').notNull(),
    deletedAt: timestamp('deleted_at'),
  });

  // Real, for the same reason as the tables above: the wallet channel's
  // predicate has to compile, so a query that ignored the tenant or the
  // `issued` state would admit rows the production query must reject.
  const customerWalletPassesTable = pgTable('customer_wallet_passes', {
    customerId: uuid('customer_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    objectId: text('object_id').notNull(),
    state: text('state').notNull(),
  });

  return {
    createDb: vi.fn(() => dbMock),
    setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
    customerEvents: customerEventsTable,
    customers: customersTable,
    customerWalletPasses: customerWalletPassesTable,
    readConsentMap: vi.fn(async () => ({ nearby_notifications: true })),
    readPushSubscriptions: vi.fn(async () => []),
  };
});

vi.mock('./push-delivery', () => ({
  deliverPushNotification: vi.fn(async () => ({
    delivered: 1,
    failed: 0,
    removed: 0,
    subscriptions: 1,
  })),
}));

const { readConsentMap, readPushSubscriptions } = (await import('@vyloop/db')) as unknown as {
  readConsentMap: ReturnType<typeof vi.fn>;
  readPushSubscriptions: ReturnType<typeof vi.fn>;
};

const { deliverPushNotification } = (await import('./push-delivery')) as unknown as {
  deliverPushNotification: ReturnType<typeof vi.fn>;
};

const { handlePushCampaignRequested, resolveCampaignAudience, INTERACTION_WINDOW_DAYS } =
  (await import('./push-campaigns')) as unknown as {
    handlePushCampaignRequested: (
      payload: unknown,
      businessId: string,
      env: unknown,
    ) => Promise<{
      audience: number;
      web_push: { delivered: number; failed: number; skipped: number };
      wallet: { delivered: number; failed: number; skipped: number };
    }>;
    resolveCampaignAudience: (
      db: unknown,
      businessId: string,
      target: unknown,
    ) => Promise<{ customerId: string; globalId: string }[]>;
    INTERACTION_WINDOW_DAYS: number;
  };

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

const mockEnv = {
  DATABASE_URL: 'postgres://test',
  DELIVERY_QUEUE: {} as Queue,
  SCHEMA_REGISTRY: {} as KVNamespace,
  WHATSAPP_PHONE_ID: 'test-phone-id',
  WHATSAPP_TOKEN: 'test-token',
  WHATSAPP_API_VERSION: 'v21.0',
  WHATSAPP_VERIFY_TOKEN: 'test-token',
  VAPID_PUBLIC_KEY: 'public',
  VAPID_PRIVATE_KEY: 'private',
  VAPID_SUBJECT: 'mailto:ops@example.test',
  wallet: {
    fetch: vi.fn(async () => {
      const body = JSON.stringify({ error: { code: 'PASS_NOT_ISSUED', message: 'Customer has no issued wallet pass' } });
      return {
        ok: false,
        status: 409,
        text: async () => body,
      };
    }),
  } as unknown as Fetcher,
};

const walletFetch = mockEnv.wallet.fetch as unknown as ReturnType<typeof vi.fn>;

/** A chainable stand-in for a Drizzle query, resolving to `rows`. */
function createQueryChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (onfulfilled: (value: unknown) => unknown) =>
    Promise.resolve(rows).then(onfulfilled);
  return chain;
}

/** The rows the audience query answers with. */
function audienceRows(rows: unknown[]) {
  const chain = createQueryChain(rows);
  dbMock.select.mockReturnValueOnce(chain);
  return chain;
}

/**
 * The rows the wallet channel's pass query answers with.
 *
 * The query asks for an `issued` pass; the fake honours the table read and the
 * fixture decides the answer, which is enough to drive the two branches that
 * matter here: a pass to notify, and no pass at all.
 */
function walletPassRows(rows: unknown[] = []) {
  const chain = createQueryChain(rows);
  dbMock.select.mockReturnValueOnce(chain);
  return chain;
}

/** The SQL the audience query's predicate renders to. */
function renderedPredicate(chain: { where: { mock: { calls: unknown[][] } } }): {
  sql: string;
  params: unknown[];
} {
  const where = chain.where.mock.calls[0]?.[0];
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  return { sql, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  readConsentMap.mockResolvedValue({ nearby_notifications: true });
  readPushSubscriptions.mockResolvedValue([
    {
      id: 'sub-1',
      businessId: 'biz-1',
      customerId: 'cust-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: 'public-key',
      auth: 'auth-secret',
      userAgent: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: null,
    },
  ]);
  deliverPushNotification.mockResolvedValue({
    delivered: 1,
    failed: 0,
    removed: 0,
    subscriptions: 1,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveCampaignAudience', () => {
  it('resolves the customers who interacted at the branch, as global ids', async () => {
    const chain = audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);

    const members = await resolveCampaignAudience(dbMock, 'biz-1', { branch_id: 'branch-1' });

    // The delivery resolves a customer by the global id; the event table holds
    // the internal one. The resolution has to hand over the global one.
    expect(members).toEqual([{ customerId: 'cust-1', globalId: 'global-1' }]);

    const { sql, params } = renderedPredicate(chain as never);
    // Scoped to the tenant, to the branch, and to the recency window.
    expect(sql).toContain('business_id');
    expect(sql).toContain('branch_id');
    expect(sql).toContain('created_at');
    expect(params).toContain('biz-1');
    expect(params).toContain('branch-1');
  });

  it('applies a hundred and eighty day interaction window', async () => {
    expect(INTERACTION_WINDOW_DAYS).toBe(180);

    const chain = audienceRows([]);

    await resolveCampaignAudience(dbMock, 'biz-1', { branch_id: 'branch-1' });

    const { params } = renderedPredicate(chain as never);
    // The dialect binds a timestamp as an ISO string.
    const since = params.find(
      (param) => typeof param === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(param),
    ) as string | undefined;

    expect(since).toBeDefined();
    const daysAgo = (Date.now() - new Date(since as string).getTime()) / (24 * 60 * 60 * 1000);
    // A hundred and eighty days, give or take the time the test itself takes to run.
    expect(daysAgo).toBeGreaterThan(179.9);
    expect(daysAgo).toBeLessThan(180.1);
  });

  it('leaves deleted customers out of the audience, so neither channel reaches them', async () => {
    // Deleting an account is an `UPDATE` of `deleted_at`, and the interaction
    // rows survive it, so without this predicate a deleted customer stays in the
    // audience for the whole window. The browser channel refuses them further
    // down, but the wallet channel reads the pass row directly, and a pass whose
    // expiry failed is still `issued` — so the audience is where they leave.
    const chain = audienceRows([]);

    await resolveCampaignAudience(dbMock, 'biz-1', { branch_id: 'branch-1' });

    const { sql } = renderedPredicate(chain as never);
    expect(sql).toContain('"customers"."deleted_at" is null');
  });

  it('counts a customer who interacted at two branches of the campaign once', async () => {
    audienceRows([
      { customerId: 'cust-1', globalId: 'global-1' },
      { customerId: 'cust-1', globalId: 'global-1' },
    ]);

    const members = await resolveCampaignAudience(dbMock, 'biz-1', { branch_id: 'branch-1' });

    expect(members).toHaveLength(1);
  });

  it('resolves the branches of a radius target before the audience', async () => {
    // The first read is the proximity query: it answers with the branches
    // inside the radius. The second is the audience query, scoped to them.
    const branchChain = createQueryChain([
      {
        id: 'branch-1',
        name: 'Near',
        businessId: 'biz-1',
        latitude: '-12.0500',
        longitude: '-77.0400',
      },
      {
        id: 'branch-2',
        name: 'Also near',
        businessId: 'biz-1',
        latitude: '-12.0550',
        longitude: '-77.0450',
      },
    ]);
    dbMock.select.mockReturnValueOnce(branchChain);
    const audienceChain = audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);

    const members = await resolveCampaignAudience(dbMock, 'biz-1', {
      latitude: -12.05,
      longitude: -77.04,
      radius_m: 1500,
    });

    expect(members).toHaveLength(1);

    const { params } = renderedPredicate(audienceChain as never);
    // Both resolved branches are in the audience query, and no other.
    expect(params).toContain('branch-1');
    expect(params).toContain('branch-2');
  });
});

describe('handlePushCampaignRequested', () => {
  const payload = {
    business_id: 'biz-1',
    title: 'Coffee',
    body: 'Two for one today',
    reference_id: 'campaign-7',
    target: { branch_id: 'branch-1' },
  };

  it('delivers to the audience and counts it', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows();

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.audience).toBe(1);
    expect(outcome.web_push.delivered).toBe(1);
    expect(outcome.web_push.failed).toBe(0);
    expect(outcome.web_push.skipped).toBe(0);
    expect(outcome.wallet.skipped).toBe(1); // no wallet pass in test
  });

  it('skips a target without the nearby-notification consent', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows();
    readConsentMap.mockResolvedValue({ whatsapp: true });

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.audience).toBe(1);
    expect(outcome.web_push.skipped).toBe(1);
    expect(outcome.wallet.skipped).toBe(1);
    expect(outcome.web_push.delivered).toBe(0);
    expect(deliverPushNotification).not.toHaveBeenCalled();
  });

  it('skips a target with no browser registered', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows();
    readPushSubscriptions.mockResolvedValue([]);

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.web_push.skipped).toBe(1);
    expect(outcome.web_push.delivered).toBe(0);
    expect(deliverPushNotification).not.toHaveBeenCalled();
  });

  it('delivers through the existing push delivery, by global id', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows();

    await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(deliverPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: 'global-1',
        business_id: 'biz-1',
        title: 'Coffee',
        body: 'Two for one today',
      }),
      'biz-1',
      mockEnv,
    );
  });

  it('names the campaign and the subscription in the message reference', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows();

    await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    // The campaign's own reference, unsuffixed: the delivery appends each
    // browser's subscription id, which makes `<campaign>:<subscription>`.
    // Suffixing it here as well would store `campaign-7:sub-1:sub-1`.
    const [delivered] = deliverPushNotification.mock.calls[0] as [Record<string, unknown>];
    expect(delivered.reference_id).toBe('campaign-7');
  });

  it('notifies the wallet pass of a customer who holds one', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows([{ objectId: 'issuer.member-1' }]);
    walletFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.wallet).toEqual({ delivered: 1, failed: 0, skipped: 0 });
    expect(outcome.web_push.delivered).toBe(1);
  });

  it('addresses the wallet notification by global id and campaign reference', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows([{ objectId: 'issuer.member-1' }]);
    walletFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });

    await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    const [url, init] = walletFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://wallet.internal/v1/wallet/push-notifications');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Business-Id': 'biz-1',
      'X-User-Role': 'service',
    });
    // The wallet worker resolves the pass by the customer the campaign knows,
    // and the offer id is the campaign's own reference.
    expect(JSON.parse(String(init.body))).toEqual({
      customer_id: 'global-1',
      notifications: [{ title: 'Coffee', body: 'Two for one today', offerId: 'campaign-7' }],
    });
  });

  it('counts a pass the wallet service no longer knows as skipped, not failed', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows([{ objectId: 'issuer.member-1' }]);
    // The default mock answers 409 PASS_NOT_ISSUED: the tracking row exists
    // here, the pass does not — the race the 409 exists for.

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.wallet).toEqual({ delivered: 0, failed: 0, skipped: 1 });
    expect(outcome.web_push.delivered).toBe(1);
  });

  it('counts a wallet failure without failing the web push channel', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows([{ objectId: 'issuer.member-1' }]);
    walletFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    expect(outcome.wallet).toEqual({ delivered: 0, failed: 1, skipped: 0 });
    expect(outcome.web_push.delivered).toBe(1);
    expect(outcome.web_push.failed).toBe(0);
  });

  it('delivers the wallet notification even with no browser registered', async () => {
    audienceRows([{ customerId: 'cust-1', globalId: 'global-1' }]);
    walletPassRows([{ objectId: 'issuer.member-1' }]);
    walletFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => '' });
    readPushSubscriptions.mockResolvedValue([]);

    const outcome = await handlePushCampaignRequested(payload, 'biz-1', mockEnv);

    // The two channels are independent: the browser is one delivery path and
    // the wallet is another, so a customer with only the wallet is reachable.
    expect(outcome.web_push.skipped).toBe(1);
    expect(outcome.wallet.delivered).toBe(1);
  });
});

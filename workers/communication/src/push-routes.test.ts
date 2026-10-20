import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

function createQueryChain<T>(resolveValue: T) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    orderBy: () => chain,
    offset: () => chain,
    select: () => chain,
    values: () => chain,
    set: () => chain,
    returning: vi.fn().mockResolvedValue(
      Array.isArray(resolveValue) ? resolveValue : [resolveValue],
    ),
    then: (onfulfilled: (v: any) => unknown) =>
      Promise.resolve(resolveValue).then(onfulfilled),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return chain;
}

const dbMock: any = {
  insert: vi.fn(() => createQueryChain({ id: 'mock-id' })),
  select: vi.fn(() => createQueryChain([])),
  update: vi.fn(() => createQueryChain([])),
  delete: vi.fn(() => createQueryChain([])),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', () => ({
  createDb: vi.fn(() => dbMock),
  setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
  customers: { id: 'id', businessId: 'business_id', globalId: 'global_id' },
  // The consent store and the subscription store are the authoritative
  // records, so the mock is what decides whether a browser may be registered
  // and what was written.
  readConsentMap: vi.fn(async () => ({ nearby_notifications: true })),
  readPushSubscriptions: vi.fn(async () => []),
  upsertPushSubscription: vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'sub-1',
    businessId: input.businessId,
    customerId: input.customerId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  })),
  deletePushSubscription: vi.fn(async () => true),
  hashPushEndpoint: vi.fn(async (endpoint: string) => `hash:${endpoint.length}`),
}));

const { readConsentMap, readPushSubscriptions, upsertPushSubscription, deletePushSubscription } =
  (await import('@vyloop/db')) as unknown as {
    readConsentMap: ReturnType<typeof vi.fn>;
    readPushSubscriptions: ReturnType<typeof vi.fn>;
    upsertPushSubscription: ReturnType<typeof vi.fn>;
    deletePushSubscription: ReturnType<typeof vi.fn>;
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
};

function customerHeaders(): Record<string, string> {
  return {
    'X-User-Id': 'global-1',
    'X-Business-Id': 'biz-1',
    'X-User-Role': 'customer',
  };
}

function operatorHeaders(): Record<string, string> {
  return {
    'X-User-Id': 'user-1',
    'X-Business-Id': 'biz-1',
    'X-User-Role': 'admin',
  };
}

function mockFetch(opts: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Response> {
  const url = `http://localhost${opts.path}`;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  return import('./push-routes').then(({ default: router }) =>
    router.fetch(new Request(url, init), mockEnv),
  );
}

const VALID_SUBSCRIPTION = {
  subscription: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'public-key', auth: 'auth-secret' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // The customer the token names.
  dbMock.select.mockReturnValue(createQueryChain([{ id: 'cust-1' }]));
  readConsentMap.mockResolvedValue({ nearby_notifications: true });
  readPushSubscriptions.mockResolvedValue([]);
  upsertPushSubscription.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'sub-1',
    businessId: input.businessId,
    customerId: input.customerId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: input.userAgent ?? null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  }));
  deletePushSubscription.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/communication/push/subscribe', () => {
  it('registers the browser', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: VALID_SUBSCRIPTION,
    });

    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.subscription.id).toBe('sub-1');

    // And it was written against the customer the token names.
    expect(upsertPushSubscription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: 'biz-1',
        customerId: 'cust-1',
        endpoint: VALID_SUBSCRIPTION.subscription.endpoint,
        p256dh: 'public-key',
        auth: 'auth-secret',
      }),
    );
  });

  it('never echoes the endpoint or the keys', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: VALID_SUBSCRIPTION,
    });

    const raw = JSON.stringify(await res.json());
    // The endpoint is a capability: anyone holding it can push to that
    // browser. The keys are the browser's own material.
    expect(raw).not.toContain(VALID_SUBSCRIPTION.subscription.endpoint);
    expect(raw).not.toContain('public-key');
    expect(raw).not.toContain('auth-secret');
  });

  it('refuses a customer who has not consented to nearby notifications', async () => {
    readConsentMap.mockResolvedValue({});

    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: VALID_SUBSCRIPTION,
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('CONSENT_REQUIRED');
    // And nothing was written.
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  it('refuses a customer whose consent was withdrawn', async () => {
    readConsentMap.mockResolvedValue({ nearby_notifications: false });

    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: VALID_SUBSCRIPTION,
    });

    expect(res.status).toBe(403);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  it('refuses an operator', async () => {
    // An operator registering a browser on a customer's behalf is a business
    // holding a channel to a browser its customer never offered.
    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: operatorHeaders(),
      body: VALID_SUBSCRIPTION,
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('CUSTOMER_TOKEN_REQUIRED');
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  it('refuses a subscription that is missing its keys', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: { subscription: { endpoint: 'https://example.test/send/1' } },
    });

    expect(res.status).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/subscribe',
      method: 'POST',
      headers: customerHeaders(),
    });

    expect(res.status).toBe(400);
    expect(upsertPushSubscription).not.toHaveBeenCalled();
  });
});

describe('POST /v1/communication/push/unsubscribe', () => {
  it('removes the browser', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/unsubscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' },
    });

    expect(res.status).toBe(200);
    expect(deletePushSubscription).toHaveBeenCalledWith(expect.anything(), {
      businessId: 'biz-1',
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    });
  });

  it('answers 404 when there was nothing to remove', async () => {
    deletePushSubscription.mockResolvedValue(false);

    const res = await mockFetch({
      path: '/v1/communication/push/unsubscribe',
      method: 'POST',
      headers: customerHeaders(),
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123' },
    });

    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });
});

describe('GET /v1/communication/push/subscriptions', () => {
  it('lists the browsers with a digest of the endpoint, never the endpoint', async () => {
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

    const res = await mockFetch({
      path: '/v1/communication/push/subscriptions',
      headers: customerHeaders(),
    });

    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('https://fcm.googleapis.com/fcm/send/abc123');
    expect(raw).not.toContain('public-key');
    expect(raw).not.toContain('auth-secret');
  });

  it('scopes the list to the customer the token names', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/subscriptions',
      headers: customerHeaders(),
    });

    expect(res.status).toBe(200);
    expect(readPushSubscriptions).toHaveBeenCalledWith(expect.anything(), {
      businessId: 'biz-1',
      customerId: 'cust-1',
    });
  });
});

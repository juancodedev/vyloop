import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const dbMock: any = {
  select: vi.fn(),
  insert: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', async () => {
  // The table is real so that the duplicate probe renders into the SQL a
  // reader can check: the prefix it looks for is the rule, not an
  // implementation detail of it.
  const { pgTable, uuid, jsonb } = await import('drizzle-orm/pg-core');
  const messageLogTable = pgTable('message_log', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    content: jsonb('content'),
  });

  return {
    createDb: vi.fn(() => dbMock),
    setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
    messageLog: messageLogTable,
  };
});

vi.mock('@vyloop/event-bus', () => ({
  publish: vi.fn(),
  createEnvelope: vi.fn((type, header, payload) => ({
    id: '00000000-0000-0000-0000-000000000000',
    type,
    source: 'vyloop.gateway',
    specversion: '1.0',
    time: new Date().toISOString(),
    header,
    payload,
  })),
  PUSH_CAMPAIGN_REQUESTED: 'PushCampaignRequested',
}));

vi.mock('./push-campaigns', () => ({
  resolveCampaignAudience: vi.fn(async () => [
    { customerId: 'cust-1', globalId: 'global-1' },
    { customerId: 'cust-2', globalId: 'global-2' },
  ]),
}));

const { publish } = (await import('@vyloop/event-bus')) as unknown as {
  publish: ReturnType<typeof vi.fn>;
};

const { resolveCampaignAudience } = (await import('./push-campaigns')) as unknown as {
  resolveCampaignAudience: ReturnType<typeof vi.fn>;
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

function operatorHeaders(): Record<string, string> {
  return { 'X-User-Id': 'user-1', 'X-Business-Id': 'biz-1', 'X-User-Role': 'admin' };
}

function customerHeaders(): Record<string, string> {
  return { 'X-User-Id': 'global-1', 'X-Business-Id': 'biz-1', 'X-User-Role': 'customer' };
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
  return import('./campaign-routes').then(({ default: router }) =>
    router.fetch(new Request(url, init), mockEnv),
  );
}

/** A chainable stand-in for a Drizzle query, resolving to `rows`. */
function createQueryChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (onfulfilled: (value: unknown) => unknown) =>
    Promise.resolve(rows).then(onfulfilled);
  return chain;
}

/** The SQL the duplicate probe rendered, and the values it bound. */
function renderedDuplicateProbe(): { sql: string; params: unknown[] } {
  const chain = dbMock.select.mock.results[0]?.value as {
    where: { mock: { calls: unknown[][] } };
  };
  const where = chain.where.mock.calls[0]?.[0];
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  return { sql, params };
}

const VALID_BRANCH_BODY = {
  target: { branch_id: '11111111-1111-4111-8111-111111111111' },
  title: 'Coffee',
  body: 'Two for one today',
};

const VALID_RADIUS_BODY = {
  target: { latitude: -12.05, longitude: -77.04, radius_m: 1500 },
  title: 'Coffee',
  body: 'Two for one today',
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  dbMock.select.mockImplementation(() => createQueryChain([]));
  resolveCampaignAudience.mockResolvedValue([
    { customerId: 'cust-1', globalId: 'global-1' },
    { customerId: 'cust-2', globalId: 'global-2' },
  ]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/communication/push/campaigns', () => {
  it('accepts a branch target, resolves the audience and publishes the campaign', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: { ...VALID_BRANCH_BODY, reference_id: 'campaign-7' },
    });

    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(body.reference_id).toBe('campaign-7');
    // The audience is resolved on the server. The caller never names a
    // customer, so the count is the only thing it learns about them.
    expect(body.audience_size).toBe(2);
    expect(resolveCampaignAudience).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1',
      VALID_BRANCH_BODY.target,
    );
    // And the campaign is an event, published to the delivery queue.
    expect(publish).toHaveBeenCalledTimes(1);
    const [queue, event] = publish.mock.calls[0] as [unknown, { type: string; payload: any }];
    expect(queue).toBe(mockEnv.DELIVERY_QUEUE);
    expect(event.type).toBe('PushCampaignRequested');
    expect(event.payload).toMatchObject({
      business_id: 'biz-1',
      title: 'Coffee',
      body: 'Two for one today',
      reference_id: 'campaign-7',
    });
  });

  it('accepts a radius target', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: VALID_RADIUS_BODY,
    });

    expect(res.status).toBe(202);
    expect(resolveCampaignAudience).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1',
      VALID_RADIUS_BODY.target,
    );
  });

  it('refuses a customer', async () => {
    // A customer does not compose campaigns.
    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: customerHeaders(),
      body: VALID_BRANCH_BODY,
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'both target forms at once',
      body: {
        ...VALID_BRANCH_BODY,
        target: { ...VALID_BRANCH_BODY.target, ...VALID_RADIUS_BODY.target },
      },
    },
    { label: 'no target at all', body: { title: 'Coffee', body: 'Two for one today' } },
    { label: 'an empty target', body: { ...VALID_BRANCH_BODY, target: {} } },
    {
      label: 'a radius without a radius',
      body: { ...VALID_RADIUS_BODY, target: { latitude: -12.05, longitude: -77.04 } },
    },
    {
      label: 'a radius of zero',
      body: { ...VALID_RADIUS_BODY, target: { ...VALID_RADIUS_BODY.target, radius_m: 0 } },
    },
    {
      label: 'a radius that is not an integer',
      body: { ...VALID_RADIUS_BODY, target: { ...VALID_RADIUS_BODY.target, radius_m: 1500.5 } },
    },
    {
      label: 'a radius beyond the cap',
      body: { ...VALID_RADIUS_BODY, target: { ...VALID_RADIUS_BODY.target, radius_m: 50_001 } },
    },
    {
      label: 'a branch that is not a uuid',
      body: { ...VALID_BRANCH_BODY, target: { branch_id: 'not-a-uuid' } },
    },
    { label: 'no title', body: { ...VALID_BRANCH_BODY, title: '' } },
    { label: 'no body', body: { ...VALID_BRANCH_BODY, body: '' } },
  ])('answers 422 and publishes nothing when the request has $label', async ({ body }) => {
    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body,
    });

    expect(res.status).toBe(422);
    const json: any = await res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a campaign that was already composed with the same reference', async () => {
    // The rows of one campaign share the prefix `<reference id>:`, so the
    // campaign's own rows are the evidence that it was already composed.
    dbMock.select.mockImplementation(() => createQueryChain([{ id: 'log-1' }]));

    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: { ...VALID_BRANCH_BODY, reference_id: 'campaign-7' },
    });

    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.error.code).toBe('DUPLICATE_MESSAGE');
    expect(publish).not.toHaveBeenCalled();

    // And the probe looked for the campaign's rows by their prefix, and for
    // nothing else.
    const { sql, params } = renderedDuplicateProbe();
    expect(sql).toContain('reference_id');
    expect(params).toContain('campaign-7:');
  });

  it('compares the reference literally, so `_` and `%` are not wildcards', async () => {
    // As a `LIKE` pattern, `promo_2026` would match the rows of `promo-2026`
    // and refuse a campaign that was never sent.
    dbMock.select.mockImplementation(() => createQueryChain([{ id: 'log-1' }]));

    await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: { ...VALID_BRANCH_BODY, reference_id: 'promo_2026%' },
    });

    const { sql, params } = renderedDuplicateProbe();
    expect(sql).not.toContain('like');
    expect(sql).not.toContain('LIKE');
    expect(params).toContain('promo_2026%:');
  });

  it('compares the prefix without measuring it, so a reference with an emoji still matches', async () => {
    // `left(text, n)` counts characters and a JavaScript length counts UTF-16
    // units: for an emoji the two disagree and the probe never matches.
    dbMock.select.mockImplementation(() => createQueryChain([{ id: 'log-1' }]));

    await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: { ...VALID_BRANCH_BODY, reference_id: 'promo-☕🎉' },
    });

    const { sql, params } = renderedDuplicateProbe();
    expect(sql).toContain('starts_with');
    expect(sql).not.toContain('left(');
    expect(params).toContain('promo-☕🎉:');
    expect(params).not.toContain('promo-☕🎉'.length + 1);
  });

  it('gives a campaign with no reference of its own one', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/campaigns',
      method: 'POST',
      headers: operatorHeaders(),
      body: VALID_BRANCH_BODY,
    });

    expect(res.status).toBe(202);
    const body: any = await res.json();
    expect(typeof body.reference_id).toBe('string');
    expect(body.reference_id.length).toBeGreaterThan(0);
  });
});

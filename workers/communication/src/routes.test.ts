import type { Queue, KVNamespace } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock query chain builder
// ---------------------------------------------------------------------------

function createQueryChain<T>(resolveValue: T) {
  const chain = {
    from: () => chain,
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: () => chain,
    orderBy: () => chain,
    offset: () => chain,
    select: () => chain,
    values: () => chain,
    set: () => chain,
    returning: vi
      .fn()
      .mockResolvedValue(Array.isArray(resolveValue) ? resolveValue : [resolveValue]),
    then: (onfulfilled: (v: any) => unknown) => Promise.resolve(resolveValue).then(onfulfilled),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return chain;
}

/** The SQL the history route's predicate renders to, and the values it binds. */
function renderedHistoryPredicate(): { sql: string; params: unknown[] } {
  const chain = dbMock.select.mock.results[0]?.value as {
    where: { mock: { calls: unknown[][] } };
  };
  const where = chain.where.mock.calls[0]?.[0];
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  return { sql, params };
}

// ---------------------------------------------------------------------------
// DB Mock — include setCurrentBusinessId used by withRls
// ---------------------------------------------------------------------------

/** The mocked consent store, so a test can decide what the customer agreed to. */
const { readConsentMap } = (await import('@vyloop/db')) as unknown as {
  readConsentMap: ReturnType<typeof vi.fn>;
};

const dbMock: any = {
  insert: vi.fn(() => createQueryChain({ id: 'mock-id' })),
  select: vi.fn(() => createQueryChain([])),
  update: vi.fn(() => createQueryChain([])),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', async () => {
  // The message log is a real table here, because the route's filters are
  // what this file checks: a flat `{}` renders an opaque predicate, so a query
  // that ignored the channel would look the same as one that honoured it.
  const { pgTable, uuid, text, timestamp, jsonb } = await import('drizzle-orm/pg-core');

  const messageLogTable = pgTable('message_log', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    direction: text('direction').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    pushEndpointHash: text('push_endpoint_hash'),
    content: jsonb('content'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull(),
  });

  return {
    createDb: vi.fn(() => dbMock),
    setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
    // The authoritative consent store. The route reads the customer's consents
    // from here, so the mock is what decides whether a message may be sent.
    readConsentMap: vi.fn(async () => ({ whatsapp: true })),
    messageLog: messageLogTable,
    whatsappTemplates: 'whatsapp_templates',
    // Real columns, so the history's join to the customer renders to SQL.
    customers: pgTable('customers', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      fullName: text('full_name'),
    }),
  };
});

vi.mock('@vyloop/event-bus', () => ({
  publish: vi.fn(),
  createEnvelope: vi.fn((type, header, payload) => ({
    id: 'mock-event-id',
    type,
    header,
    payload,
    source: 'test',
    specversion: '1.0',
    time: new Date().toISOString(),
  })),
  WHATSAPP_OUTBOUND_REQUESTED: 'WhatsAppOutboundRequested',
}));

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

function authHeaders(): Record<string, string> {
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
  return import('./routes').then(({ default: router }) =>
    router.fetch(new Request(url, init), mockEnv),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReturnValue(createQueryChain([]));
  dbMock.insert.mockReturnValue(createQueryChain({ id: 'mock-id' }));
  dbMock.update.mockReturnValue(createQueryChain([]));
  dbMock.execute.mockResolvedValue({ rows: [] });
});

// ============================================================================
// POST /v1/communication/send
// ============================================================================

describe('POST /v1/communication/send', () => {
  it('rejects missing customer_id and template_name with 400', async () => {
    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: {},
    });

    expect(res.status).toBe(400);
    const body: any = await res.json();
    expect(body.error.message).toContain('required');
  });

  it('rejects 403 if customer has no WhatsApp consent', async () => {
    dbMock.select.mockReturnValue(createQueryChain([{ id: 'cust-1', phone: '56912345678' }]));
    readConsentMap.mockResolvedValueOnce({});

    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { customer_id: 'cust-1', template_name: 'welcome' },
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.message).toContain('consent');
  });

  it('rejects 403 if the WhatsApp consent was withdrawn', async () => {
    // A withdrawn consent is not a granted one. The store says so with
    // `granted = false`, and the gate has to honour that rather than treating
    // "a row exists" as consent.
    dbMock.select.mockReturnValue(createQueryChain([{ id: 'cust-1', phone: '56912345678' }]));
    readConsentMap.mockResolvedValueOnce({ whatsapp: false });

    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { customer_id: 'cust-1', template_name: 'welcome' },
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('CONSENT_REQUIRED');
  });

  it('returns 202 on valid send request', async () => {
    dbMock.select
      .mockReturnValueOnce(createQueryChain([{ id: 'cust-1', phone: '56912345678' }]))
      .mockReturnValueOnce(createQueryChain([]));
    dbMock.insert.mockReturnValue(
      createQueryChain([
        { id: 'msg-1', status: 'queued', businessId: 'biz-1', customerId: 'cust-1' },
      ]),
    );

    const res = await mockFetch({
      path: '/v1/communication/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { customer_id: 'cust-1', template_name: 'welcome' },
    });

    expect(res.status).toBe(202);
  });
});

// ============================================================================
// GET /v1/communication/templates
// ============================================================================

describe('GET /v1/communication/templates', () => {
  it('returns empty list', async () => {
    dbMock.select
      .mockReturnValueOnce(createQueryChain([{ total: 0 }]))
      .mockReturnValueOnce(createQueryChain([]));

    const res = await mockFetch({
      path: '/v1/communication/templates',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ============================================================================
// POST /v1/communication/templates
// ============================================================================

describe('POST /v1/communication/templates', () => {
  it('creates template with valid input', async () => {
    dbMock.insert.mockReturnValue(
      createQueryChain([
        {
          id: 'tpl-1',
          name: 'test',
          language: 'es',
          category: 'utility',
          body: 'test body',
          status: 'pending',
        },
      ]),
    );

    const res = await mockFetch({
      path: '/v1/communication/templates',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { name: 'test', language: 'es', category: 'utility', body: 'test body' },
    });

    expect(res.status).toBe(201);
  });

  it('rejects missing fields with 400', async () => {
    const res = await mockFetch({
      path: '/v1/communication/templates',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: { name: 'test' },
    });

    expect(res.status).toBe(400);
  });
});

// ============================================================================
// GET /v1/communication/history
// ============================================================================

describe('GET /v1/communication/history', () => {
  it('returns empty list', async () => {
    (dbMock.select as any)
      .mockReturnValueOnce(createQueryChain([{ total: 0 }]))
      .mockReturnValueOnce(createQueryChain([]));

    const res = await mockFetch({
      path: '/v1/communication/history',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data).toEqual([]);
  });

  it('returns the deliveries of every channel when no channel is named', async () => {
    // A push delivery is a delivery. The history used to filter on the
    // WhatsApp channel in hardcode, which made every push delivery invisible
    // in it — and a delivery nobody can see is a delivery that did not happen.
    const res = await mockFetch({
      path: '/v1/communication/history',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);

    const { sql } = renderedHistoryPredicate();
    expect(sql).not.toContain('channel');
  });

  it('filters by channel when one is named', async () => {
    const res = await mockFetch({
      path: '/v1/communication/history?channel=push',
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);

    const { sql, params } = renderedHistoryPredicate();
    expect(sql).toContain('channel');
    expect(params).toContain('push');
  });

  it('names the customer of each delivery, from the same business only', async () => {
    // The page used to print a slice of the customer's UUID, because the rows
    // carried nothing else to print.
    await mockFetch({ path: '/v1/communication/history', headers: authHeaders() });

    const rowsQuery = dbMock.select.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(Object.keys(rowsQuery)).toContain('customerName');

    const chain = dbMock.select.mock.results[1]?.value as {
      leftJoin: { mock: { calls: unknown[][] } };
    };
    const [, on] = chain.leftJoin.mock.calls[0] ?? [];
    const { sql } = new PgDialect().sqlToQuery(on as SQL);
    expect(sql).toContain('"customers"."id" = "message_log"."customer_id"');
    expect(sql).toContain('"customers"."business_id" = "message_log"."business_id"');
  });

  it('still filters by customer and by status', async () => {
    // The other filters share the predicate the channel filter now lives in,
    // so they are pinned here.
    await mockFetch({
      path: '/v1/communication/history?customer_id=cust-1&status=sent',
      headers: authHeaders(),
    });

    const { sql, params } = renderedHistoryPredicate();
    expect(sql).toContain('customer_id');
    expect(sql).toContain('status');
    expect(params).toContain('cust-1');
    expect(params).toContain('sent');
  });
});

// ============================================================================
// GET /webhook — Meta verification
// ============================================================================

describe('GET /webhook — Meta verification', () => {
  it('returns challenge when verify_token matches', async () => {
    const res = await mockFetch({
      path: '/webhook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=12345',
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('12345');
  });

  it('returns 403 when verify_token does not match', async () => {
    const res = await mockFetch({
      path: '/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=12345',
    });

    expect(res.status).toBe(403);
  });
});

// ============================================================================
// POST /webhook — Meta callbacks
// ============================================================================

describe('POST /webhook — Meta callbacks', () => {
  it('returns 200 OK on empty webhook payload', async () => {
    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });

    expect(res.status).toBe(200);
  });

  it('returns 200 on status callback and updates message status', async () => {
    (dbMock.select as any).mockReturnValue(
      createQueryChain([{ id: 'cust-1', businessId: 'biz-1' }]),
    );

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [
          {
            changes: [
              {
            value: {
              metadata: { phone_number_id: '123' },
                  statuses: [
                    {
                id: 'wamid-abc123',
                status: 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
            },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalled();
  });

  it('returns 200 on inbound message and inserts it', async () => {
    (dbMock.select as any).mockReturnValue(
      createQueryChain([{ id: 'cust-1', businessId: 'biz-1' }]),
    );

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [
          {
            changes: [
              {
            value: {
              metadata: { phone_number_id: '123' },
                  messages: [
                    {
                from: '56912345678',
                id: 'wamid-incoming',
                text: { body: 'Hello!' },
                type: 'text',
                timestamp: String(Math.floor(Date.now() / 1000)),
            },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(dbMock.insert).toHaveBeenCalled();
  });

  it('skips inbound message from unknown phone', async () => {
    // No customer found for this phone
    dbMock.select.mockReturnValue(createQueryChain([]));

    const res = await mockFetch({
      path: '/webhook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        entry: [
          {
            changes: [
              {
            value: {
              metadata: { phone_number_id: '123' },
                  messages: [
                    {
                from: '56999999999',
                id: 'wamid-unknown',
                text: { body: 'Who dis?' },
                type: 'text',
                timestamp: String(Math.floor(Date.now() / 1000)),
            },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    // Should NOT have inserted because customer not found
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});

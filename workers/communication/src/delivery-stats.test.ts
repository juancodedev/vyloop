import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const dbMock: any = {
  select: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  // The tenant transaction hands the callback this same mock as its handle.
  transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(dbMock)),
};

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, text, timestamp, jsonb } = await import('drizzle-orm/pg-core');

  const messageLogTable = pgTable('message_log', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    pushEndpointHash: text('push_endpoint_hash'),
    content: jsonb('content'),
    createdAt: timestamp('created_at').notNull(),
  });

  // The real helper, so a test sees the `set_config` it really issues.
  const { withTenantTransaction } =
    await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');

  return {
    createDb: vi.fn(() => dbMock),
    setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
    withTenantTransaction,
    messageLog: messageLogTable,
  };
});

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
}): Promise<Response> {
  const url = `http://localhost${opts.path}`;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
  };
  return import('./delivery-stats').then(({ default: router }) =>
    router.fetch(new Request(url, init), mockEnv),
  );
}

/** A chainable stand-in for a Drizzle query, resolving to `rows`. */
function createQueryChain<T>(resolveValue: T) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.then = (onfulfilled: (value: unknown) => unknown) =>
    Promise.resolve(resolveValue).then(onfulfilled);
  chain.execute = vi.fn().mockResolvedValue({ rows: [] });
  return chain;
}

/** The SQL a predicate renders to, and the values it binds. */
function renderedPredicate(chain: unknown): { sql: string; params: unknown[] } {
  const where = (chain as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[0]?.[0];
  const { sql, params } = new PgDialect().sqlToQuery(where as SQL);
  return { sql, params };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();

  // The counts by status, the total, and the page of deliveries.
  dbMock.select
    .mockImplementationOnce(() =>
      createQueryChain([
        { status: 'queued', total: 2 },
        { status: 'sent', total: 5 },
        { status: 'failed', total: 1 },
      ]),
    )
    .mockImplementationOnce(() => createQueryChain([{ total: 8 }]))
    .mockImplementationOnce(() =>
      createQueryChain([
        { id: 'log-1', channel: 'push', status: 'sent', createdAt: new Date() },
        { id: 'log-2', channel: 'push', status: 'failed', createdAt: new Date() },
      ]),
    );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/communication/push/deliveries', () => {
  it('refuses a customer', async () => {
    // A customer is reached by the campaigns their business composes; a
    // customer does not read the delivery dashboard.
    const res = await mockFetch({
      path: '/v1/communication/push/deliveries',
      headers: customerHeaders(),
    });

    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error.code).toBe('OPERATOR_ROLE_REQUIRED');
  });

  it('returns the counts by status and the most recent deliveries', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/deliveries?page=2&per_page=5',
      headers: operatorHeaders(),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();

    // The counts, by status.
    expect(body.counts).toEqual({ queued: 2, sent: 5, failed: 1 });

    // The deliveries, and the pagination the history route uses.
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual({ total: 8, page: 2, per_page: 5 });

    // And the whole thing is about the push channel: a WhatsApp message is not
    // a push delivery.
    const { sql, params } = renderedPredicate(dbMock.select.mock.results[0]?.value);
    expect(sql).toContain('channel');
    expect(params).toContain('push');
  });

  it('never returns more than a hundred deliveries at a time', async () => {
    const res = await mockFetch({
      path: '/v1/communication/push/deliveries?per_page=1000',
      headers: operatorHeaders(),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.meta.per_page).toBe(100);
  });
});

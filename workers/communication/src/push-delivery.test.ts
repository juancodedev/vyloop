import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attemptDelivery, deliverPushNotification } from './push-delivery';

// ---------------------------------------------------------------------------
// Mock setup
//
// The delivery writes to three tables, so the mock has to know which write is
// which: a `message_log` row is the record of a delivery, a `push_subscriptions`
// row is the browser itself, and the two are not interchangeable. The tables are
// real so that a predicate renders into SQL a reader can check — a flat `{}`
// would make a query that ignored the tenant look the same as one that
// honoured it.
// ---------------------------------------------------------------------------

const dbMock: any = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, text, timestamp, jsonb } = await import('drizzle-orm/pg-core');

  const customersTable = pgTable('customers', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    globalId: uuid('global_id').notNull(),
    deletedAt: timestamp('deleted_at'),
  });

  const messageLogTable = pgTable('message_log', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    pushEndpointHash: text('push_endpoint_hash'),
    content: jsonb('content'),
    createdAt: timestamp('created_at'),
  });

  const pushSubscriptionsTable = pgTable('push_subscriptions', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    endpoint: text('endpoint').notNull(),
    lastSeenAt: timestamp('last_seen_at'),
    createdAt: timestamp('created_at').notNull(),
  });

  return {
    createDb: vi.fn(() => dbMock),
    setCurrentBusinessId: vi.fn(() => 'SELECT set_config(...)'),
    customers: customersTable,
    messageLog: messageLogTable,
    pushSubscriptions: pushSubscriptionsTable,
    hashPushEndpoint: vi.fn(async (endpoint: string) => `hash:${endpoint.length}`),
    readConsentMap: vi.fn(async () => ({ nearby_notifications: true })),
    readPushSubscriptions: vi.fn(async () => []),
    deletePushSubscriptionByEndpoint: vi.fn(async () => true),
  };
});

vi.mock('./push-encryption', () => ({
  encryptPushPayload: vi.fn(async () => ({
    body: new Uint8Array([1, 2, 3]),
    salt: new Uint8Array([4, 5]),
    applicationServerKey: new Uint8Array([6, 7]),
    recordSize: 4096,
  })),
  buildVapidAuthorization: vi.fn(async () => 'vapid t=token, k=key'),
}));

const { readConsentMap, readPushSubscriptions, pushSubscriptions: pushSubscriptionsTable } =
  (await import('@vyloop/db')) as unknown as {
    readConsentMap: ReturnType<typeof vi.fn>;
    readPushSubscriptions: ReturnType<typeof vi.fn>;
    pushSubscriptions: unknown;
  };

const { deletePushSubscriptionByEndpoint } = (await import('@vyloop/db')) as unknown as {
  deletePushSubscriptionByEndpoint: ReturnType<typeof vi.fn>;
};

const { messageLog: messageLogTable } = (await import('@vyloop/db')) as unknown as {
  messageLog: unknown;
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
};

const SUBSCRIPTION = {
  id: 'sub-1',
  businessId: 'biz-1',
  customerId: 'cust-1',
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  p256dh: 'public-key',
  auth: 'auth-secret',
  userAgent: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  lastSeenAt: null,
};

const PAYLOAD = {
  customer_id: 'global-1',
  business_id: 'biz-1',
  title: 'Coffee',
  body: 'Two for one today',
};

/** A chainable stand-in for a Drizzle query, resolving to `rows`. */
function createQueryChain<T>(resolveValue: T) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.offset = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.set = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.returning = vi
    .fn()
    .mockResolvedValue(Array.isArray(resolveValue) ? resolveValue : [resolveValue]);
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

/** The chain of the `update` that touched `table`, or `null`. */
function updateChainFor(table: unknown): {
  set: { mock: { calls: unknown[][] } };
  where: { mock: { calls: unknown[][] } };
} | null {
  const index = dbMock.update.mock.calls.findIndex((call: unknown[]) => call[0] === table);
  if (index === -1) return null;
  return dbMock.update.mock.results[index].value;
}

/** The row the delivery wrote to `message_log`. */
function insertedMessageLog(): Record<string, any> {
  const chain = dbMock.insert.mock.results[0]?.value;
  return (chain as { values: { mock: { calls: unknown[][] } } }).values.mock.calls[0]?.[0] as Record<
    string,
    any
  >;
}

function response(status: number): Response {
  return new Response(null, { status });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();

  dbMock.select.mockImplementation(() => createQueryChain([{ id: 'cust-1' }]));
  dbMock.insert.mockImplementation(() => createQueryChain([{ id: 'log-1' }]));
  dbMock.update.mockImplementation(() => createQueryChain([]));
  dbMock.delete.mockImplementation(() => createQueryChain([]));

  readConsentMap.mockResolvedValue({ nearby_notifications: true });
  readPushSubscriptions.mockResolvedValue([SUBSCRIPTION]);
});

// ---------------------------------------------------------------------------
// What the push service says, and what it means.
//
// The classification is the part that matters: a service that says "slow down"
// and one that says "this browser is gone" call for opposite things, and
// getting them backwards means either a message that is never retried or a
// subscription that is retried forever.
// ---------------------------------------------------------------------------

describe('attemptDelivery', () => {
  it('reports a delivery the service accepted', async () => {
    const fetcher = vi.fn(async () => response(201));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1, 2, 3]),
      { Authorization: 'vapid t=x, k=y' },
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'delivered' });
  });

  it('reports a registration the service no longer holds', async () => {
    const fetcher = vi.fn(async () => response(410));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'dead' });
  });

  it('reports a request to slow down as retryable', async () => {
    const fetcher = vi.fn(async () => response(429));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt).toEqual({ kind: 'retry' });
  });

  it('reports a rejected VAPID key as terminal', async () => {
    // No number of retries fixes a key that is wrong, so this must not be
    // retried — otherwise the queue retries a message that can never succeed.
    const fetcher = vi.fn(async () => response(401));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt.kind).toBe('terminal');
  });

  it('reports a rejected body as terminal', async () => {
    const fetcher = vi.fn(async () => response(400));

    const attempt = await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1]),
      {},
      fetcher as unknown as typeof fetch,
    );

    expect(attempt.kind).toBe('terminal');
  });

  it('sends the encryption headers the push service expects', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => response(201));

    await attemptDelivery(
      'https://fcm.googleapis.com/fcm/send/abc',
      new Uint8Array([1, 2, 3]),
      {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '3',
      },
      fetcher as unknown as typeof fetch,
    );

    const [, init] = fetcher.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Length']).toBe('3');
  });

  it('lets a network failure through, so the queue retries it', async () => {
    // A network error is not the service saying no, and it must not be
    // classified as one.
    const fetcher = vi.fn(async () => {
      throw new Error('connection reset');
    });

    await expect(
      attemptDelivery(
        'https://fcm.googleapis.com/fcm/send/abc',
        new Uint8Array([1]),
        {},
        fetcher as unknown as typeof fetch,
      ),
    ).rejects.toThrow('connection reset');
  });
});

// ---------------------------------------------------------------------------
// The delivery itself.
// ---------------------------------------------------------------------------

describe('deliverPushNotification', () => {
  it('does not reach a customer whose row has been soft-deleted', async () => {
    // Deleting a customer here is an `UPDATE` of `deleted_at`, so the row is
    // still there to be found. The delivery must not find it.
    const fetcher = vi.fn(async () => response(201));

    await deliverPushNotification(PAYLOAD, 'biz-1', mockEnv, fetcher as unknown as typeof fetch);

    const chain = dbMock.select.mock.results[0]?.value;
    const { sql } = renderedPredicate(chain);
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('is null');

    // And a customer that does not resolve is not reached: no attempt, no row.
    dbMock.select.mockImplementation(() => createQueryChain([]));
    dbMock.insert.mockClear();
    const unreachable = vi.fn(async () => response(201));

    const outcome = await deliverPushNotification(
      PAYLOAD,
      'biz-1',
      mockEnv,
      unreachable as unknown as typeof fetch,
    );

    expect(unreachable).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(outcome.delivered).toBe(0);
  });

  it('refreshes the last_seen_at of the subscription it delivered to', async () => {
    const fetcher = vi.fn(async () => response(201));

    await deliverPushNotification(PAYLOAD, 'biz-1', mockEnv, fetcher as unknown as typeof fetch);

    const update = updateChainFor(pushSubscriptionsTable);
    expect(update).not.toBeNull();

    const set = update!.set.mock.calls[0]?.[0] as { lastSeenAt: Date };
    expect(set.lastSeenAt).toBeInstanceOf(Date);

    // And it is now: the delivery is what proves the browser is still there.
    const age = Date.now() - set.lastSeenAt.getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);

    // And it is the subscription that was delivered to.
    const { params } = renderedPredicate(update);
    expect(params).toContain(SUBSCRIPTION.id);
  });

  it('refreshes the last_seen_at even when the delivery failed', async () => {
    // The browser answered: it was reachable enough to be told no. A
    // registration nobody has heard from is the one that gets pruned, and a
    // delivery that failed for a reason of ours does not make it unreachable.
    const fetcher = vi.fn(async () => response(400));

    await deliverPushNotification(PAYLOAD, 'biz-1', mockEnv, fetcher as unknown as typeof fetch);

    const update = updateChainFor(pushSubscriptionsTable);
    expect(update).not.toBeNull();
    const set = update!.set.mock.calls[0]?.[0] as { lastSeenAt: Date };
    expect(set.lastSeenAt).toBeInstanceOf(Date);
  });

  it('writes the producer reference scoped by the subscription', async () => {
    const fetcher = vi.fn(async () => response(201));

    await deliverPushNotification(
      { ...PAYLOAD, reference_id: 'campaign-7' },
      'biz-1',
      mockEnv,
      fetcher as unknown as typeof fetch,
    );

    const row = insertedMessageLog();
    expect(row.channel).toBe('push');
    // The campaign's own reference, and the subscription it was delivered to:
    // the two together name one delivery, and the campaign's reference alone
    // would be the same string for every browser a customer registered.
    expect(row.content.reference_id).toBe(`campaign-7:${SUBSCRIPTION.id}`);
  });

  it('writes the subscription as the reference when the producer named none', async () => {
    const fetcher = vi.fn(async () => response(201));

    await deliverPushNotification(PAYLOAD, 'biz-1', mockEnv, fetcher as unknown as typeof fetch);

    const row = insertedMessageLog();
    expect(row.content.reference_id).toBe(SUBSCRIPTION.id);
  });

  // -------------------------------------------------------------------------
  // What the delivery already did, and still does.
  // -------------------------------------------------------------------------

  it('does not deliver to a customer without the nearby-notification consent', async () => {
    // The consent is checked again at the moment of the delivery. A customer
    // who withdrew it after registering must stop receiving messages.
    readConsentMap.mockResolvedValue({ whatsapp: true });
    const fetcher = vi.fn(async () => response(201));

    const outcome = await deliverPushNotification(
      PAYLOAD,
      'biz-1',
      mockEnv,
      fetcher as unknown as typeof fetch,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(outcome.delivered).toBe(0);
  });

  it('removes a subscription the push service no longer holds', async () => {
    // The push service answered `410`: the registration is gone, and so is
    // the row, because every future message would otherwise pay for a
    // delivery that cannot happen.
    const fetcher = vi.fn(async () => response(410));

    const outcome = await deliverPushNotification(
      PAYLOAD,
      'biz-1',
      mockEnv,
      fetcher as unknown as typeof fetch,
    );

    expect(deletePushSubscriptionByEndpoint).toHaveBeenCalledWith(
      expect.anything(),
      SUBSCRIPTION.endpoint,
    );
    expect(outcome.removed).toBe(1);

    // And the row records the failure.
    const update = updateChainFor(messageLogTable);
    expect(update).not.toBeNull();
    expect(update!.set.mock.calls[0]?.[0]).toMatchObject({ status: 'failed' });
  });
});

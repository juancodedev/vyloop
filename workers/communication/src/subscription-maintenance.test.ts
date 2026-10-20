import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const dbMock: any = {
  select: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, text, timestamp } = await import('drizzle-orm/pg-core');

  const customersTable = pgTable('customers', {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    globalId: uuid('global_id').notNull(),
    deletedAt: timestamp('deleted_at'),
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
    pushSubscriptions: pushSubscriptionsTable,
  };
});

const { handleSubscriptionMaintenance, STALE_SUBSCRIPTION_DAYS, SWEEP_BATCH_SIZE } = (await import(
  './subscription-maintenance'
)) as unknown as {
  handleSubscriptionMaintenance: (env: unknown) => Promise<void>;
  STALE_SUBSCRIPTION_DAYS: number;
  SWEEP_BATCH_SIZE: number;
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

/** A chainable stand-in for a Drizzle query, resolving to `rows`. */
function createQueryChain<T>(resolveValue: T) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
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

/** The chain of the nth `delete`, in the order the sweep issued them. */
function deleteChain(index: number): {
  where: { mock: { calls: unknown[][] } };
  returning: { mock: { calls: unknown[][] } };
} {
  return dbMock.delete.mock.results[index].value;
}

/** The cutoff the sweep compared against, read out of the bound parameters. */
function boundCutoff(params: unknown[]): Date {
  const bound = params.find(
    (param) => param instanceof Date || (typeof param === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(param)),
  );
  return new Date(bound as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.select.mockReset();
  dbMock.delete.mockReset();

  // The first delete is the stale sweep, the second is the deleted-customer
  // sweep. Both answer with the rows they removed.
  dbMock.delete
    .mockImplementationOnce(() => createQueryChain([{ id: 'stale-1' }, { id: 'stale-2' }]))
    .mockImplementationOnce(() => createQueryChain([{ id: 'orphan-1' }]));
  dbMock.select.mockImplementation(() => createQueryChain([]));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSubscriptionMaintenance', () => {
  it('prunes the subscriptions nobody has seen for a long time', async () => {
    await handleSubscriptionMaintenance(mockEnv);

    const chain = deleteChain(0);
    const { sql, params } = renderedPredicate(chain);

    expect(sql).toContain('last_seen_at');
    expect(sql).toContain('created_at');
    expect(sql).toContain('is null');

    // And the window is the one the platform states, in days.
    expect(STALE_SUBSCRIPTION_DAYS).toBe(180);
    const cutoff = boundCutoff(params);
    const ageInDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageInDays).toBeGreaterThan(179.9);
    expect(ageInDays).toBeLessThan(180.1);
  });

  it('deletes at most one batch per step, so one run cannot hold a lock on the whole table', async () => {
    await handleSubscriptionMaintenance(mockEnv);

    expect(SWEEP_BATCH_SIZE).toBe(1000);
    for (const index of [0, 1]) {
      const { sql, params } = renderedPredicate(deleteChain(index));
      expect(sql).toMatch(/limit \$\d+/i);
      expect(params).toContain(SWEEP_BATCH_SIZE);
    }
  });

  it('prunes a subscription that was never seen but was created long ago', async () => {
    // A registration nobody has ever been delivered to is stale once it is
    // old enough, and only then: a recent subscription with no `last_seen_at`
    // has not had the chance to be seen yet.
    await handleSubscriptionMaintenance(mockEnv);

    const chain = deleteChain(0);
    const { sql } = renderedPredicate(chain);

    expect(sql).toMatch(/last_seen_at" is null/i);
    expect(sql).toMatch(/created_at" </i);
  });

  it('prunes the subscriptions of a customer that was deleted', async () => {
    await handleSubscriptionMaintenance(mockEnv);

    // The customer query is the one that finds the soft-deleted.
    const selectChain = dbMock.select.mock.results[0]?.value;
    const { sql } = renderedPredicate(selectChain);
    expect(sql).toContain('deleted_at');
    expect(sql).toContain('is not null');

    // And the delete removes the subscriptions of exactly those customers: the
    // predicate embeds the query that finds the soft-deleted.
    const chain = deleteChain(1);
    // The batch bound wraps the predicate, so the query is nested a level or
    // two down: look for it at any depth.
    const embeds = (node: any, seen = new Set<unknown>()): boolean => {
      if (node === selectChain || node?.value === selectChain) return true;
      if (!node || typeof node !== 'object' || seen.has(node)) return false;
      seen.add(node);
      return (node.queryChunks ?? []).some((chunk: unknown) => embeds(chunk, seen));
    };
    expect(embeds(chain.where.mock.calls[0]?.[0])).toBe(true);
  });

  it('never throws, and carries on after a failed sub-task', async () => {
    // A cron that throws has the whole invocation retried, so the sweep has to
    // survive a broken sub-task and finish the rest of its work.
    dbMock.delete
      .mockReset()
      .mockImplementationOnce(() => {
        throw new Error('the connection was lost');
      })
      .mockImplementationOnce(() => createQueryChain([{ id: 'orphan-1' }]));

    await expect(handleSubscriptionMaintenance(mockEnv)).resolves.toBeUndefined();

    // The second sweep still ran.
    expect(dbMock.delete).toHaveBeenCalledTimes(2);
  });

  it('reports the counts in one line', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await handleSubscriptionMaintenance(mockEnv);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('pruned_stale=2');
    expect(logged[0]).toContain('pruned_deleted_customer=1');
    expect(logged[0]).toContain('errors=0');
  });
});

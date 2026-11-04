import type { KVNamespace, Queue } from '@cloudflare/workers-types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

/**
 * Two handles, the way the sweep sees the database under row-level security.
 *
 * The outer `db` only enumerates `tenants`, which is exempt from RLS: it has no
 * `delete`, and a tenant query issued on it fails here the way it would fail in
 * Postgres, where the policy reads `current_setting(...)` with no default and
 * errors when nothing set it. The transaction handle `txMock` carries every
 * tenant query, and `txTenant` is what `set_config` last set on it, so each
 * query can record the tenant it ran for.
 */
const txMock: any = {
  select: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

/** The tenant the open transaction set, or `null` outside a transaction. */
let txTenant: string | null = null;

/** Every tenant query, with the tenant its transaction had set. */
const tenantQueries: Array<{ kind: 'select' | 'delete'; tenant: string | null }> = [];

/** What the next `delete` calls on the transaction answer, in order. */
let deleteResults: Array<() => unknown> = [];

/** The tenants the outer handle enumerates. */
let tenantRows: Array<{ id: string }> = [];

/** The `limit` and cursor of every page of `tenants`, in order. */
const tenantPages: Array<{ limit: unknown; where: unknown }> = [];

const dbMock: any = {
  select: vi.fn(),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    txTenant = null;
    try {
      return await fn(txMock);
    } finally {
      txTenant = null;
    }
  }),
  delete: vi.fn(() => {
    throw new Error('a tenant query reached the outer db instead of a tenant transaction');
  }),
  execute: vi.fn(() => {
    throw new Error('the outer db must not execute statements');
  }),
};

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, text, timestamp } = await import('drizzle-orm/pg-core');
  const actual = await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db');

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

  const tenantsTable = pgTable('tenants', {
    id: uuid('id').primaryKey(),
  });

  return {
    createDb: vi.fn(() => dbMock),
    withTenantTransaction: actual.withTenantTransaction,
    customers: customersTable,
    pushSubscriptions: pushSubscriptionsTable,
    tenants: tenantsTable,
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
  return txMock.delete.mock.results[index].value;
}

/** The cutoff the sweep compared against, read out of the bound parameters. */
function boundCutoff(params: unknown[]): Date {
  const bound = params.find(
    (param) => param instanceof Date || (typeof param === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(param)),
  );
  return new Date(bound as string);
}

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TENANT_C = '00000000-0000-4000-8000-00000000000c';

/** A keyset page of `tenants`: the rows after the cursor, up to the limit. */
function tenantPageChain() {
  const page: { limit: unknown; where: unknown } = { limit: undefined, where: undefined };
  tenantPages.push(page);
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn((clause: unknown) => {
    page.where = clause;
    return chain;
  });
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn((n: unknown) => {
    page.limit = n;
    return chain;
  });
  chain.then = (onfulfilled: (value: unknown) => unknown) => {
    const after =
      page.where === undefined
        ? null
        : (new PgDialect().sqlToQuery(page.where as SQL).params.find((p) => typeof p === 'string') as string);
    const rows = tenantRows
      .filter((row) => after === null || row.id > after)
      .slice(0, typeof page.limit === 'number' ? page.limit : undefined);
    return Promise.resolve(rows).then(onfulfilled);
  };
  return chain;
}

/** Captures the logged summary line and the error lines of one run. */
async function runCapturing(): Promise<{ logged: string[]; errored: string[] }> {
  const logged: string[] = [];
  const errored: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errored.push(args.map(String).join(' '));
  });
  try {
    await handleSubscriptionMaintenance(mockEnv);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { logged, errored };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.select.mockReset();
  txMock.delete.mockReset();
  txMock.execute.mockReset();
  dbMock.select.mockReset();
  tenantQueries.length = 0;
  tenantPages.length = 0;
  tenantRows = [{ id: TENANT_A }];

  // `set_config` on the transaction handle is what scopes it to a tenant.
  txMock.execute.mockImplementation(async (statement: SQL) => {
    const { sql, params } = new PgDialect().sqlToQuery(statement);
    if (sql.includes("set_config('app.current_business_id'")) txTenant = String(params[0]);
    return { rows: [] };
  });

  // The first delete is the stale sweep, the second is the deleted-customer
  // sweep. Both answer with the rows they removed; later ones remove nothing.
  deleteResults = [
    () => createQueryChain([{ id: 'stale-1' }, { id: 'stale-2' }]),
    () => createQueryChain([{ id: 'orphan-1' }]),
  ];

  // Every tenant query records the tenant its transaction had set.
  txMock.delete.mockImplementation(() => {
    tenantQueries.push({ kind: 'delete', tenant: txTenant });
    const next = deleteResults.shift();
    return next ? next() : createQueryChain([]);
  });
  txMock.select.mockImplementation(() => {
    tenantQueries.push({ kind: 'select', tenant: txTenant });
    return createQueryChain([]);
  });

  dbMock.select.mockImplementation(() => tenantPageChain());
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
    const selectChain = txMock.select.mock.results[0]?.value;
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
    deleteResults = [
      () => {
        throw new Error('the connection was lost');
      },
      () => createQueryChain([{ id: 'orphan-1' }]),
    ];

    await expect(handleSubscriptionMaintenance(mockEnv)).resolves.toBeUndefined();

    // The second sweep still ran.
    expect(txMock.delete).toHaveBeenCalledTimes(2);
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

  it('enumerates tenants by keyset and runs every tenant query in a transaction that set that tenant', async () => {
    tenantRows = [{ id: TENANT_A }, { id: TENANT_B }];

    await handleSubscriptionMaintenance(mockEnv);

    // Both steps, for both tenants, each on a transaction scoped to its tenant.
    expect(tenantQueries.filter((q) => q.kind === 'delete').map((q) => q.tenant)).toEqual([
      TENANT_A,
      TENANT_A,
      TENANT_B,
      TENANT_B,
    ]);
    // The deleted-customer subquery reads `customers` under the same tenant.
    expect(tenantQueries.filter((q) => q.kind === 'select').map((q) => q.tenant)).toEqual([
      TENANT_A,
      TENANT_B,
    ]);
    // The outer handle only enumerated tenants.
    expect(dbMock.delete).not.toHaveBeenCalled();
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('pages over tenants with a cursor until a short page', async () => {
    tenantRows = Array.from({ length: 101 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));

    await handleSubscriptionMaintenance(mockEnv);

    expect(tenantPages).toHaveLength(2);
    expect(tenantPages[0]!.where).toBeUndefined();
    const second = new PgDialect().sqlToQuery(tenantPages[1]!.where as SQL);
    expect(second.sql).toContain('>');
    expect(second.params).toContain(tenantRows[99]!.id);
    // Two steps per tenant, every tenant reached.
    expect(txMock.delete).toHaveBeenCalledTimes(202);
  });

  it('scopes each delete to its tenant in SQL too, not only through the session', async () => {
    await handleSubscriptionMaintenance(mockEnv);

    for (const index of [0, 1]) {
      const { params } = renderedPredicate(deleteChain(index));
      expect(params).toContain(TENANT_A);
    }
  });

  it('reports a failing tenant by id and still processes the next one', async () => {
    tenantRows = [{ id: TENANT_A }, { id: TENANT_B }, { id: TENANT_C }];
    deleteResults = [
      () => createQueryChain([]),
      () => createQueryChain([]),
      () => {
        throw new Error('B is broken');
      },
      () => {
        throw new Error('B is still broken');
      },
      () => createQueryChain([{ id: 'stale-c' }]),
      () => createQueryChain([{ id: 'orphan-c' }]),
    ];

    const { logged, errored } = await runCapturing();

    // C still ran, on its own tenant.
    expect(tenantQueries.filter((q) => q.kind === 'delete').map((q) => q.tenant)).toEqual([
      TENANT_A,
      TENANT_A,
      TENANT_B,
      TENANT_B,
      TENANT_C,
      TENANT_C,
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('pruned_stale=1');
    expect(logged[0]).toContain('pruned_deleted_customer=1');
    expect(logged[0]).toContain('errors=2');
    expect(logged[0]).toContain(`failed_tenants=${TENANT_B}`);
    expect(logged[0]).not.toContain(TENANT_A);
    expect(errored).toHaveLength(2);
    expect(errored.every((line) => line.includes(TENANT_B))).toBe(true);
  });

  it('reports the deletions of each tenant by id', async () => {
    tenantRows = [{ id: TENANT_A }, { id: TENANT_B }];
    deleteResults = [
      () => createQueryChain([]),
      () => createQueryChain([{ id: 'orphan-a' }]),
    ];

    const { logged } = await runCapturing();

    expect(logged[0]).toContain(`${TENANT_A}:stale=0,deleted_customer=1`);
    // A tenant with nothing pruned and nothing failed is not listed.
    expect(logged[0]).not.toContain(TENANT_B);
  });

  it('reports a run that could not enumerate tenants as an error, without throwing', async () => {
    dbMock.select.mockImplementation(() => {
      throw new Error('the pool is gone');
    });

    const { logged } = await runCapturing();

    expect(logged[0]).toContain('errors=1');
    expect(txMock.delete).not.toHaveBeenCalled();
  });
});

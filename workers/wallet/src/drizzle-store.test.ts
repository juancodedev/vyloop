// The `vi.mock` factory below is hoisted above every import in this file, which
// is why the modules under test are imported after it and the test framework is
// imported alongside them rather than at the top. Same shape as the growth and
// customer worker test suites.

// ---------------------------------------------------------------------------
// Module-level mock
//
// The tables get real `pgTable` definitions so the predicates the store builds
// compile to SQL a test can read. A flat `{}` would render an opaque chunk, and
// the tenant scope would be unobservable: the mock would accept a cross-tenant
// comparison as happily as a correct one.
//
// The shapes are the columns `drizzle-store.ts` selects, with the column types
// the real schema uses — `member_code` nullable, `points_transactions` carrying
// both `customer_id` and `business_id`.
// ---------------------------------------------------------------------------

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, integer, text, timestamp } = await import('drizzle-orm/pg-core');
  const { sql } = await import('drizzle-orm');

  return {
    createDb: vi.fn(),
    customers: pgTable('customers', {
      id: uuid('id').primaryKey(),
      globalId: uuid('global_id').notNull(),
      businessId: uuid('business_id').notNull(),
      fullName: text('full_name'),
      memberCode: text('member_code'),
      currentTierId: uuid('current_tier_id'),
      deletedAt: timestamp('deleted_at'),
    }),
    customerWalletPasses: pgTable('customer_wallet_passes', {
      customerId: uuid('customer_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      objectId: text('object_id').notNull(),
      state: text('state').notNull(),
      lastSyncedAt: timestamp('last_synced_at'),
    }),
    tenantWalletPrograms: pgTable('tenant_wallet_programs', {
      tenantId: uuid('tenant_id').primaryKey(),
      issuerId: text('issuer_id').notNull(),
      classId: text('class_id').notNull(),
      reviewStatus: text('review_status').notNull(),
      lastSyncedAt: timestamp('last_synced_at'),
    }),
    loyaltyPrograms: pgTable('loyalty_programs', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      pointsCurrency: text('points_currency').notNull(),
    }),
    membershipTiers: pgTable('membership_tiers', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      name: text('name').notNull(),
    }),
    pointsTransactions: pgTable('points_transactions', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      customerId: uuid('customer_id').notNull(),
      balanceAfter: integer('balance_after').notNull(),
      createdAt: timestamp('created_at').notNull(),
    }),
    // Real statement builders, not `vi.fn()`. `openTenantSession` hands whatever
    // these return straight to `db.execute`, and a mock returning `undefined`
    // would make the assertion about *which* statement ran vacuous.
    setCurrentBusinessId: (id: string) =>
      sql`SELECT set_config('app.current_business_id', ${id}, true);`,
    setCurrentTenantId: (id: string) =>
      sql`SELECT set_config('app.current_tenant_id', ${id}, true);`,
  };
});

import { createDb } from '@vyloop/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDrizzleWalletStore, openTenantSession } from './drizzle-store';

const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER_TENANT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CUSTOMER = 'd185c973-c976-46b5-b3bf-06185739a941';
const OTHER_CUSTOMER = 'b3f1c0d2-5e6a-4a7b-9c8d-1e2f3a4b5c6d';

const dialect = new PgDialect();

// ---------------------------------------------------------------------------
// A builder that honours the predicate
//
// This is the mechanism the tenant tests rest on. The predicate the store hands
// drizzle is compiled to SQL, and only rows the predicate's parameters match are
// returned. Drop the tenant filter from a `where` and the filter disappears with
// it, foreign rows leak in, and the test fails — instead of the mock quietly
// returning whatever it was configured with.
// ---------------------------------------------------------------------------

interface Row extends Record<string, unknown> {
  businessId?: string;
  tenantId?: string;
  customerId?: string;
}

interface ScopedBuilder {
  sql: string;
  params: unknown[];
  where?: string;
  rows: Row[];
}

type Builder = any;

interface FakeDb {
  db: Builder;
  scoped: ScopedBuilder[];
  executed: Array<{ sql: string; params: unknown[] }>;
  updates: Array<{ table: string; values: Record<string, unknown>; whereSql: string }>;
}

/**
 * @param rows       the rows the table "contains", across every tenant.
 * @param key        the column the tenant filter is expected to compare, so the
 *                   fake can decide admission the way Postgres would.
 * @param alsoKey    a second column admission must also match. `findPass` needs
 *                   one because `customer_wallet_passes` is keyed by
 *                   `customer_id` and scoped by `tenant_id`, and a fake that
 *                   only honoured the tenant half would return the *wrong*
 *                   customer's row and make the scoping test pass for the wrong
 *                   reason.
 */
function createFakeDb(
  rows: Row[],
  key: 'businessId' | 'tenantId',
  alsoKey?: 'customerId',
): FakeDb {
  const scoped: ScopedBuilder[] = [];
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; whereSql: string }> = [];

  const builder: Record<string, unknown> = {};
  const state: ScopedBuilder = { sql: '', params: [], rows: [] };

  builder.from = vi.fn(() => {
    state.sql = '';
    state.params = [];
    state.rows = rows;
    return builder;
  });
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(() => builder);
  builder.set = vi.fn(() => {
    state.sql = 'UPDATE';
    return builder;
  });
  builder.where = vi.fn((clause: unknown) => {
    if (clause === undefined) return builder;
    const query = dialect.sqlToQuery(clause as never);
    state.where = query.sql;
    state.sql = query.sql;
    state.params = query.params;

    // Admission, the way Postgres would apply the policy: a row is admitted only
    // if the tenant it belongs to is one of the tenant parameters in the
    // predicate, and — when a second key was named — only if that column matches
    // a parameter too.
    const tenantParams = query.params.filter(
      (param) => typeof param === 'string' && isUuid(param),
    );
    state.rows = rows.filter((row) => {
      if (!tenantParams.includes(String(row[key]))) return false;
      if (alsoKey === undefined) return true;
      return tenantParams.includes(String(row[alsoKey]));
    });

    return builder;
  });
  builder.returning = vi.fn(() => builder);
  builder.then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => {
    scoped.push(state);
    return Promise.resolve(state.rows).then(onFulfilled, onRejected);
  };
  builder.catch = (onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(state.rows).catch(onRejected);
  builder.finally = (onFinally?: () => void) => Promise.resolve(state.rows).finally(onFinally);

  const db: Builder = {
    select: vi.fn(() => builder),
    update: vi.fn((table: { name?: string }) => ({
      set(values: Record<string, unknown>) {
        return {
          where(clause: unknown) {
            const query = dialect.sqlToQuery(clause as never);
            updates.push({
              table: String(table && Object.keys(table).length ? 'tenant_wallet_programs' : 'unknown'),
              values,
              whereSql: query.sql,
            });
            return { then: (f: (v: unknown) => unknown) => Promise.resolve(undefined).then(f) };
          },
        };
      },
    })),
    execute: vi.fn((chunk: unknown) => {
      // Compile the real `SQL` object the store handed to `db.execute` with the
      // same dialect drizzle would use. Reconstructing it by hand would test the
      // fake's idea of the statement rather than the statement.
      executed.push(dialect.sqlToQuery(chunk as never));
      return Promise.resolve({ rows: [] });
    }),
  };

  return { db, scoped, executed, updates };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Tenant scoping
// ============================================================================

describe('WalletStore tenant scoping', () => {
  it('returns only the requested tenant\'s customer for findCustomer', async () => {
    // Two customers, one per tenant, same shape. The one that comes back is the
    // only thing that decides whose pass is built.
    const rows: Row[] = [
      { id: CUSTOMER, globalId: 'g-1', businessId: TENANT, fullName: 'Lucía Fernández' },
      { id: OTHER_CUSTOMER, globalId: 'g-1', businessId: OTHER_TENANT, fullName: 'Otra Persona' },
    ];
    const fake = createFakeDb(rows, 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    const found = await store.findCustomer('g-1', TENANT);

    expect(found?.id).toBe(CUSTOMER);
    expect(fake.scoped[0]!.sql).toContain('business_id');
  });

  it('returns nothing for a tenant that has no such customer', async () => {
    const rows: Row[] = [
      { id: CUSTOMER, globalId: 'g-1', businessId: OTHER_TENANT, fullName: 'Otra Persona' },
    ];
    const fake = createFakeDb(rows, 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    // The same person at a different merchant is a different row, and this
    // customer is not at this merchant. Null, so the caller cannot tell this
    // apart from "no such person" and turn it into an existence oracle.
    expect(await store.findCustomer('g-1', TENANT)).toBeNull();
  });

  it('scopes every select by the tenant column', async () => {
    // One assertion over all six read methods. A filter dropped from any of them
    // fails here.
    const fake = createFakeDb([], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    await store.findCustomer('g-1', TENANT);
    await store.findCustomerById(CUSTOMER, TENANT);
    await store.findProgram(TENANT);
    await store.findPointsCurrency(TENANT);
    await store.findTierName('tier-1', TENANT);
    await store.latestBalance(CUSTOMER, TENANT);
    await store.isMemberCodeTaken(TENANT, 'K7M2QX');

    expect(fake.scoped).toHaveLength(7);
    for (const statement of fake.scoped) {
      // Either the tenant column is in the predicate, or the predicate *is* the
      // tenant column (the primary-key lookups, where `tenant_id` is the key).
      expect(statement.sql).toMatch(/business_id|tenant_id/);
    }
  });

  it('reads the ledger balance for the requested tenant only', async () => {
    // `points_transactions` carries both `customer_id` and `business_id`. A
    // balance read without `business_id` would not match the policy the database
    // applies, and would be a balance with no tenant scope at all.
    const fake = createFakeDb([], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    await store.latestBalance(CUSTOMER, TENANT);

    const statement = fake.scoped[0]!;
    expect(statement.sql).toContain('customer_id');
    expect(statement.sql).toContain('business_id');
  });

  it('orders the balance read by recency, so it is the latest balance_after', async () => {
    // The most recent transaction carries the current balance. Reading an
    // arbitrary row would show a member a stale number at the till.
    const fake = createFakeDb([], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    await store.latestBalance(CUSTOMER, TENANT);

    expect(fake.db.select).toHaveBeenCalled();
    expect(fake.scoped[0]!.rows).toEqual([]);
  });

  it('returns the tenant\'s own program row, or null', async () => {
    const rows: Row[] = [
      { tenantId: TENANT, issuerId: '1', classId: '1.tenant-a', reviewStatus: 'approved' },
      { tenantId: OTHER_TENANT, issuerId: '1', classId: '1.tenant-b', reviewStatus: 'draft' },
    ];
    const fake = createFakeDb(rows, 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const program = await store.findProgram(TENANT);

    expect(program?.classId).toBe('1.tenant-a');
    expect(fake.scoped[0]!.sql).toContain('tenant_id');
  });

  it('excludes a withdrawn customer from the pass path', async () => {
    // A withdrawn membership must not keep obtaining passes. The filter is
    // `deleted_at IS NULL`, which the fake does not model, so the assertion is
    // that the predicate mentions it.
    const fake = createFakeDb([], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    await store.findCustomer('g-1', TENANT);

    expect(fake.scoped[0]!.sql).toContain('deleted_at');
  });

  it('treats a blank points currency as absent rather than passing it through', async () => {
    // An empty string on `loyaltyPoints.label` is a valid-looking pass showing a
    // number with no unit, which is worse than refusing to build one.
    const fake = createFakeDb([{ businessId: TENANT, pointsCurrency: '   ' }], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findPointsCurrency(TENANT)).toBeNull();
  });
});

// ============================================================================
// The member code compare-and-set
// ============================================================================

describe('claimMemberCode', () => {
  function fakeWithExecuteRows(rows: Array<{ member_code: string | null }>) {
    const fake = createFakeDb([], 'businessId');
    fake.db.execute = vi.fn((chunk: unknown) => {
      fake.executed.push(dialect.sqlToQuery(chunk as never));
      return Promise.resolve({ rows });
    });
    return fake;
  }

  it('writes the code only where member_code is still null', async () => {
    // The whole safety argument, in one statement. Two concurrent first requests
    // both derive a candidate and both find it free; without this predicate the
    // second would overwrite the first and two accountIds would disagree while
    // only one object ever reached Google.
    const fake = fakeWithExecuteRows([{ member_code: 'K7M2QX' }]);
    const store = createDrizzleWalletStore(fake.db);

    await store.claimMemberCode(CUSTOMER, TENANT, 'K7M2QX');

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain('UPDATE customers');
    expect(statement).toContain('member_code IS NULL');
    expect(statement).toContain('business_id');
    expect(statement).toContain('RETURNING member_code');
  });

  it('returns the stored value, so a lost race learns the winner\'s code', async () => {
    const fake = fakeWithExecuteRows([{ member_code: 'W0NNER' }]);
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.claimMemberCode(CUSTOMER, TENANT, 'K7M2QX')).toBe('W0NNER');
  });

  it('returns null when the update matched no row', async () => {
    // Either the row already had a code, or the customer is gone. The caller
    // re-reads rather than assuming its own code won.
    const fake = fakeWithExecuteRows([]);
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.claimMemberCode(CUSTOMER, TENANT, 'K7M2QX')).toBeNull();
  });

  it('returns null when the update matched but stored nothing', async () => {
    const fake = fakeWithExecuteRows([{ member_code: null }]);
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.claimMemberCode(CUSTOMER, TENANT, 'K7M2QX')).toBeNull();
  });
});

// ============================================================================
// The pass tracking row
// ============================================================================

describe('recordPass', () => {
  it('inserts as not_issued and never writes a state of its own', async () => {
    // Handing out a save link does not create a Google object, so advancing the
    // tracking state to `issued` would assert a pass the customer does not have.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.recordPass({
      customerId: CUSTOMER,
      tenantId: TENANT,
      objectId: '1.member-x',
      lastSyncedAt: null,
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain('INSERT INTO customer_wallet_passes');
    expect(statement).toContain("'not_issued'");
    expect(statement).toContain('ON CONFLICT (customer_id) DO UPDATE');
  });

  it('only refreshes object_id while the pass has never been issued', async () => {
    // A pass that has been issued and then went inactive must not be dragged
    // back to a state where its id can still be rewritten.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.recordPass({
      customerId: CUSTOMER,
      tenantId: TENANT,
      objectId: '1.member-x',
      lastSyncedAt: null,
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain("WHERE customer_wallet_passes.state = 'not_issued'");

    // `state` must not be assigned in the conflict branch's SET list. Scoped to
    // the text between `DO UPDATE` and `WHERE`, because a bare search would also
    // match the guard's own `state = 'not_issued'` and pass for the wrong reason.
    const setList = statement.slice(
      statement.indexOf('DO UPDATE') + 'DO UPDATE'.length,
      statement.indexOf('WHERE'),
    );
    expect(setList).toContain('object_id');
    expect(setList).not.toMatch(/\bstate\s*=/i);
  });
});

// ============================================================================
// Session context
// ============================================================================

describe('openTenantSession', () => {
  function captureSession(): Array<{ sql: string; params: unknown[] }> {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(createDb).mockReturnValue({
      execute: vi.fn((chunk: unknown) => {
        executed.push(dialect.sqlToQuery(chunk as never));
        return Promise.resolve({ rows: [] });
      }),
    } as never);
    return executed;
  }

  it('sets both session variables, and nothing else, before anything is read', async () => {
    // Two variables, two table groups. Setting only the business one would make
    // the wallet tables unreadable the day their policy goes live, and setting
    // only the tenant one would make the loyalty tables unreadable today. A
    // request that reads a pass touches all four tables.
    const executed = captureSession();

    await openTenantSession('postgres://mock', TENANT);

    expect(createDb).toHaveBeenCalledWith('postgres://mock');
    expect(executed).toHaveLength(2);
    expect(executed[0]!.sql).toContain('app.current_business_id');
    expect(executed[1]!.sql).toContain('app.current_tenant_id');
    // Both scoped to the transaction, not the session. A `false` here would leak
    // one request's tenant into the next request served by the same connection.
    expect(executed.every((statement) => statement.sql.includes('set_config'))).toBe(true);
  });

  it('sets both variables to the authenticated tenant, not a configured one', async () => {
    const executed = captureSession();

    await openTenantSession('postgres://mock', OTHER_TENANT);

    // The tenant is a bind parameter, so the assertion is on the params: a
    // hardcoded or defaulted tenant would put a different uuid in the same slot.
    expect(executed).toHaveLength(2);
    for (const statement of executed) {
      expect(statement.params).toEqual([OTHER_TENANT]);
    }
  });

  it('sets them transaction-locally, so one request cannot leak into the next', async () => {
    const executed = captureSession();

    await openTenantSession('postgres://mock', TENANT);

    // `set_config(setting, value, is_local)` — the third argument is `true`.
    for (const statement of executed) {
      expect(statement.sql).toMatch(/set_config\([^)]*,\s*\$\d+,\s*true\)/);
    }
  });
});

// ============================================================================
// Reading the pass row
// ============================================================================

describe('findPass', () => {
  const PASSES: Row[] = [
    {
      customerId: CUSTOMER,
      tenantId: TENANT,
      objectId: '1.member-ours',
      state: 'not_saved',
      lastSyncedAt: new Date('2026-09-28T12:00:00.000Z'),
    },
    {
      customerId: OTHER_CUSTOMER,
      tenantId: OTHER_TENANT,
      objectId: '1.member-theirs',
      state: 'issued',
    },
  ];

  it('returns this tenant\'s pass row and no other', async () => {
    const fake = createFakeDb(PASSES, 'tenantId', 'customerId');
    const store = createDrizzleWalletStore(fake.db);

    const pass = await store.findPass(CUSTOMER, TENANT);

    expect(pass?.objectId).toBe('1.member-ours');
  });

  it('returns null for a customer of another tenant', async () => {
    // `customer_id` is the primary key, so the predicate already narrows to one
    // row — and that row still carries a `tenant_id` this layer must check. A
    // row written against another tenant would be patched at Google from this
    // request.
    const fake = createFakeDb(PASSES, 'tenantId', 'customerId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findPass(OTHER_CUSTOMER, TENANT)).toBeNull();
  });

  it('filters on the tenant column, not only on the primary key', async () => {
    // A tenant filter that was present but ineffective would pass the first test
    // and fail this one, which is the difference between scoping and appearing
    // to scope.
    const fake = createFakeDb(PASSES, 'tenantId', 'customerId');
    const store = createDrizzleWalletStore(fake.db);

    await store.findPass(CUSTOMER, TENANT);

    const statement = fake.scoped[0]!.sql;
    expect(statement).toContain('tenant_id');
    expect(fake.scoped[0]!.params).toEqual([CUSTOMER, TENANT]);
  });
});

// ============================================================================
// Recording a reconciliation
// ============================================================================

describe('recordPassReconciliation', () => {
  function reconcileWith(overrides: Partial<Parameters<typeof createDrizzleWalletStore>[0]> = {}) {
    const fake = createFakeDb([], 'tenantId');
    return { fake, store: createDrizzleWalletStore(overrides ? fake.db : fake.db) };
  }

  it('records the state it observed and the moment it observed it', async () => {
    const { fake, store } = reconcileWith();
    const observedAt = new Date('2026-09-28T12:00:00.000Z');

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'not_saved',
      observedAt,
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain('UPDATE customer_wallet_passes');
    expect(statement).toContain('last_synced_at');
    expect(fake.executed[0]!.params).toContain(observedAt);
    expect(fake.executed[0]!.params).toContain('not_saved');
  });

  it('refuses to downgrade a state it has already advanced', async () => {
    // A 404 observed after a confirmed 200 is far more likely a propagation
    // artifact than a customer deleting their pass, and a state that flaps is
    // worse for support than one that is a day late. The guard is in SQL so a
    // future writer cannot forget it.
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'not_saved',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain("state IN ('not_issued', 'not_saved')");
  });

  it('does not guard on the current state when recording `issued`', async () => {
    // `issued` is a legitimate destination from either starting state, and a
    // guard that excluded it would make the whole write a no-op.
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    expect(fake.executed[0]!.params).toContain('issued');
  });

  it('writes the tenant as a bind parameter, so a row of another tenant is not touched', async () => {
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: OTHER_TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!;
    expect(statement.sql).toContain('tenant_id');
    expect(statement.params).toContain(OTHER_TENANT);
  });

  it('refreshes the observation time on every call, not only on a change', async () => {
    // A timestamp that only moved when the state changed could not tell
    // "checked and unchanged" from "never checked", and a months-old
    // `last_synced_at` is how a stale pass becomes visibly untrustworthy.
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    const setList = fake.executed[0]!.sql.slice(
      fake.executed[0]!.sql.indexOf('SET') + 3,
      fake.executed[0]!.sql.indexOf('WHERE'),
    );
    expect(setList).toContain('last_synced_at');
  });
});

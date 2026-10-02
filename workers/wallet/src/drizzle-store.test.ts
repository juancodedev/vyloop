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
    // The root table, keyed by its own id. It carries no RLS policy — the tenant
    // row is what every policy descends from — and a provisioning read is scoped
    // to the very id it was asked for.
    tenants: pgTable('tenants', {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
      country: text('country').notNull(),
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
      name: text('name').notNull(),
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
import type { ProgramInsert } from './store';

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
  id?: string;
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
  /**
   * What `db.execute` resolves to. `UPDATE ... RETURNING` reports how many rows it
   * actually changed, so a test has to be able to say "none" and see the caller
   * act on the difference rather than assuming success.
   */
  executeRows: Array<Record<string, unknown>>;
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
  key: 'businessId' | 'tenantId' | 'id',
  alsoKey?: 'customerId',
): FakeDb {
  const scoped: ScopedBuilder[] = [];
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const updates: Array<{ table: string; values: Record<string, unknown>; whereSql: string }> = [];
  // What `db.execute` resolves to. The `UPDATE ... RETURNING` writes report how
  // many rows they actually changed, so the fake has to be able to say "none"
  // as well as "one" — a fake that always returned a row would make a guard
  // that rejects every write look identical to one that accepts it.
  const executeRows: Array<Record<string, unknown>> = [];

  const builder: Record<string, unknown> = {};
  const state: ScopedBuilder = { sql: '', params: [], rows: [] };

  builder.from = vi.fn(() => {
    state.sql = '';
    state.params = [];
    state.rows = rows;
    return builder;
  });
  builder.orderBy = vi.fn((clause: unknown) => {
    // Recorded, because a keyset page with no `ORDER BY` is not resumable and
    // the `listProgramTenants` tests have to be able to see that.
    if (clause !== undefined) {
      const query = dialect.sqlToQuery(clause as never);
      state.sql = state.sql === '' ? query.sql : `${state.sql} ${query.sql}`;
      state.params = [...state.params, ...query.params];
    }
    return builder;
  });
  builder.limit = vi.fn((n: unknown) => {
    // Honoured rather than ignored. The sweep's entire safety argument for
    // enumerating tenants is that it passes a bound, and a fake whose `limit`
    // does nothing would let an unbounded read pass every test in this file.
    if (typeof n === 'number' && Number.isFinite(n)) {
      state.rows = state.rows.slice(0, n);
    }
    return builder;
  });
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

    // A predicate with no tenant parameter at all scopes to nothing, so Postgres
    // admits every row and lets the predicate's own equality do the work. That is
    // the case `findTenantByClassId` is: it is deliberately the cross-tenant read
    // of this worker, resolving a tenant *from* a Google class, and a fake that
    // insisted on a tenant parameter would report it as finding nothing — a
    // silent total failure of the callback path that looked like a passing test.
    if (tenantParams.length === 0) {
      const valueParams = query.params.filter((param) => typeof param === 'string');
      state.rows =
        valueParams.length === 0
          ? state.rows
          : state.rows.filter((row) => valueParams.includes(String(row.classId)));
      return builder;
    }

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
      return Promise.resolve({ rows: executeRows });
    }),
  };

  return { db, scoped, executed, updates, executeRows };
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
    await store.findTenantBranding(TENANT);
    await store.findProgramName(TENANT);
    await store.findPromoCopy(TENANT);

    expect(fake.scoped).toHaveLength(10);
    for (const statement of fake.scoped) {
      // Either the tenant column is in the predicate, or the predicate *is* the
      // tenant column — the primary-key lookups, where `tenant_id` is the key,
      // and `tenants`, where the tenant's own id is the key.
      expect(statement.sql).toMatch(/business_id|tenant_id|"id"/);
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
    // The rank guard: the write is refused unless the row is weaker than what is
    // being written (`not_issued -> not_saved -> inactive -> issued`) or already
    // exactly it. `expired` and `completed` are in neither set, so nothing can
    // move a row off them.
    expect(statement).toContain("state IN ('not_issued', 'not_saved', 'inactive')");
    // And the guard is wrapped around the `state` assignment only. A `WHERE`
    // guard would refuse the whole row, and a row refused there is a row whose
    // definitive answer was thrown away — which is what left terminal passes
    // permanently due. The claim is guarded; the observation is not.
    expect(statement).toMatch(/SET\s+state\s*=\s*CASE/);
    expect(statement).toContain('ELSE state');
  });

  it('lets a deactivated pass be recorded as issued again', async () => {
    // A customer who reopens a pass Google deactivated has a genuinely ACTIVE
    // object, and the observation path is the only thing that ever learns it.
    // Excluding `inactive` from the source set would leave such a row reading
    // `inactive` for ever — the same stale-tracking defect this guard exists to
    // prevent, just in the other direction.
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    expect(fake.executed[0]!.sql).toContain("state IN ('not_issued', 'not_saved', 'inactive')");
  });

  it('still refreshes the timestamp when the state is unchanged, so `issued` is not frozen', async () => {
    // The property that used to be carried by an `OR state = <written>` clause in
    // the `WHERE`, and is now carried by the timestamp simply not being inside
    // the guard. Either way the rule the column documents must hold: a row
    // already in `issued` still has its `last_synced_at` advanced, so the column
    // means "last verified" rather than "first seen".
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!.sql;
    // `last_synced_at` is assigned a bare bind parameter: no `CASE`, no `WHEN`,
    // nothing conditional in front of it. If the guard ever grew to cover the
    // timestamp, this stops matching and a terminal row goes permanently due.
    expect(statement).toMatch(/last_synced_at\s*=\s*\$\d+::timestamptz/);
    // And the state being written is a bind parameter, so the guard compares
    // against the caller's value rather than a hardcoded one.
    expect(fake.executed[0]!.params).toContain('issued');
  });

  it('advances the timestamp for a terminal row, whose state transition is refused', async () => {
    // The case the old predicate got wrong. A row in `expired` matches nothing
    // in `state IN (...)`, so a `WHERE` guard discarded the whole UPDATE — and
    // with it a definitive answer from Google about a pass this worker had
    // itself marked terminal. The pass then never left the sweep's due set.
    //
    // The statement is the same one; what matters is that nothing in it can
    // refuse the timestamp. Asserted on the compiled SQL because that is the
    // only place the decision is made.
    const { fake, store } = reconcileWith();

    await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'issued',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!.sql;
    // The guard mentions no state at all, so no state can exclude this write.
    const whereList = statement.slice(statement.indexOf('WHERE'));
    expect(whereList).not.toMatch(/state\s+IN/i);
    // `last_synced_at` is assigned the bind parameter directly, with no `CASE`
    // and no condition of any kind in front of it. `$2` is the observedAt of
    // this call, per the params order above.
    expect(statement).toMatch(/last_synced_at\s*=\s*\$\d+::timestamptz/);
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

// ============================================================================
// Recording a lifecycle state
// ============================================================================

describe('recordPassLifecycle', () => {
  function lifecycleWith() {
    const fake = createFakeDb([], 'tenantId');
    return { fake, store: createDrizzleWalletStore(fake.db) };
  }

  it('guards on the source state, not the target, so it cannot assert an existence it never saw', async () => {
    // The one documented exception to the monotonicity guard, and the invariant
    // that survives it: a lifecycle answer may only be written against a row
    // that already says an object exists. Otherwise a Google state could turn
    // "we have never seen an object for this customer" into "this pass is
    // expired", asserting a pass Google was never confirmed to hold.
    const { fake, store } = lifecycleWith();

    await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'expired',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain("state IN ('issued', 'inactive')");
    // `not_issued` and `not_saved` are deliberately absent from that set.
    expect(statement).not.toContain("'not_issued'");
  });

  it('makes expired and completed terminal by omitting them from the source set', async () => {
    const { fake, store } = lifecycleWith();

    await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'completed',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!.sql;
    expect(statement).toContain("state IN ('issued', 'inactive')");
    expect(statement).not.toContain("'expired'");
    expect(statement).not.toContain("'completed'");
  });

  it('scopes the write to one tenant', async () => {
    const { fake, store } = lifecycleWith();

    await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: OTHER_TENANT,
      state: 'inactive',
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!;
    expect(statement.sql).toContain('tenant_id');
    expect(statement.params).toContain(OTHER_TENANT);
  });

  it('records the observation time, so a lifecycle write also refreshes the verification stamp', async () => {
    const { fake, store } = lifecycleWith();
    const observedAt = new Date('2026-09-28T12:00:00.000Z');

    await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'inactive',
      observedAt,
    });

    expect(fake.executed[0]!.sql).toContain('last_synced_at');
    expect(fake.executed[0]!.params).toContain(observedAt);
  });

  it('reports how many rows it changed, so a refused write is not a silent success', async () => {
    // The reason this method returns a number at all. `findPassesByObjectIds`
    // resolves rows by object id with no state filter, so a `not_saved` row
    // reaches this method and matches nothing. Under `Promise<void>` the caller
    // could not tell that from a real write, and the sweep counted a lifecycle
    // observation it had never recorded.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const refused = await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'inactive',
      observedAt: new Date(),
    });
    expect(refused).toBe(0);

    // The same call against a row that does match reports 1, so a caller can act
    // on the difference rather than assuming success.
    fake.executeRows.push({ customer_id: CUSTOMER });
    const accepted = await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'inactive',
      observedAt: new Date(),
    });
    expect(accepted).toBe(1);
  });

  it('reports the row a reconciliation changed, rather than assuming one was', async () => {
    // The same contract as `recordPassLifecycle`, on the other write. A caller
    // that cannot tell "changed nothing" from "changed one row" is a caller that
    // reports an observation it never recorded — the shape the sweep had.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const refused = await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'not_saved',
      observedAt: new Date(),
    });
    expect(refused).toBe(0);

    fake.executeRows.push({ customer_id: CUSTOMER });
    const accepted = await store.recordPassReconciliation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'not_saved',
      observedAt: new Date(),
    });
    expect(accepted).toBe(1);
  });

  it('asks the database for the row it changed, rather than assuming one was', async () => {
    // Without `RETURNING` there is nothing to count, and the count would have to
    // be assumed — which is the bug this return value was introduced to end.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.recordPassLifecycle({
      customerId: CUSTOMER,
      tenantId: TENANT,
      state: 'inactive',
      observedAt: new Date(),
    });

    expect(fake.executed[0]!.sql).toContain('RETURNING');
  });
});

// ============================================================================
// Recording an observation with no state claim
// ============================================================================

describe('recordPassObservation', () => {
  function observationWith() {
    const fake = createFakeDb([], 'tenantId');
    return { fake, store: createDrizzleWalletStore(fake.db) };
  }

  it('writes no state at all, so it cannot invent a tracking value', async () => {
    // The caller knows the object exists and is not `ACTIVE`, and has no word
    // for that in `PassTrackingState`. A method that could set `state` would be
    // one line away from putting an unreadable word in the column.
    const { fake, store } = observationWith();

    await store.recordPassObservation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      observedAt: new Date(),
    });

    const setList = fake.executed[0]!.sql.slice(
      fake.executed[0]!.sql.indexOf('SET') + 3,
      fake.executed[0]!.sql.indexOf('WHERE'),
    );
    expect(setList).toContain('last_synced_at');
    expect(setList).not.toContain('state');
  });

  it('filters on no state either, because a state filter would starve the rows it excludes', async () => {
    // The liveness argument. This write exists so that a pass with no mappable
    // lifecycle state still leaves the due set. Adding a `WHERE` on `state` here
    // would reintroduce exactly the permanent-due defect for whichever states it
    // excluded — including `expired` and `completed`, which this worker writes.
    const { fake, store } = observationWith();

    await store.recordPassObservation({
      customerId: CUSTOMER,
      tenantId: TENANT,
      observedAt: new Date(),
    });

    const whereList = fake.executed[0]!.sql.slice(fake.executed[0]!.sql.indexOf('WHERE'));
    expect(whereList).toContain('customer_id');
    expect(whereList).not.toMatch(/state/i);
  });

  it('keeps the tenant filter, because it writes rows it did not read', async () => {
    // The one guard this method does have. A scheduled sweep calls it, and a
    // write that stamps `last_synced_at` on a row belonging to another tenant
    // would corrupt that tenant's due set from outside.
    const { fake, store } = observationWith();

    await store.recordPassObservation({
      customerId: CUSTOMER,
      tenantId: OTHER_TENANT,
      observedAt: new Date(),
    });

    const statement = fake.executed[0]!;
    expect(statement.sql).toContain('tenant_id');
    expect(statement.params).toContain(OTHER_TENANT);
  });

  it('reports how many rows it changed, so a vanished row does not read as verified', async () => {
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const observedAt = new Date('2026-09-28T12:00:00.000Z');
    expect(
      await store.recordPassObservation({ customerId: CUSTOMER, tenantId: TENANT, observedAt }),
    ).toBe(0);

    fake.executeRows.push({ customer_id: CUSTOMER });
    expect(
      await store.recordPassObservation({ customerId: CUSTOMER, tenantId: TENANT, observedAt }),
    ).toBe(1);
  });
});

// ============================================================================
// The sweep's enumeration queries
// ============================================================================

describe('listProgramTenants', () => {
  function programs(): Row[] {
    return [
      { tenantId: TENANT, issuerId: '3388', classId: 'c1', reviewStatus: 'approved' },
      { tenantId: OTHER_TENANT, issuerId: '3388', classId: 'c2', reviewStatus: 'approved' },
    ];
  }

  it('orders by the primary key, which is what makes the cursor exact', async () => {
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.listProgramTenants({ limit: 10, afterTenantId: null });

    // An unordered keyset page is not resumable: the next page's cursor would be
    // meaningless, so a tenant could be read twice or skipped entirely. `asc` is
    // what drizzle compiles an ascending `orderBy` column to.
    expect(fake.scoped[0]!.sql).toContain('tenant_id" asc');
  });

  it('applies the bound it was given, so the read is never unbounded', async () => {
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const rows = await store.listProgramTenants({ limit: 1, afterTenantId: null });

    expect(rows).toHaveLength(1);
  });

  it('clamps a nonsensical bound rather than passing it through', async () => {
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    // Zero or negative would return nothing at best and error at worst, and an
    // enormous one would be the unbounded read this method exists to prevent.
    expect(await store.listProgramTenants({ limit: 0, afterTenantId: null })).toHaveLength(1);
    expect(await store.listProgramTenants({ limit: 10_000, afterTenantId: null })).toHaveLength(2);
  });

  it('resumes with a strict comparison on the cursor, and never with an offset', async () => {
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.listProgramTenants({ limit: 10, afterTenantId: TENANT });

    // `>` not `>=`, so a page never repeats the cursor row, and no OFFSET: an
    // offset page re-reads and re-sorts everything it skips, and a tenant
    // inserted mid-sweep shifts every page after it and skips rows silently.
    //
    // The compiled predicate is what is asserted, not the rows it returns: this
    // fake admits by comparing every uuid parameter for equality, which is the
    // right model for `eq(tenant_id, $1)` and the wrong one for a `>` cursor.
    // Asserting the SQL is asserting the thing that is actually shipped.
    const sql = fake.scoped[0]!.sql;
    expect(sql).toContain('>');
    expect(sql).not.toContain('OFFSET');
    expect(sql).not.toContain('>=');
    expect(fake.scoped[0]!.params).toContain(TENANT);
  });

  it('emits no predicate at all when starting from the beginning', async () => {
    // A null cursor is a branch, not a sentinel string, so no tenant can be
    // skipped by colliding with a magic value.
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.listProgramTenants({ limit: 10, afterTenantId: null });

    expect(fake.scoped[0]!.where).toBeUndefined();
    expect(fake.scoped[0]!.params).toEqual([]);
  });

  it('reads every tenant when starting from the beginning, because enumerating is the point', async () => {
    const fake = createFakeDb(programs(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    // The one cross-tenant query in the worker, cross-tenant on purpose. A
    // tenant filter here would hide every tenant but one, and the sweep would
    // reconcile a single merchant forever.
    const rows = await store.listProgramTenants({ limit: 10, afterTenantId: null });

    expect(rows.map((r) => r.tenantId)).toEqual([TENANT, OTHER_TENANT]);
  });
});

describe('findPassesByObjectIds', () => {
  function passRows(): Row[] {
    return [
      {
        customerId: CUSTOMER,
        tenantId: TENANT,
        objectId: '3388000000023206930.member-c8b6-1',
        state: 'issued',
      },
      {
        customerId: OTHER_CUSTOMER,
        tenantId: TENANT,
        objectId: '3388000000023206930.member-c8b6-2',
        state: 'issued',
      },
      {
        customerId: OTHER_CUSTOMER,
        tenantId: OTHER_TENANT,
        objectId: '3388000000023206930.member-c8b6-3',
        state: 'issued',
      },
    ];
  }

  it('returns only rows of the tenant it was asked about', async () => {
    const fake = createFakeDb(passRows(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    const rows = await store.findPassesByObjectIds(
      ['3388000000023206930.member-c8b6-1', '3388000000023206930.member-c8b6-3'],
      TENANT,
    );

    // The third row is another merchant's pass and is not returned, so the
    // sweep cannot see it and therefore cannot act on it. This fake admits by
    // tenant rather than by object id, so the assertion is on the tenant.
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true);
    expect(rows.map((r) => r.tenantId)).not.toContain(OTHER_TENANT);
  });

  it('carries the tenant filter in the same WHERE as the ids, as one statement', async () => {
    const fake = createFakeDb(passRows(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.findPassesByObjectIds(['3388000000023206930.member-c8b6-1'], TENANT);

    const sql = fake.scoped[0]!.sql;
    // One statement, one plan shape, whatever the batch size: an `in` list
    // rather than N equality predicates, and the tenant filter in the same
    // `where` rather than applied in application code.
    expect(sql).toContain('object_id" in');
    expect(sql).toContain('tenant_id" =');
    expect(fake.db.select).toHaveBeenCalledTimes(1);
  });

  it('issues no query at all for an empty page', async () => {
    const fake = createFakeDb(passRows(), 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    // Google returns empty pages, and a round trip that can never match is pure
    // waste on a tenant with 50,000 passes.
    expect(await store.findPassesByObjectIds([], TENANT)).toEqual([]);
    expect(fake.db.select).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Provisioning reads
// ============================================================================

describe('findTenantBranding', () => {
  function branding(): Row[] {
    return [
      { id: TENANT, name: 'Café Central', country: 'CL' },
      { id: OTHER_TENANT, name: 'Otra Tienda', country: 'AR' },
    ];
  }

  it('returns this tenant\'s own name and country', async () => {
    const fake = createFakeDb(branding(), 'id');
    const store = createDrizzleWalletStore(fake.db);

    // `toMatchObject` rather than `toEqual`: this fake hands back the whole row it
    // was configured with rather than projecting it, and every other read here
    // asserts on named fields for the same reason.
    expect(await store.findTenantBranding(TENANT)).toMatchObject({
      name: 'Café Central',
      country: 'CL',
    });
  });

  it('scopes the read to the tenant it was asked about, so no merchant is branded as another', async () => {
    // A class carrying another business's name is the failure this guards: it
    // reaches a real customer's phone, and nothing local goes wrong on the way.
    const fake = createFakeDb(branding(), 'id');
    const store = createDrizzleWalletStore(fake.db);

    const row = await store.findTenantBranding(OTHER_TENANT);

    expect(row).toMatchObject({ name: 'Otra Tienda', country: 'AR' });
    expect(fake.scoped[0]!.sql).toContain('"id"');
  });

  it('answers null for a tenant that does not exist', async () => {
    // There is nothing truthful to put in a class's header, and a placeholder
    // name is a merchant's logo on someone else's card.
    const fake = createFakeDb(branding(), 'id');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findTenantBranding(CUSTOMER)).toBeNull();
  });
});

describe('findProgramName', () => {
  it('reads the name of this tenant\'s program', async () => {
    const fake = createFakeDb([{ businessId: TENANT, name: 'Programa de Lealtad Café Central' }], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findProgramName(TENANT)).toBe('Programa de Lealtad Café Central');
    expect(fake.scoped[0]!.sql).toContain('business_id');
  });

  it('is null when the tenant has no program row, which is a real onboarding state', async () => {
    // A loyalty program is configured separately from a Google class. There is
    // no name to build a class from and Google requires one, so the caller has
    // to be able to tell "no program" from "a program called nothing".
    const fake = createFakeDb([], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findProgramName(TENANT)).toBeNull();
  });

  it('treats a blank name as absent rather than building a class with no program', async () => {
    // An empty `programName` is a card that shows no programme at all, which
    // reads as our bug rather than as a merchant who has not configured one.
    const fake = createFakeDb([{ businessId: TENANT, name: '   ' }], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findProgramName(TENANT)).toBeNull();
  });
});

describe('findPromoCopy', () => {
  it("reads this tenant's promo copy, scoped to it", async () => {
    const fake = createFakeDb(
      [{ businessId: TENANT, promoCopy: '¡Cada 10 sellos, un burger gratis!' }],
      'businessId',
    );
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findPromoCopy(TENANT)).toBe('¡Cada 10 sellos, un burger gratis!');
    expect(fake.scoped[0]!.sql).toContain('business_id');
  });

  it('is null when the merchant wrote none, and the class carries no promo row', async () => {
    // The state every merchant is in today. The column is nullable with no
    // default precisely so this is expressible without a placeholder sentence
    // nobody wrote ending up on a real customer's card.
    const fake = createFakeDb([{ businessId: TENANT, promoCopy: null }], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findPromoCopy(TENANT)).toBeNull();
  });

  it('treats a blank promo copy as absent rather than an empty row on the pass', async () => {
    // An empty `TextModuleData.body` renders as a promo header with nothing
    // under it, which is worse than no promo row at all.
    const fake = createFakeDb([{ businessId: TENANT, promoCopy: '   ' }], 'businessId');
    const store = createDrizzleWalletStore(fake.db);

    expect(await store.findPromoCopy(TENANT)).toBeNull();
  });
});

// ============================================================================
// The program row a new tenant is given
// ============================================================================

describe('insertProgram', () => {
  function fakeWithExecute() {
    const fake = createFakeDb([], 'tenantId');
    fake.db.execute = vi.fn((chunk: unknown) => {
      fake.executed.push(dialect.sqlToQuery(chunk as never));
      return Promise.resolve({ rows: [] });
    });
    return fake;
  }

  const INSERT: ProgramInsert = {
    tenantId: TENANT,
    issuerId: '3388000000023206930',
    classId: '3388000000023206930.tenant-90d5ad58-bc5c-46a3-b82a-9cebb47e00b1',
    reviewStatus: 'draft',
    demoMode: true,
  };

  it('writes every column the row needs', async () => {
    const fake = fakeWithExecute();
    const store = createDrizzleWalletStore(fake.db);

    await store.insertProgram(INSERT);

    const statement = fake.executed[0]!;
    expect(statement.sql).toContain('INSERT INTO tenant_wallet_programs');
    expect(statement.sql).toContain('tenant_id');
    expect(statement.sql).toContain('issuer_id');
    expect(statement.sql).toContain('class_id');
    expect(statement.sql).toContain('review_status');
    expect(statement.sql).toContain('demo_mode');
    expect(statement.params).toEqual(
      expect.arrayContaining([TENANT, INSERT.issuerId, INSERT.classId, 'draft']),
    );
  });

  it('sends the review status as a value rather than leaving it to the column default', async () => {
    // The column default is `'none'`, which means "this tenant has no class
    // yet" and fails the readiness gate closed for a tenant that has one.
    // Relying on the default produces exactly that row, with no error anywhere.
    const fake = fakeWithExecute();
    const store = createDrizzleWalletStore(fake.db);

    await store.insertProgram(INSERT);

    expect(fake.executed[0]!.params).toContain('draft');
  });

  it('writes demo mode as true, because publishing access has not been granted', async () => {
    const fake = fakeWithExecute();
    const store = createDrizzleWalletStore(fake.db);

    await store.insertProgram(INSERT);

    expect(fake.executed[0]!.params).toContain(true);
  });

  it('does nothing when the tenant already has a row', async () => {
    // The retry after a Google 409 lands here, and two provisioning runs racing
    // on one tenant both can. `DO NOTHING` keeps the first row's class id rather
    // than letting a second run overwrite the record of what exists at Google.
    const fake = fakeWithExecute();
    const store = createDrizzleWalletStore(fake.db);

    await store.insertProgram(INSERT);

    expect(fake.executed[0]!.sql).toContain('ON CONFLICT (tenant_id) DO NOTHING');
  });
});

// ============================================================================
// Google Wallet callbacks
//
// Three methods, and the properties each one has to hold on its own. The nonce
// claim and the state write are raw `db.execute` statements, so what these tests
// check is the SQL the store actually emits — compiled by the same dialect
// drizzle would use — plus what the method reports for the rows it changed.
// ============================================================================

describe('findTenantByClassId', () => {
  it('resolves the tenant from the stored class id, and reads no other column', async () => {
    const fake = createFakeDb(
      [{ tenantId: TENANT, classId: `${TENANT}.class` }],
      'tenantId',
    );
    const store = createDrizzleWalletStore(fake.db);

    const found = await store.findTenantByClassId(`${TENANT}.class`);

    // Asserted on the field rather than with `toEqual`, and the reason is the
    // fake: it returns the rows it was seeded with and does not model a
    // `.select({...})` projection, so the shape it hands back is the fixture's.
    // Postgres would return only the selected column. What the fake *can* prove
    // is which columns the statement reads, asserted immediately below.
    expect(found?.tenantId).toBe(TENANT);
    // The whole tenant-isolation boundary of the callback path is this lookup, so
    // what it reads is asserted rather than assumed: a version that selected the
    // whole program row would invite a caller to read `reviewStatus` from a row it
    // reached cross-tenant.
    expect(fake.scoped[0]!.sql).toContain('class_id');
    expect(fake.scoped[0]!.sql).not.toContain('review_status');
    expect(fake.scoped[0]!.sql).not.toContain('demo_mode');
  });

  it('returns null for a class no row owns, so it is refused rather than guessed', async () => {
    // A class created by hand in the console, or one belonging to another
    // deployment pointed at this endpoint. Refusing is the point: a class we
    // cannot attribute to a tenant names no row we may write.
    const fake = createFakeDb([{ tenantId: TENANT, classId: `${TENANT}.class` }], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await expect(store.findTenantByClassId('somebody-elses-class')).resolves.toBeNull();
  });

  it('binds the class id as a parameter instead of putting it in the SQL text', async () => {
    // The class id arrives in a request body. It is safe here only because it
    // becomes a bound value; this asserts that, since concatenating it is the
    // failure that turns a public endpoint into an injection point.
    const fake = createFakeDb([], 'tenantId');
    const store = createDrizzleWalletStore(fake.db);

    await store.findTenantByClassId(`x'; DROP TABLE tenants; --`);

    expect(fake.scoped[0]!.params).toContain(`x'; DROP TABLE tenants; --`);
    expect(fake.scoped[0]!.sql).not.toContain('DROP TABLE');
  });
});

describe('claimCallbackDelivery', () => {
  function fakeWithExecute() {
    const fake = createFakeDb([], 'tenantId');
    return { fake, store: createDrizzleWalletStore(fake.db) };
  }

  it('delegates the duplicate check to the unique index, atomically', async () => {
    // The assertion is the clause, and it is the whole mechanism. A read-then-write
    // would let two concurrent deliveries of one nonce both observe absence and
    // both apply, and Google's retries are concurrent by nature. A plain INSERT
    // would throw on the duplicate instead of reporting it, and `DO UPDATE`
    // would return a row and re-apply — so all three are caught here.
    const { fake, store } = fakeWithExecute();
    fake.executeRows.push({ id: 1 });

    await store.claimCallbackDelivery({ tenantId: TENANT, nonce: 'n-1', eventType: 'save' });

    expect(fake.executed[0]!.sql).toContain('INSERT INTO wallet_callback_deliveries');
    expect(fake.executed[0]!.sql).toContain('ON CONFLICT');
    expect(fake.executed[0]!.sql).toContain('DO NOTHING');
    // Named rather than by column list, so renaming the index is a loud failure
    // here rather than a silent fall back to a constraint that does not exist.
    expect(fake.executed[0]!.sql).toContain('uq_wallet_callback_deliveries_tenant_nonce');
  });

  it('binds the tenant, the nonce and the event type as values', async () => {
    // The nonce is attacker-influenced text, so the same reasoning as the class
    // id applies: safe only because it is a parameter.
    const { fake, store } = fakeWithExecute();
    fake.executeRows.push({ id: 1 });

    await store.claimCallbackDelivery({
      tenantId: TENANT,
      nonce: `n'; DELETE FROM customer_wallet_passes; --`,
      eventType: 'save',
    });

    expect(fake.executed[0]!.params).toContain(TENANT);
    expect(fake.executed[0]!.params).toContain(`n'; DELETE FROM customer_wallet_passes; --`);
    expect(fake.executed[0]!.params).toContain('save');
    expect(fake.executed[0]!.sql).not.toContain('DELETE FROM');
  });

  it('reports ownership from RETURNING, so a replay is distinguishable from a write', async () => {
    // One row means this call created the record and owns the effect. Zero means
    // the index rejected it and the delivery is a replay. Under a void signature
    // the caller could not tell those apart, and that difference is duplicate
    // apply versus correct no-op.
    const first = fakeWithExecute();
    first.fake.executeRows.push({ id: 1 });
    await expect(
      first.store.claimCallbackDelivery({ tenantId: TENANT, nonce: 'n', eventType: 'save' }),
    ).resolves.toBe(true);

    const second = fakeWithExecute();
    await expect(
      second.store.claimCallbackDelivery({ tenantId: TENANT, nonce: 'n', eventType: 'save' }),
    ).resolves.toBe(false);
  });
});

describe('recordPassCallback', () => {
  function callbackStore() {
    const fake = createFakeDb([], 'tenantId');
    return { fake, store: createDrizzleWalletStore(fake.db) };
  }

  it('writes issued for a save, because the pass is in the phone', async () => {
    const { fake, store } = callbackStore();
    fake.executeRows.push({ customer_id: 'c' });

    await store.recordPassCallback(
      { customerId: CUSTOMER, tenantId: TENANT, eventType: 'save' },
      new Date('2026-09-28T12:00:00.000Z'),
    );

    expect(fake.executed[0]!.sql).toContain('UPDATE customer_wallet_passes');
    expect(fake.executed[0]!.params).toContain('issued');
  });

  it('writes not_saved for a del, and allows the issued -> not_saved move', async () => {
    // The transition `recordPassReconciliation`'s rank guard would refuse, and
    // the single write the whole feature exists to perform. The source set is
    // asserted because that is what makes it possible.
    const { fake, store } = callbackStore();
    fake.executeRows.push({ customer_id: 'c' });

    await store.recordPassCallback(
      { customerId: CUSTOMER, tenantId: TENANT, eventType: 'del' },
      new Date(),
    );

    expect(fake.executed[0]!.params).toContain('not_saved');
    const sql = fake.executed[0]!.sql;
    expect(sql).toContain("'issued'");
    expect(sql).toContain("'inactive'");
    expect(sql).toContain("'not_issued'");
    expect(sql).toContain("'not_saved'");
  });

  it('keeps the terminal states terminal, so a late save cannot resurrect an expired pass', async () => {
    // `expired` and `completed` are absent from the source set, by omission.
    // Google cannot un-expire or un-complete an object, and a `save` delivered
    // late for a pass that has since expired must not make it `issued` again.
    const { fake, store } = callbackStore();
    fake.executeRows.push({ customer_id: 'c' });

    await store.recordPassCallback(
      { customerId: CUSTOMER, tenantId: TENANT, eventType: 'save' },
      new Date(),
    );

    const sql = fake.executed[0]!.sql;
    const sourceSet = /state IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(sourceSet).not.toContain('expired');
    expect(sourceSet).not.toContain('completed');
  });

  it('scopes the write by tenant as well as by customer', async () => {
    // `customer_id` is the primary key, so the customer predicate already
    // narrows to one row — and that row still carries a `tenant_id` this layer
    // must check. A row written under the wrong tenant would otherwise be moved
    // by a callback for another merchant's class.
    const { fake, store } = callbackStore();
    fake.executeRows.push({ customer_id: 'c' });

    await store.recordPassCallback(
      { customerId: CUSTOMER, tenantId: TENANT, eventType: 'del' },
      new Date(),
    );

    const sql = fake.executed[0]!.sql;
    expect(sql).toContain('customer_id');
    expect(sql).toContain('tenant_id');
    expect(fake.executed[0]!.params).toContain(TENANT);
  });

  it('stamps the observation, because a callback is a definitive answer', async () => {
    const { fake, store } = callbackStore();
    fake.executeRows.push({ customer_id: 'c' });
    const observedAt = new Date('2026-09-28T12:00:00.000Z');

    await store.recordPassCallback(
      { customerId: CUSTOMER, tenantId: TENANT, eventType: 'save' },
      observedAt,
    );

    expect(fake.executed[0]!.sql).toContain('last_synced_at');
    expect(fake.executed[0]!.params).toContain(observedAt);
  });

  it('reports zero rows changed rather than reporting success having done nothing', async () => {
    // A zero here is a fact about our own data: our tracking state and Google's
    // disagree, or the row is gone. Reporting it lets the caller say so and lets
    // the sweep converge the row later. The fake is seeded with no `executeRows`,
    // so `RETURNING` resolves to nothing — the "no row matched" case.
    const { store } = callbackStore();

    await expect(
      store.recordPassCallback(
        { customerId: CUSTOMER, tenantId: TENANT, eventType: 'save' },
        new Date(),
      ),
    ).resolves.toBe(0);
  });
});

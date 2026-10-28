import { is, Table } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import PgQueryModule from 'pg-query-emscripten';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BUSINESS_ID_SETTING,
  BUSINESS_ID_TABLES,
  RLS_EXEMPT_TABLES,
  RLS_POLICY_NAME,
  TENANT_ID_SETTING,
  TENANT_ID_TABLES,
  createRlsPolicies,
  createTenantRlsPolicies,
  dropRlsPolicies,
  dropTenantRlsPolicies,
  enableRls,
  enableTenantRls,
  setCurrentBusinessId,
  setCurrentTenantId,
  withTenantRls,
  withTenantTransaction,
} from './rls';
import * as schema from './schema';

import type { createDb } from './index';

// ---------------------------------------------------------------------------
// Why these tests parse SQL at all.
//
// A policy of the form `USING (business_id = ...)` on a table that has no
// `business_id` column is not a soft failure. Postgres rejects the CREATE
// POLICY outright, which means a mistake in a table list is discovered halfway
// through a production rollout rather than in review. That is the exact failure
// mode the wallet tables would have caused had they been appended to
// BUSINESS_ID_TABLES.
//
// So the policy SQL is parsed with libpg_query — the real PostgreSQL grammar,
// compiled to WebAssembly — and, separately, the columns the policies name are
// checked against the live Drizzle schema. No database is contacted.
//
// LIMIT: parsing proves a statement is well-formed Postgres, not that it means
// what we intend, and not that the referenced columns exist. The column and type
// assertions below cover the part a parser cannot see.
// ---------------------------------------------------------------------------

let pgQuery: PgQueryModule;

beforeAll(async () => {
  pgQuery = await new PgQueryModule();
});

/**
 * Render a Drizzle `SQL` chunk to the string that would be sent to Postgres.
 *
 * Bound parameters are rendered as `$1`, `$2`, ... which is what the driver
 * actually sends and is itself parseable. Rendering them as `?` would make
 * every parameterised statement fail to parse, which would quietly weaken this
 * whole check.
 *
 * The tree is walked recursively because `sql\`${sql.raw(...)}\`` nests the raw
 * statement inside an inner `SQL` object.
 */
function renderSql(chunk: unknown, params: { n: number } = { n: 0 }): string {
  if (typeof chunk === 'string' || chunk === null || chunk === undefined) {
    params.n += 1;
    return `$${params.n}`;
  }

  const node = chunk as { value?: unknown; queryChunks?: unknown[] };

  if (Array.isArray(node.value)) {
    return node.value.map((part) => String(part)).join('');
  }
  if (Array.isArray(node.queryChunks)) {
    return node.queryChunks.map((part) => renderSql(part, params)).join('');
  }
  params.n += 1;
  return `$${params.n}`;
}

/** Render one statement with a fresh parameter counter, as it goes on the wire. */
function renderStatement(chunk: unknown): string {
  return renderSql(chunk, { n: 0 });
}

function renderAll(statements: readonly unknown[]): string[] {
  return statements.map((statement) => renderStatement(statement));
}

function parseErrors(statements: string[]): string[] {
  const errors: string[] = [];
  for (const statement of statements) {
    const result = pgQuery.parse(statement);
    if (result.error) errors.push(`${result.error.message} :: ${statement}`);
  }
  return errors;
}

const tableByName = new Map<string, PgTable>(
  Object.values(schema)
    .filter((value) => is(value, Table))
    .map((table) => [getTableConfig(table as PgTable).name, table as PgTable]),
);

/** The SQL column names of a table declared in `src/schema.ts`. */
function columnsOf(tableName: string): Record<string, { name: string }> {
  const table = tableByName.get(tableName);
  if (!table) {
    throw new Error(
      `Table "${tableName}" is in an RLS table list but is not exported by src/schema.ts`,
    );
  }
  return getTableConfig(table).columns as unknown as Record<string, { name: string }>;
}

describe('RLS policy SQL is valid for both scoping shapes', () => {
  it('rejects a deliberately broken statement, so the parser is load-bearing', () => {
    expect(pgQuery.parse('CREATE POLICY p ON "t" USING ();').error).toBeTruthy();
  });

  it('parses every business_id policy', () => {
    const rendered = renderAll(createRlsPolicies());
    expect(rendered).toHaveLength(BUSINESS_ID_TABLES.length);
    expect(parseErrors(rendered)).toEqual([]);
  });

  it('parses every tenant_id policy', () => {
    const rendered = renderAll(createTenantRlsPolicies());
    expect(rendered).toHaveLength(TENANT_ID_TABLES.length);
    expect(parseErrors(rendered)).toEqual([]);
  });

  it('parses every ALTER TABLE and DROP POLICY statement', () => {
    const rendered = renderAll([
      ...enableRls(),
      ...dropRlsPolicies(),
      ...enableTenantRls(),
      ...dropTenantRlsPolicies(),
    ]);
    expect(rendered.length).toBe(
      BUSINESS_ID_TABLES.length * 2 + TENANT_ID_TABLES.length * 2,
    );
    expect(parseErrors(rendered)).toEqual([]);
  });

  it('parses both session-context statements', () => {
    const rendered = [
      renderStatement(setCurrentBusinessId('00000000-0000-0000-0000-000000000000')),
      renderStatement(setCurrentTenantId('00000000-0000-0000-0000-000000000000')),
    ];
    expect(parseErrors(rendered)).toEqual([]);
    expect(rendered[0]).toContain(`set_config('${BUSINESS_ID_SETTING}', $1, true);`);
    expect(rendered[1]).toContain(`set_config('${TENANT_ID_SETTING}', $1, true);`);
  });

  it('keeps the two session variables distinct', () => {
    // A shared name would make it impossible to scope a request to a business
    // for one set of tables and to a tenant for another, and would let a
    // business-scoped context satisfy a tenant-scoped policy.
    expect(BUSINESS_ID_SETTING).not.toBe(TENANT_ID_SETTING);
    expect(renderStatement(setCurrentBusinessId('x'))).not.toContain(TENANT_ID_SETTING);
    expect(renderStatement(setCurrentTenantId('x'))).not.toContain(BUSINESS_ID_SETTING);
  });
});

describe('policy columns match the real schema', () => {
  it.each(BUSINESS_ID_TABLES)('%s has a business_id column', (tableName) => {
    // The validity condition a parser cannot check. Appending a table without a
    // business_id column to BUSINESS_ID_TABLES fails here instead of halfway
    // through a production rollout.
    const names = Object.values(columnsOf(tableName)).map((column) => column.name);
    expect(names).toContain('business_id');
  });

  it.each(TENANT_ID_TABLES)('%s has a tenant_id column', (tableName) => {
    const names = Object.values(columnsOf(tableName)).map((column) => column.name);
    expect(names).toContain('tenant_id');
  });

  it('keeps the two table lists disjoint', () => {
    for (const tenantTable of TENANT_ID_TABLES) {
      expect(BUSINESS_ID_TABLES as readonly string[]).not.toContain(tenantTable);
    }
    for (const businessTable of BUSINESS_ID_TABLES) {
      expect(TENANT_ID_TABLES as readonly string[]).not.toContain(businessTable);
    }
  });

  it('scopes pos_terminals by business_id', () => {
    // A counter belongs to the merchant that installed it, and the terminal token
    // exchange mints a credential for it, so reading a terminal by id still has to
    // be a read of a row this tenant owns. `pos_terminals` has the column and was
    // simply absent from the list, which is the quiet version of the same bug: it
    // would have received no policy when the RLS rollout ran.
    expect(BUSINESS_ID_TABLES as readonly string[]).toContain('pos_terminals');

    // Named explicitly, not only through the `it.each` above, so the intent is
    // legible at the point someone is tempted to remove it again.
    const rendered = enableRls().map(renderStatement);
    expect(rendered).toContain('ALTER TABLE "pos_terminals" ENABLE ROW LEVEL SECURITY;');
    expect(
      createRlsPolicies().map(renderStatement),
    ).toContain(
      `CREATE POLICY ${RLS_POLICY_NAME} ON "pos_terminals" ` +
        `USING (business_id = current_setting('${BUSINESS_ID_SETTING}')::UUID);`,
    );
  });

  it('leaves the tenant-keyed list alone — pos_terminals is not one of them', () => {
    // Asserted as a whole value rather than as a membership test, because the
    // failure this guards against is a table *added* to the wrong list. A counter
    // is scoped to a merchant, not to a Google tenant, and a policy naming
    // `tenant_id` on it would fail at creation time.
    expect([...TENANT_ID_TABLES]).toEqual([
      'tenant_wallet_programs',
      'customer_wallet_passes',
      'wallet_callback_deliveries',
    ]);
    expect(TENANT_ID_TABLES as readonly string[]).not.toContain('pos_terminals');
  });

  it('scopes settled_payments by business_id', () => {
    // A settlement belongs to the merchant that was paid, and the row is written
    // by a payment rail rather than by a credential scoped to that merchant — so
    // the scoping is *resolved* from the payload's merchant reference instead of
    // inherited from a caller. It is registered here for the reason `pos_terminals`
    // was: a table absent from this list receives no policy when the rollout runs,
    // and a reconciliation check that could read another merchant's sales is a
    // cross-tenant leak with a report attached.
    expect(BUSINESS_ID_TABLES as readonly string[]).toContain('settled_payments');

    const rendered = enableRls().map(renderStatement);
    expect(rendered).toContain('ALTER TABLE "settled_payments" ENABLE ROW LEVEL SECURITY;');
    expect(createRlsPolicies().map(renderStatement)).toContain(
      `CREATE POLICY ${RLS_POLICY_NAME} ON "settled_payments" ` +
        `USING (business_id = current_setting('${BUSINESS_ID_SETTING}')::UUID);`,
    );
  });

  it('casts to uuid only where the scoping column really is a uuid', () => {
    // `::UUID` is a hard requirement for these comparisons. Against a text
    // column Postgres raises "operator does not exist: text = uuid", which a
    // parse check cannot see.
    for (const tableName of [...BUSINESS_ID_TABLES, ...TENANT_ID_TABLES]) {
      const table = tableByName.get(tableName) as PgTable;
      const config = getTableConfig(table);
      for (const scopingColumn of ['business_id', 'tenant_id']) {
        const column = config.columns.find((candidate) => candidate.name === scopingColumn);
        if (!column) continue;
        expect(column.getSQLType(), `${tableName}.${scopingColumn}`).toBe('uuid');
      }
    }
  });
});

describe('policy shape', () => {
  it('scopes business tables by business_id and the business setting', () => {
    const rendered = renderAll(createRlsPolicies());
    rendered.forEach((statement, i) => {
      expect(statement).toBe(
        `CREATE POLICY ${RLS_POLICY_NAME} ON "${BUSINESS_ID_TABLES[i]}" ` +
          `USING (business_id = current_setting('${BUSINESS_ID_SETTING}')::UUID);`,
      );
      expect(statement).not.toContain('tenant_id');
    });
  });

  it('scopes tenant tables by tenant_id and the tenant setting', () => {
    const rendered = renderAll(createTenantRlsPolicies());
    rendered.forEach((statement, i) => {
      expect(statement).toBe(
        `CREATE POLICY ${RLS_POLICY_NAME} ON "${TENANT_ID_TABLES[i]}" ` +
          `USING (tenant_id = current_setting('${TENANT_ID_SETTING}')::UUID);`,
      );
      expect(statement).not.toContain('business_id');
    });
  });

  it('stages the two rollouts independently', () => {
    // Calling enableRls() must not switch on isolation for the wallet tables.
    // They are a separate risk and may need to go live on a different day.
    const enabled = renderAll(enableRls()).join('\n');
    for (const tenantTable of TENANT_ID_TABLES) {
      expect(enabled).not.toContain(`"${tenantTable}"`);
    }
    const enabledTenant = renderAll(enableTenantRls()).join('\n');
    for (const businessTable of BUSINESS_ID_TABLES) {
      expect(enabledTenant).not.toContain(`"${businessTable}"`);
    }
  });
});

describe('withTenantRls', () => {
  it('executes the tenant session statement exactly once', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await withTenantRls({ execute }, 'tenant-7');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(renderStatement(execute.mock.calls[0][0])).toContain(
      `set_config('${TENANT_ID_SETTING}', $1, true);`,
    );
  });

  it('propagates a database failure instead of swallowing it', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(withTenantRls({ execute }, 'tenant-7')).rejects.toThrow('connection reset');
  });
});

describe('the table lists cover the schema', () => {
  // A tenant table missing from every list gets no policy when RLS is rolled
  // out, and nothing fails: its rows simply stay readable across tenants. So
  // every schema table that carries a tenant column has to be placed somewhere,
  // including the deliberate exemptions.
  const placed = [
    ...BUSINESS_ID_TABLES,
    ...TENANT_ID_TABLES,
    ...RLS_EXEMPT_TABLES.map((entry) => entry.table),
  ];

  it('places every table with a business_id or tenant_id column in exactly one list', () => {
    const tenantTables = [...tableByName.keys()].filter((name) => {
      const columns = Object.values(columnsOf(name)).map((column) => column.name);
      return columns.includes('business_id') || columns.includes('tenant_id');
    });

    for (const table of tenantTables) {
      expect(
        placed.filter((name) => name === table),
        `"${table}" must be in exactly one of BUSINESS_ID_TABLES, TENANT_ID_TABLES or RLS_EXEMPT_TABLES`,
      ).toHaveLength(1);
    }
  });

  it('scopes push_subscriptions by business and wallet callbacks by tenant', () => {
    expect(BUSINESS_ID_TABLES as readonly string[]).toContain('push_subscriptions');
    expect(TENANT_ID_TABLES as readonly string[]).toContain('wallet_callback_deliveries');
  });

  it('gives a reason for every exemption', () => {
    expect(RLS_EXEMPT_TABLES.map((entry) => entry.table)).toEqual([
      'tenants',
      'cross_loyalty_alliances',
    ]);
    for (const entry of RLS_EXEMPT_TABLES) {
      expect(entry.reason.length, entry.table).toBeGreaterThan(20);
    }
  });
});

describe('the policy predicate fails loud', () => {
  it('reads the setting without missing_ok, so a request with no tenant errors', () => {
    // `current_setting(name, true)` would return NULL and match no rows; a
    // query that forgot its tenant would then look like an empty result.
    for (const statement of [
      ...renderAll(createRlsPolicies()),
      ...renderAll(createTenantRlsPolicies()),
    ]) {
      expect(statement).toMatch(/current_setting\('app\.current_(business|tenant)_id'\)::UUID/);
    }
  });
});

describe('withTenantTransaction', () => {
  function fakeDb() {
    const calls: string[] = [];
    const tx = {
      execute: vi.fn(async (statement: unknown) => {
        calls.push(`tx:${renderStatement(statement as never)}`);
        return { rows: [] };
      }),
    };
    const opened = vi.fn();
    const db = {
      execute: vi.fn(async () => {
        calls.push('db:execute');
        return { rows: [] };
      }),
      async transaction<T>(fn: (handle: typeof tx) => Promise<T>): Promise<T> {
        opened();
        return fn(tx);
      },
    };
    return { db, tx, calls, opened };
  }

  it('accepts the workers’ database and hands fn its transaction', () => {
    // A type check, not a run: the real Drizzle database must fit the helper's
    // parameter, and `fn` must receive a handle it can query with.
    const scoped = (db: ReturnType<typeof createDb>) =>
      withTenantTransaction(db, { businessId: 'biz-1' }, async (tx) =>
        tx.select().from(schema.customers).limit(1),
      );
    expect(typeof scoped).toBe('function');
  });

  it('sets the business on the transaction handle before running fn, and never on db', async () => {
    const { db, tx, calls, opened } = fakeDb();

    const result = await withTenantTransaction(db, { businessId: 'biz-1' }, async (handle) => {
      calls.push('fn');
      expect(handle).toBe(tx);
      return 'done';
    });

    expect(result).toBe('done');
    expect(opened).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
    expect(calls).toEqual([
      `tx:SELECT set_config('${BUSINESS_ID_SETTING}', $1, true);`,
      'fn',
    ]);
    expect(tx.execute.mock.calls[0]![0]).toEqual(setCurrentBusinessId('biz-1'));
  });

  it('sets both settings when both ids are given', async () => {
    const { db, calls } = fakeDb();

    await withTenantTransaction(db, { businessId: 'biz-1', tenantId: 'biz-1' }, async () => {
      calls.push('fn');
    });

    expect(calls).toEqual([
      `tx:SELECT set_config('${BUSINESS_ID_SETTING}', $1, true);`,
      `tx:SELECT set_config('${TENANT_ID_SETTING}', $1, true);`,
      'fn',
    ]);
  });

  it('sets only the tenant when only the tenant is given', async () => {
    const { db, tx } = fakeDb();

    await withTenantTransaction(db, { tenantId: 'tenant-7' }, async () => undefined);

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.execute.mock.calls[0]![0]).toEqual(setCurrentTenantId('tenant-7'));
  });

  it('refuses to open a transaction with no tenant at all', async () => {
    const { db, opened } = fakeDb();

    await expect(withTenantTransaction(db, {}, async () => undefined)).rejects.toThrow(
      /businessId or tenantId/,
    );
    expect(opened).not.toHaveBeenCalled();
  });

  it('propagates a failure from fn, so the transaction rolls back', async () => {
    const { db } = fakeDb();

    await expect(
      withTenantTransaction(db, { businessId: 'biz-1' }, async () => {
        throw new Error('insert failed');
      }),
    ).rejects.toThrow('insert failed');
  });
});

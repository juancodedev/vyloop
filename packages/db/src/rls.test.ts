import { is, Table } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import PgQueryModule from 'pg-query-emscripten';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  BUSINESS_ID_SETTING,
  BUSINESS_ID_TABLES,
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
} from './rls';
import * as schema from './schema';

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

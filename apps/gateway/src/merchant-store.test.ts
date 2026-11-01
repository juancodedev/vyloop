// The `vi.mock` factory below is hoisted above every import, which is why the
// module under test is imported after it. Same shape as
// `workers/wallet/src/drizzle-store.test.ts`, for the same reason.
//
// The tables get real `pgTable` definitions so the predicates compile to SQL a
// test can read. A flat `{}` would render an opaque chunk, and the tenant scope
// would be unobservable — the fake would admit a cross-tenant comparison as
// happily as a correct one.

vi.mock('@vyloop/db', async () => {
  const { pgTable, uuid, integer, numeric, text } = await import('drizzle-orm/pg-core');
  const { sql } = await import('drizzle-orm');

  return {
    createDb: vi.fn(),
    // The root table. `slug` is `unique`, so it names exactly one row — which is
    // what makes this lookup a tenant resolution rather than a search.
    tenants: pgTable('tenants', {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
      slug: text('slug').notNull().unique(),
    }),
    // `business_id`-keyed, so RLS applies once the policy is enabled.
    loyaltyPrograms: pgTable('loyalty_programs', {
      id: uuid('id').primaryKey(),
      businessId: uuid('business_id').notNull(),
      name: text('name').notNull(),
      promoCopy: text('promo_copy'),
      pointsCurrency: text('points_currency'),
      earnRate: numeric('earn_rate', { precision: 10, scale: 4 }),
      minRedeemPoints: integer('min_redeem_points'),
    }),
    // Real statement builders, not `vi.fn()`: the ordering test below asserts on
    // the compiled SQL, and a mock returning `undefined` would make it vacuous.
    setCurrentBusinessId: (id: string) =>
      sql`SELECT set_config('app.current_business_id', ${id}, true);`,
    // The real helper, so the test sees the statements it issues and the handle
    // it issues them on.
    withTenantTransaction: (await vi.importActual<typeof import('@vyloop/db')>('@vyloop/db'))
      .withTenantTransaction,
  };
});

import { createDb, loyaltyPrograms, tenants } from '@vyloop/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMerchantPageReader } from './merchant-store';

const TENANT = '90d5ad58-bc5c-46a3-b82a-9cebb47e00b1';
const OTHER = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const dialect = new PgDialect();

type Row = any;

// ---------------------------------------------------------------------------
// A builder that honours the predicate
//
// Same mechanism the wallet store's tenant tests rest on: the predicate is
// compiled to SQL and only rows its parameters match are returned. Drop the
// predicate and foreign rows leak in and the test fails — instead of the mock
// returning whatever it was configured with, which is how a cross-tenant read
// passes a test suite.
// ---------------------------------------------------------------------------

interface Scoped {
  table: string;
  sql: string;
  params: unknown[];
}

function fakeDb(tables: Array<{ table: string; key: string; rows: Row[] }>) {
  const scoped: Scoped[] = [];
  const executed: Array<{ sql: string; params: unknown[]; on: 'db' | 'tx' }> = [];
  const selectedOn: Array<'db' | 'tx'> = [];
  let projection: Record<string, { name: string }> | null = null;

  const entryFor = (name: string) => tables.find((candidate) => candidate.table === name)!;

  const builder: any = {};
  const state: { table: string; rows: Row[] } = { table: '', rows: [] };

  builder.from = vi.fn((table: unknown) => {
    // Drizzle carries the SQL table name on a non-enumerable symbol rather than a
    // plain `name` property, so it is read the way drizzle itself reads it. A
    // hardcoded lookup keyed on an own property would find nothing here and the
    // tests below would fail on the fake rather than on the query.
    const tableName = sqlName(table);
    state.table = tableName;
    state.rows = entryFor(tableName).rows;
    return builder;
  });
  builder.where = vi.fn((clause: unknown) => {
    const query = dialect.sqlToQuery(clause as never);
    scoped.push({ table: state.table, sql: query.sql, params: query.params });

    const key = entryFor(state.table).key;
    state.rows = state.rows.filter((row) => query.params.includes(row[key]));
    return builder;
  });
  builder.limit = vi.fn(() => builder);
  builder.then = (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => {
    const rows =
      projection === null
        ? state.rows
        : state.rows.map((row) =>
            Object.fromEntries(
              Object.entries(projection!).map(([key, column]) => [key, row[column.name]]),
            ),
          );
    return Promise.resolve(rows).then(onFulfilled, onRejected);
  };

  const db = {
    /**
     * `select` applies the projection, as drizzle does.
     *
     * The store selects `promoCopy`, `pointsCurrency`, `earnRate` and
     * `minRedeemPoints` and the rows below carry `promo_copy` and friends. Real
     * drizzle maps the aliased SQL column back to the key the caller wrote; a fake
     * that returned the raw row would answer `undefined` for every projected
     * field and the reader would look like it dropped the merchant's promo copy.
     */
    select: vi.fn((fields?: Record<string, { name: string }>) => {
      selectedOn.push('db');
      projection = fields ?? null;
      return builder;
    }),
    execute: vi.fn((chunk: unknown) => {
      executed.push({ ...dialect.sqlToQuery(chunk as never), on: 'db' });
      return Promise.resolve({ rows: [] });
    }),
    // The transaction handle records which handle each statement ran on, so a
    // tenant setting issued on the outer database is told apart from one that
    // reaches the query after it.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: (fields?: Record<string, { name: string }>) => {
          selectedOn.push('tx');
          projection = fields ?? null;
          return builder;
        },
        execute: (chunk: unknown) => {
          executed.push({ ...dialect.sqlToQuery(chunk as never), on: 'tx' });
          return Promise.resolve({ rows: [] });
        },
      }),
    ),
  };

  return { db, scoped, executed, selectedOn };
}

/** The SQL table name off a drizzle table object, the way drizzle reads it. */
function sqlName(table: unknown): string {
  const symbol = Object.getOwnPropertySymbols(table).find(
    (candidate) => candidate.description === 'drizzle:Name',
  );
  if (symbol === undefined) throw new Error('not a drizzle table');
  return (table as Record<symbol, string>)[symbol];
}

// Sanity check on the fake itself: if `sqlName` cannot resolve the mocked tables,
// every assertion below would be about a fake rather than about the query.
expect(sqlName(tenants)).toBe('tenants');
expect(sqlName(loyaltyPrograms)).toBe('loyalty_programs');

/** Two merchants, one slug each, so a missing predicate admits a foreign row. */
function twoMerchants() {
  return fakeDb([
    {
      table: 'tenants',
      key: 'slug',
      rows: [
        { id: TENANT, name: 'Café Central', slug: 'cafe-central' },
        { id: OTHER, name: 'Otro Negocio', slug: 'otro-negocio' },
      ],
    },
    {
      table: 'loyalty_programs',
      key: 'business_id',
      rows: [
        {
          business_id: TENANT,
          name: 'Programa de Lealtad Café Central',
          promo_copy: '¡Cada 10 cafés, uno gratis!',
          points_currency: 'puntos',
          earn_rate: '1.0',
          min_redeem_points: 100,
        },
        {
          business_id: OTHER,
          name: 'Programa de Otro',
          promo_copy: null,
          points_currency: 'puntos',
          earn_rate: '1.0',
          min_redeem_points: 50,
        },
      ],
    },
  ]);
}

/**
 * The reader, over a fake engine — and the fake itself, because half of what
 * matters here is the SQL rather than the value that comes back.
 */
function readerFor(fake: ReturnType<typeof fakeDb>) {
  vi.mocked(createDb).mockReturnValue(fake.db as never);
  return {
    ...fake,
    reader: createMerchantPageReader({ DATABASE_URL: 'postgres://mock' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

describe('the merchant page read', () => {
  it('resolves a slug to the merchant and its program', async () => {
    const { reader } = readerFor(twoMerchants());

    const found = await reader.findBySlug('cafe-central');

    expect(found).toEqual({
      tenantId: TENANT,
      name: 'Café Central',
      slug: 'cafe-central',
      programName: 'Programa de Lealtad Café Central',
      promoCopy: '¡Cada 10 cafés, uno gratis!',
      pointsCurrency: 'puntos',
      earnRate: '1.0',
      minRedeemPoints: 100,
    });
  });

  it('answers null for a slug no tenant has', async () => {
    const { reader } = readerFor(twoMerchants());

    // Null rather than a 404-shaped throw: the route turns this into a 404, and
    // it must not be able to tell "no such merchant" from "no such page".
    expect(await reader.findBySlug('nadie')).toBeNull();
  });

  it('never reads another merchant\'s program row', async () => {
    // The two merchants differ in every field the page renders, so a missing
    // `business_id` predicate would show up as the wrong merchant's name and
    // promo copy rather than as a duplicate row nobody notices.
    const { reader } = readerFor(twoMerchants());

    const found = await reader.findBySlug('cafe-central');

    expect(found?.name).not.toBe('Otro Negocio');
    expect(found?.promoCopy).not.toBeNull();
  });

  it('looks the tenant up by slug, not by id', async () => {
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug('cafe-central');

    expect(fake.scoped[0]!.table).toBe('tenants');
    expect(fake.scoped[0]!.sql).toContain('slug');
    expect(fake.scoped[0]!.params).toEqual(['cafe-central']);
  });

  it('reads the program by the id the slug resolved to', async () => {
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug('cafe-central');

    expect(fake.scoped[1]!.table).toBe('loyalty_programs');
    expect(fake.scoped[1]!.sql).toContain('business_id');
    expect(fake.scoped[1]!.params).toEqual([TENANT]);
  });

  it('passes the slug as a bound parameter, never as SQL text', async () => {
    // The guard in `merchantSlugFrom` already refuses anything but `[a-z0-9-]`,
    // so this is the second of two independent defences rather than the only one.
    // A slug shaped like SQL would have to defeat the parameter binding first.
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug("cafe'; DROP TABLE tenants;--");

    expect(fake.scoped[0]!.params).toEqual(["cafe'; DROP TABLE tenants;--"]);
    expect(fake.scoped[0]!.sql).not.toContain('DROP');
  });
});

// ---------------------------------------------------------------------------
// RLS ordering, which is silent when it is wrong
// ---------------------------------------------------------------------------

describe('RLS session ordering', () => {
  it('sets app.current_business_id to the resolved tenant before reading the program', async () => {
    // `loyalty_programs` is in `BUSINESS_ID_TABLES`. Once that policy is enabled,
    // a read with the variable unset returns **no rows and no error** — the page
    // comes up empty and reads as "this merchant configured nothing". So the
    // ordering is the correctness of this query, not tidiness.
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug('cafe-central');

    expect(fake.executed).toHaveLength(1);
    expect(fake.executed[0]!.sql).toContain("set_config('app.current_business_id'");
    expect(fake.executed[0]!.params).toEqual([TENANT]);
  });

  it('reads the program on the same transaction the setting was issued on', async () => {
    // `set_config(..., true)` lasts for its transaction only. Issued on the
    // outer database it would be gone before the program read.
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug('cafe-central');

    expect(fake.executed.map((statement) => statement.on)).toEqual(['tx']);
    // The tenant lookup has no policy and stays outside; the program read follows
    // the setting on the transaction.
    expect(fake.selectedOn).toEqual(['db', 'tx']);
  });

  it('does not touch the database at all for a slug with no tenant', async () => {
    // No tenant, therefore no id to set, therefore nothing to read. A query that
    // armed RLS with a blank id here would be arming a policy against nothing.
    const fake = readerFor(twoMerchants());

    await fake.reader.findBySlug('nadie');

    expect(fake.executed).toEqual([]);
    expect(fake.scoped).toHaveLength(1);
  });

  it('answers a tenant with no loyalty program, rather than failing', async () => {
    // A business can exist before its programme is configured — that is a real
    // onboarding state, not an error. The page then renders the merchant's name
    // and logo and nothing invented.
    const fake = fakeDb([
      {
        table: 'tenants',
        key: 'slug',
        rows: [{ id: TENANT, name: 'Café Central', slug: 'cafe-central' }],
      },
      { table: 'loyalty_programs', key: 'business_id', rows: [] },
    ]);
    const { reader } = readerFor(fake);

    const found = await reader.findBySlug('cafe-central');

    expect(found?.name).toBe('Café Central');
    expect(found?.programName).toBeNull();
    expect(found?.promoCopy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('blank values are read as absent', () => {
  it('treats an empty promo copy as absent, not as an empty section', async () => {
    // The column is nullable, so `null` and `''` are both reachable: one by not
    // writing it, one by clearing the field. A page rendering an empty
    // blockquote reads as a bug in the platform.
    const fake = fakeDb([
      {
        table: 'tenants',
        key: 'slug',
        rows: [{ id: TENANT, name: 'Café Central', slug: 'cafe-central' }],
      },
      {
        table: 'loyalty_programs',
        key: 'business_id',
        rows: [
          {
            business_id: TENANT,
            name: 'Programa',
            promo_copy: '   ',
            points_currency: '',
            earn_rate: '1.0',
            min_redeem_points: 100,
          },
        ],
      },
    ]);

    const found = await readerFor(fake).reader.findBySlug('cafe-central');

    expect(found?.promoCopy).toBeNull();
    expect(found?.pointsCurrency).toBeNull();
  });

  it('keeps a numeric rate as the string Postgres returns, unformatted', async () => {
    // `numeric` has no locale and no display rule of ours. Formatting it here
    // would mean inventing one.
    const fake = fakeDb([
      {
        table: 'tenants',
        key: 'slug',
        rows: [{ id: TENANT, name: 'Café Central', slug: 'cafe-central' }],
      },
      {
        table: 'loyalty_programs',
        key: 'business_id',
        rows: [
          {
            business_id: TENANT,
            name: 'Programa',
            promo_copy: null,
            points_currency: 'puntos',
            earn_rate: '2.5000',
            min_redeem_points: 100,
          },
        ],
      },
    ]);

    expect((await readerFor(fake).reader.findBySlug('cafe-central'))?.earnRate).toBe('2.5000');
  });
});
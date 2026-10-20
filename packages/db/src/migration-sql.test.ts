import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import PgQueryModule from 'pg-query-emscripten';
import { describe, expect, it } from 'vitest';

import { allIndexes, indexByName } from './indexes';
import { loyaltyPrograms, pointsTransactions, tenantWalletPrograms } from './schema';

// ---------------------------------------------------------------------------
// A migration that only fails when it is applied is a migration nobody can
// review. These tests parse every migration file with libpg_query — the real
// PostgreSQL grammar, compiled to WebAssembly — and never connect to a
// database.
//
// LIMITS OF THIS CHECK, stated plainly so nobody over-trusts it:
//
//   - It is a *syntax* check, not a semantic one. It proves each statement is
//     well-formed Postgres. It does NOT prove the referenced tables, columns or
//     operator classes exist. `CREATE INDEX "i" ON "nope" USING btree ("x")`
//     parses fine and fails at run time.
//   - Semantic coverage that is possible without a database is covered
//     separately below: every index declared in the schema is required to
//     appear in a migration, the 0004 dependency ordering is asserted
//     explicitly, and the journal is checked for orphaned and missing entries.
//
// A real acceptance run is still required against a scratch database before
// this touches a shared one.
// ---------------------------------------------------------------------------

const DRIZZLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * A parser for one migration file.
 *
 * The parser is a WebAssembly build of the real PostgreSQL grammar, and it
 * **keeps what it allocates**: each parse leaves its tree in the module's
 * heap, and a shared instance eventually cannot produce a complete one. The
 * symptom is not a Postgres parse error — it is a `JSON.parse` failure on an
 * empty string, thrown from inside the WebAssembly glue, which reads like a
 * broken migration and is not one.
 *
 * It cost this repository its fourteenth migration before anybody noticed. The
 * shared instance had been fine for thirteen files and quietly stopped being
 * able to parse, and the first thing it took down with it was a migration that
 * had been applied to a database by hand and was being reported as
 * unparseable. Nothing in the failure pointed at the parser.
 *
 * A fresh instance per file costs a few milliseconds, keeps every statement of
 * every migration checked against the real grammar, and — the part that
 * matters — does not depend on how many migrations the project happens to
 * have. The next migration should not be able to break this test.
 */
async function parserForFile(): Promise<PgQueryModule> {
  return new PgQueryModule();
}

/**
 * Split a drizzle migration into its individual statements. drizzle-kit
 * separates statements with a `--> statement-breakpoint` marker; the first
 * chunk of a file may also carry a leading `--` comment block, which Postgres
 * accepts and which we keep so comment syntax is validated too.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Statements with any leading `--` comment lines removed, for pattern matching.
 * The 0004 file opens with a prose block that names `CREATE INDEX` and
 * `ADD CONSTRAINT` in passing; matching against it would report the comment as
 * the first DDL statement and make the ordering assertions meaningless.
 */
function codeStatements(sql: string): string[] {
  return splitStatements(sql).map((statement) =>
    statement
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMigration(name: string): string {
  return readFileSync(path.join(DRIZZLE_DIR, name), 'utf8');
}

const migrationFiles = readdirSync(DRIZZLE_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const BACKLOG_MIGRATION = '0004_chubby_crystal.sql';

/**
 * The journal's `tag` for each entry, read as the migrator reads it.
 *
 * `drizzle-kit migrate` resolves what exists from `_journal.json`, not from the
 * folder: a `.sql` with no entry is not a migration, it is a file. It is never
 * applied, the drift gate cannot see it (that gate compares the journal's
 * watermark against the ledger, so a migration missing from the journal is
 * missing from both sides of its own comparison), and `db:generate` builds the
 * next snapshot from the journal, so the chain quietly forks.
 *
 * That is not hypothetical. `0012_outstanding_flatman.sql` shipped with its
 * snapshot and without its journal entry, and the gate answered "safe to
 * deploy" with it sitting on disk.
 */
const journalEntries = (
  JSON.parse(readFileSync(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
  }
).entries;

describe('every migration on disk is registered in the journal', () => {
  it('reads a journal', () => {
    // The assertions below are all `toEqual([])` against a set difference, and an
    // empty journal makes every one of them vacuously true — including the one
    // that would have caught the missing entry. A guard that reports green
    // because it read nothing is the failure mode the rest of this file exists
    // to avoid.
    expect(journalEntries.length).toBeGreaterThanOrEqual(5);
  });

  it('registers no migration file as an orphan', () => {
    // The direction that bit: a file drizzle will never apply.
    const registered = new Set(journalEntries.map((entry) => `${entry.tag}.sql`));
    expect(migrationFiles.filter((file) => !registered.has(file))).toEqual([]);
  });

  it('registers no journal entry without a file', () => {
    // The other direction, which would make the journal claim a migration whose
    // statements are nowhere — the gate would then wait forever for a file that
    // does not exist.
    const onDisk = new Set(migrationFiles);
    expect(journalEntries.map((entry) => `${entry.tag}.sql`).filter((f) => !onDisk.has(f))).toEqual(
      [],
    );
  });

  it('keeps `when` strictly increasing, so the ledger watermark has an order', () => {
    // `migrate()` applies a migration when the ledger's newest `created_at` is
    // below its `folderMillis`. Two entries sharing a timestamp make that
    // comparison ambiguous, and the order the migrations must run in is exactly
    // what decides whether a foreign key has its table yet.
    for (let i = 1; i < journalEntries.length; i += 1) {
      expect(journalEntries[i].when).toBeGreaterThan(journalEntries[i - 1].when);
    }
  });

  it('numbers entries consecutively from zero', () => {
    // `idx` is what drizzle orders by, and a gap means an entry was removed
    // without the file it named.
    journalEntries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
    });
  });
});

describe('migration SQL parses as PostgreSQL', () => {
  it('finds the migration files', () => {
    // Guards the tests below from silently passing on an empty glob.
    expect(migrationFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(migrationFiles)('parses every statement in %s', async (file) => {
    const statements = splitStatements(readMigration(file));
    expect(statements.length).toBeGreaterThan(0);

    // Fresh per file: see `parserForFile`. An instance shared with the other
    // files can run out of heap, and the failure it produces is an exception
    // from inside the WebAssembly glue rather than a parse error.
    const pgQuery = await parserForFile();

    const errors: string[] = [];
    for (const statement of statements) {
      const result = pgQuery.parse(statement);
      if (result.error) {
        errors.push(`${result.error.message}\n--- statement ---\n${statement.slice(0, 200)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('rejects a deliberately broken statement, so the parser is actually load-bearing', async () => {
    // If the parser silently accepted everything the checks above would be
    // worthless. Prove it discriminates.
    //
    // On its own instance, and for the same reason as above: an instance that
    // has already failed cannot be trusted to report the next failure, and a
    // poisoned parser fails with an exception rather than with a verdict.
    const pgQuery = await parserForFile();
    const broken = pgQuery.parse('CREATE TABEL "t" (;');
    expect(broken.error).toBeTruthy();
  });
});

describe(`${BACKLOG_MIGRATION} closes the schema backlog`, () => {
  const sql = readMigration(BACKLOG_MIGRATION);

  const tablesCreated = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);

  it('creates the two tables that were missing from every migration', () => {
    // These are declared in schema.ts and were read by the communication
    // worker, but existed in no migration and do not exist in the live
    // database. A prior hand-edit deleted exactly these two statements.
    expect(tablesCreated).toContain('message_log');
    expect(tablesCreated).toContain('whatsapp_templates');
  });

  it('creates the wallet tables and the member code column', () => {
    expect(tablesCreated).toContain('tenant_wallet_programs');
    expect(tablesCreated).toContain('customer_wallet_passes');
    expect(sql).toContain('ALTER TABLE "customers" ADD COLUMN "member_code" text;');
  });

  it('creates every index the schema declares', () => {
    // The real anti-drift guard, and the one that would have caught the
    // original bug. Every index built from the Drizzle schema must have a
    // CREATE INDEX somewhere in the migration history. Before this change zero
    // of them did, because drizzle-kit could not see an index declared outside
    // a table's extra-config callback.
    //
    // Checked across the whole history rather than only 0004, so a future
    // migration that adds an index keeps this test honest instead of forcing
    // every new index into the latest file.
    const history = migrationFiles.map(readMigration).join('\n');
    const inHistory = [...history.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)].map(
      (match) => match[1],
    );
    const declared = allIndexes.map((index) => index.config.name);
    expect(declared.length).toBeGreaterThan(0);
    expect(inHistory.slice().sort()).toEqual(declared.slice().sort());
  });

  it('builds the metadata index as a real GIN index', () => {
    expect(sql).toContain(
      'CREATE INDEX "idx_customers_metadata" ON "customers" USING gin ("metadata");',
    );
  });

  it('keeps the phone index partial', () => {
    expect(sql).toContain(
      'CREATE INDEX "idx_customers_phone" ON "customers" USING btree ("business_id","phone") WHERE phone IS NOT NULL;',
    );
  });

  it('keeps the auto-grant and member-code indexes partial', () => {
    expect(sql).toContain(
      'CREATE INDEX "idx_rewards_auto_grant" ON "rewards" USING btree ("business_id","auto_grant_threshold") WHERE auto_grant_threshold IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "uq_customers_business_member_code" ON "customers" USING btree ("business_id","member_code") WHERE member_code IS NOT NULL;',
    );
  });

  it('creates every table before any index or constraint that references it', () => {
    // The ordering that the earlier hand-edit destroyed. Position is what
    // matters here, so this reads the statements in order rather than the text.
    const statements = codeStatements(sql);
    const positionOf = (pattern: RegExp) => {
      const index = statements.findIndex((statement) => pattern.test(statement));
      expect(index, `no statement matched ${pattern}`).toBeGreaterThanOrEqual(0);
      return index;
    };

    const lastCreateTable = Math.max(
      ...tablesCreated.map((table) => positionOf(new RegExp(`CREATE TABLE "${table}"`))),
    );
    const lastAlter = Math.max(
      positionOf(/ALTER TABLE "customers" ADD COLUMN "member_code"/),
      ...[...sql.matchAll(/ADD CONSTRAINT "[\w]+" FOREIGN KEY/g)].map((match) =>
        positionOf(new RegExp(escapeRegExp(match[0]))),
      ),
    );
    const firstIndex = positionOf(/CREATE (?:UNIQUE )?INDEX/);

    expect(lastCreateTable).toBeLessThan(lastAlter);
    expect(lastAlter).toBeLessThan(firstIndex);

    // Specifically: the two restored tables exist before the indexes that
    // target them, not merely "somewhere in the file".
    expect(positionOf(/CREATE TABLE "message_log"/)).toBeLessThan(
      positionOf(/CREATE INDEX "idx_message_log_customer"/),
    );
    expect(positionOf(/CREATE TABLE "whatsapp_templates"/)).toBeLessThan(
      positionOf(/CREATE INDEX "idx_whatsapp_templates_name"/),
    );
    // And the member code column exists before the unique index over it.
    expect(positionOf(/ADD COLUMN "member_code"/)).toBeLessThan(
      positionOf(/CREATE UNIQUE INDEX "uq_customers_business_member_code"/),
    );
  });

  it('does not enable row-level security', () => {
    // A guard, not a style preference. Enabling RLS from a migration would
    // apply tenant isolation to every table in one shot, and the workers do not
    // set the session context on every code path. This must stay a separate,
    // reviewed rollout.
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
  });
});

// ---------------------------------------------------------------------------
// The pass-inactivity window's migration
// ---------------------------------------------------------------------------

const INACTIVITY_MIGRATION = '0009_worried_onslaught.sql';

describe(`${INACTIVITY_MIGRATION} adds the pass inactivity window`, () => {
  const sql = readMigration(INACTIVITY_MIGRATION);

  it('is a single column addition and nothing else', () => {
    // One migration, one statement, one column. If this file ever grows a second
    // statement the review that approved it no longer covers what will run, and
    // the whole point of leaving it on disk unapplied is that a person applies it
    // having read it.
    const statements = codeStatements(sql);
    expect(statements).toEqual([
      'ALTER TABLE "tenant_wallet_programs" ADD COLUMN "pass_inactivity_months" integer;',
    ]);
  });

  it('adds the column nullable, with no default', () => {
    // The load-bearing property of the whole feature, asserted on the SQL rather
    // than only on the Drizzle definition — because the SQL is what a person runs.
    //
    // `NULL` is what an unconfigured tenant has, and it means "the rule is off".
    // A `NOT NULL` would have made the migration fail on every existing row that
    // does not have a value yet. A `DEFAULT 6` would have made it succeed and
    // then, on the first run of the rule, moved every existing tenant's customers'
    // cards into Google's "Expired passes" section — opt-out by default, which is
    // not opt-in.
    expect(sql).not.toMatch(/pass_inactivity_months[^;]*NOT NULL/i);
    expect(sql).not.toMatch(/pass_inactivity_months[^;]*DEFAULT/i);
    expect(sql).not.toMatch(/pass_inactivity_months[^;]*PRIMARY KEY/i);
  });

  it('adds no index, so the index registry stays exact', () => {
    // The rule's only query is answered by the existing
    // `idx_points_balance (business_id, customer_id, created_at DESC)`, whose
    // leading columns are the two equality predicates of that query. A second
    // index would be a second thing to keep correct and to prove is still the
    // right one; see `idxPointsBalance` below for the test that guards the shape
    // the query depends on.
    expect(sql).not.toMatch(/CREATE (?:UNIQUE )?INDEX/i);
  });

  it('does not touch points_expiry_days', () => {
    // `loyalty_programs.points_expiry_days` is a different rule with a similar
    // name: it is about how long a *balance* survives, in days, and it is about
    // points going up. This one is about how long a *customer* is away, in
    // calendar months, and a redemption is activity for it. Repurposing the
    // existing column would silently reinterpret a value a merchant may already
    // have set for a different purpose and get their customers' cards muted
    // instead. Pinned here so the decision cannot be quietly undone.
    // On the DDL, not on the prose: this file explains at length why the existing
    // column was not reused, and a comment that names it is the point.
    // \ strips comment lines for exactly this reason — see the
    // helper's own comment and the 0004 ordering assertions below.
    const ddl = codeStatements(sql).join('\n');
    expect(ddl).not.toMatch(/points_expiry_days/i);
    expect(ddl).not.toMatch(/loyalty_programs/i);
  });
});

describe('the pass inactivity window in the schema', () => {
  it('is declared on tenantWalletPrograms, not on loyaltyPrograms', () => {
    // It is a wallet behaviour switch, and `demo_mode` next to it is the
    // precedent: per-tenant policy about what the wallet worker may do to a
    // merchant's passes belongs with the merchant's wallet program row.
    const columns = getTableConfig(tenantWalletPrograms).columns.map((c) => c.name);
    expect(columns).toContain('pass_inactivity_months');

    const growthColumns = getTableConfig(loyaltyPrograms).columns.map((c) => c.name);
    expect(growthColumns).not.toContain('pass_inactivity_months');
    // And the column it must never be confused with is still there, still
    // separate, and still untouched.
    expect(growthColumns).toContain('points_expiry_days');
  });

  it('is nullable with no default in the Drizzle definition', () => {
    // The same two properties as on the SQL, asserted at the layer a code change
    // would touch. A `.notNull()` or a `.default(...)` added here would silently
    // re-arm the feature the migration deliberately leaves off.
    const column = getTableConfig(tenantWalletPrograms).columns.find(
      (c) => c.name === 'pass_inactivity_months',
    );

    expect(column).toBeDefined();
    expect(column!.notNull).toBe(false);
    expect(column!.hasDefault).toBe(false);
    // `integer`, so a fractional month cannot be written through the type either.
    expect(column!.getSQLType()).toBe('integer');
  });
});

describe('idx_points_balance, the index the inactivity query depends on', () => {
  it('leads with the two equality predicates and orders created_at descending', () => {
    // `findInactivePassCandidates` asks, once per pass, for the newest ledger row
    // belonging to `(business_id, customer_id)`. That is this index's column list
    // exactly, and the `DESC` is what makes the newest row the first entry the
    // planner reaches — so a customer with recent activity is refuted by the very
    // first index entry instead of by a scan.
    //
    // This assertion exists so that a future change to the index turns into a
    // failing test here rather than into a full scan on a rule that decides which
    // real customers get their cards muted. The order is load-bearing: Postgres
    // will not use a `(business_id, customer_id)` index for a `max(created_at)`
    // lookup as cheaply when the timestamp is ascending and unconstrained.
    const index = indexByName('idx_points_balance');
    const dialect = new PgDialect();

    // Rendered through the real dialect rather than read off the builder, so the
    // assertion is on the SQL a planner sees and not on Drizzle's internal shape.
    const rendered = index.config.columns.map((column) => {
      const query = dialect.sqlToQuery(column as never);
      return { text: query.sql, descending: /\bdesc\b/i.test(query.sql) };
    });

    // Three columns, in this order, on this table. The table is asserted rather
    // than assumed: an index moved onto another table would still have the right
    // column names and would answer nothing.
    expect(rendered.map((c) => c.text)).toEqual([
      '"points_transactions"."business_id"',
      '"points_transactions"."customer_id"',
      '"points_transactions"."created_at" DESC',
    ]);
    // The timestamp is the only descending column, and it is last — which is what
    // makes "the newest row for this customer" the first entry the planner reaches.
    expect(rendered.filter((c) => c.descending).map((c) => c.text)).toEqual([
      '"points_transactions"."created_at" DESC',
    ]);
  });

  it('is still the only index on points_transactions', () => {
    // One statement per candidate, one index probe per pass. A second index on
    // the same table for the same query would mean two plans and no way to tell
    // which one a given deployment chose.
    const indexes = getTableConfig(pointsTransactions).indexes.map((i) => i.config.name);
    expect(indexes).toEqual(['idx_points_balance']);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import PgQueryModule from 'pg-query-emscripten';
import { beforeAll, describe, expect, it } from 'vitest';

import { allIndexes } from './indexes';

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
//     appear in a migration, and the 0004 dependency ordering is asserted
//     explicitly.
//   - It does not check the `_journal.json` bookkeeping beyond the file list.
//
// A real acceptance run is still required against a scratch database before
// this touches a shared one.
// ---------------------------------------------------------------------------

const DRIZZLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

let pgQuery: PgQueryModule;

beforeAll(async () => {
  pgQuery = await new PgQueryModule();
});

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

describe('migration SQL parses as PostgreSQL', () => {
  it('finds the migration files', () => {
    // Guards the tests below from silently passing on an empty glob.
    expect(migrationFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(migrationFiles)('parses every statement in %s', (file) => {
    const statements = splitStatements(readMigration(file));
    expect(statements.length).toBeGreaterThan(0);

    const errors: string[] = [];
    for (const statement of statements) {
      const result = pgQuery.parse(statement);
      if (result.error) {
        errors.push(`${result.error.message}\n--- statement ---\n${statement.slice(0, 200)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('rejects a deliberately broken statement, so the parser is actually load-bearing', () => {
    // If the parser silently accepted everything the checks above would be
    // worthless. Prove it discriminates.
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

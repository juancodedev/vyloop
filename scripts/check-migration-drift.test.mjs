// Migration drift gate — tests.
//
// Written before the implementation (RED first) and verified again by reverting
// each guard.
//
// ## Why the expectations here are hand-written
//
// A test that computes what to expect with the same function the gate uses is a
// tautology: it passes when the gate is wrong in exactly the way the test is
// wrong. Every expectation below is therefore a literal — a journal, a set of
// migration rows, an expected verdict — written out by hand from the migrator's
// source rather than derived from the code under test.
//
// The one place the tests do not hand-write the answer is
// `migrationsMigratorWouldApply`, and there the oracle is drizzle's own
// `PgDialect.migrate` driven with a fake session (see "the real migrator is the
// oracle" below). That test cannot be circular because the thing it compares
// against is the upstream implementation, not a restatement of it.
//
// ## The real migrator is the oracle
//
// `drizzle-kit migrate` -> `drizzle-orm/node-postgres/migrator` ->
// `readMigrationFiles()` + `PgDialect.migrate()`. That last function is the only
// thing that decides what a migration run would do, so the differential test
// drives it directly and asserts the gate reaches the same answer. If a
// drizzle upgrade ever changes the comparison, that test fails here rather than
// the gate quietly testing the wrong property.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import {
  extractAssertions,
  serializeBaseline,
  parseBaseline,
  validateBaseline,
  computeDrift,
  computeWatermark,
  migrationsMigratorWouldApply,
  runGate,
  formatReport,
  loadMigrations,
  BASELINE_PATH,
  MIGRATIONS_FOLDER,
} from './check-migration-drift.mjs';

// ---------------------------------------------------------------------------
// Fixtures — literals, written by hand
// ---------------------------------------------------------------------------

/** sha256 of a SQL body, which is what `readMigrationFiles` stores as `hash`. */
const sha256 = (sql) => createHash('sha256').update(sql).digest('hex');

const M0_SQL = 'CREATE TABLE "alpha" ("id" uuid PRIMARY KEY NOT NULL);';
const M1_SQL = 'ALTER TABLE "alpha" ADD COLUMN "label" text;';
const M2_SQL = 'CREATE INDEX "idx_alpha_label" ON "alpha" USING btree ("label");';

// A three-migration repo. `when` values ascend, as every real drizzle journal
// does — drizzle stamps them from the clock as migrations are generated.
const M0 = { tag: '0000_alpha', when: 1000, hash: sha256(M0_SQL), sql: M0_SQL };
const M1 = { tag: '0001_label', when: 2000, hash: sha256(M1_SQL), sql: M1_SQL };
const M2 = { tag: '0002_idx', when: 3000, hash: sha256(M2_SQL), sql: M2_SQL };

/** The journal row drizzle writes when it applies a migration itself. */
const applied = (m, id) => ({ id, hash: m.hash, created_at: m.when });

/** Only migrations 0000 and 0001 are registered — 0002 is missing. */
const ROWS_UP_TO_0001 = [applied(M0, 1), applied(M1, 2)];

/** Everything registered. */
const ROWS_COMPLETE = [applied(M0, 1), applied(M1, 2), applied(M2, 3)];

/** A baseline covering the one migration the journal fails to record. */
const BASELINE_COVERING_0002 = {
  version: 1,
  migrations: [
    {
      tag: M2.tag,
      when: M2.when,
      hash: M2.hash,
      evidence: [{ kind: 'index', name: 'idx_alpha_label' }],
    },
  ],
};

/**
 * Schema facts for the baseline above. A baseline entry is only trusted if the
 * live schema still shows what the entry claims, so the fixture has to carry
 * them.
 */
const FACTS_WITH_0002 = {
  tables: new Set(['alpha']),
  columns: new Set(['alpha.label']),
  indexes: new Set(['idx_alpha_label']),
  constraints: new Set(),
};

/** A database that answered. */
const seen = (rows, facts = FACTS_WITH_0002) => ({ reachable: true, rows, facts });

/** A database that did not. */
const unreachable = (error = 'connect ECONNREFUSED') => ({ reachable: false, error });

// ---------------------------------------------------------------------------
// computeWatermark — the migrator's `order by created_at desc limit 1`
// ---------------------------------------------------------------------------

describe('computeWatermark', () => {
  it('is null when the table has no rows, which is what makes drizzle apply everything', () => {
    expect(computeWatermark([])).toBe(null);
  });

  it('is the maximum created_at, not the first or the last row', () => {
    const rows = [applied(M0, 1), applied(M1, 2), applied(M2, 3)];
    expect(computeWatermark(rows)).toBe(3000);
  });

  it('ignores row order, because the query is ordered by created_at desc', () => {
    const rows = [applied(M2, 3), applied(M0, 1), applied(M1, 2)];
    expect(computeWatermark(rows)).toBe(3000);
  });

  it('reads created_at as a number, not lexically: "900" < "1000" numerically', () => {
    // drizzle stores `when` as a bigint and compares with Number(). Comparing the
    // strings would put "900" after "1000" and produce a plausible wrong answer.
    const rows = [
      { id: 1, hash: 'x', created_at: 1000 },
      { id: 2, hash: 'y', created_at: 900 },
    ];
    expect(computeWatermark(rows)).toBe(1000);
  });

  it('coerces a bigint column returned as a string', () => {
    expect(computeWatermark([{ id: 1, hash: 'x', created_at: '1000' }])).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// migrationsMigratorWouldApply — the comparison, exactly as drizzle makes it
// ---------------------------------------------------------------------------

describe('migrationsMigratorWouldApply', () => {
  it('applies every migration when the table is empty', () => {
    expect(migrationsMigratorWouldApply([M0, M1, M2], []).map((m) => m.tag)).toEqual([
      M0.tag,
      M1.tag,
      M2.tag,
    ]);
  });

  it('applies nothing when the watermark is the newest migration', () => {
    expect(migrationsMigratorWouldApply([M0, M1, M2], ROWS_COMPLETE)).toEqual([]);
  });

  it('applies exactly the migrations above the watermark', () => {
    expect(migrationsMigratorWouldApply([M0, M1, M2], ROWS_UP_TO_0001).map((m) => m.tag)).toEqual([
      M2.tag,
    ]);
  });

  it('is a strict inequality: a row at the same created_at counts as applied', () => {
    // `Number(lastDbMigration.created_at) < migration.folderMillis` — a migration
    // whose `when` equals the watermark is NOT re-applied.
    const rows = [{ id: 1, hash: M1.hash, created_at: 2000 }];
    expect(migrationsMigratorWouldApply([M0, M1, M2], rows).map((m) => m.tag)).toEqual([M2.tag]);
  });

  it('does not look at hash, id, or row count', () => {
    // Four rows whose hashes all belong to M0, and ids that are 1..4. drizzle
    // reads only max(created_at), so only M2 is pending.
    const rows = [
      { id: 1, hash: M0.hash, created_at: 1000 },
      { id: 2, hash: M0.hash, created_at: 1000 },
      { id: 3, hash: M0.hash, created_at: 1000 },
      { id: 4, hash: M0.hash, created_at: 1000 },
    ];
    expect(migrationsMigratorWouldApply([M0, M1, M2], rows).map((m) => m.tag)).toEqual([
      M1.tag,
      M2.tag,
    ]);
  });

  it('treats a hash drizzle never wrote as irrelevant to the pending set', () => {
    // This is the case that makes comparing by `id` look plausible and be wrong:
    // the row count matches the repo, and the ids run 1..3, but the watermark is
    // still 1000 so drizzle would re-apply 0001 and 0002.
    const rows = [
      { id: 1, hash: 'not-a-drizzle-hash', created_at: 1000 },
      { id: 2, hash: 'not-a-drizzle-hash', created_at: 1000 },
      { id: 3, hash: 'not-a-drizzle-hash', created_at: 1000 },
    ];
    expect(migrationsMigratorWouldApply([M0, M1, M2], rows).map((m) => m.tag)).toEqual([
      M1.tag,
      M2.tag,
    ]);
  });
});

describe('the real migrator is the oracle', () => {
  /**
   * A faithful stand-in for drizzle's session.
   *
   * `all()` must return the single row `order by created_at desc limit 1` would
   * return. An earlier version of this fake returned every row unsorted, which
   * made the migrator read the *oldest* created_at as the watermark and report
   * 52 statements where 38 were correct. The fake is the thing under suspicion
   * here, not drizzle.
   */
  const fakeSession = (rows) => {
    const executed = [];
    const max = rows.length
      ? rows.reduce((a, b) => (Number(b.created_at) > Number(a.created_at) ? b : a))
      : null;
    return {
      executed,
      session: {
        execute: async () => {},
        all: async () => (max ? [max] : []),
        transaction: async (cb) =>
          cb({
            execute: async () => {
              executed.push(true);
            },
          }),
      },
    };
  };

  const loadDrizzle = () => {
    const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
    // `pg-core/dialect.cjs` is not in drizzle-orm's exports map, so it is
    // resolved by joining onto the directory the exported entry point lives in
    // rather than by a bare specifier.
    const entry = require.resolve('drizzle-orm/migrator');
    const pkg = join(entry, '..');
    return {
      PgDialect: require(join(pkg, 'pg-core/dialect.cjs')).PgDialect,
      readMigrationFiles: require(join(pkg, 'migrator.cjs')).readMigrationFiles,
    };
  };

  /** How many statements the real migrator would send, given these rows. */
  const realExecuteCount = async (migrations, rows) => {
    const { PgDialect, readMigrationFiles } = loadDrizzle();
    // The migrator only ever reads the `sql` and `folderMillis` of each entry.
    const asMigratorSeesThem = migrations.map((m) => ({
      sql: m.sql.split('--> statement-breakpoint'),
      folderMillis: m.when,
      hash: m.hash,
    }));
    const fake = fakeSession(rows);
    await new PgDialect({}).migrate(asMigratorSeesThem, fake.session, {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    return fake.executed.length;
  };

  /** How many the gate predicts: the pending statements plus one insert each. */
  const predicted = (migrations, rows) => {
    const pending = migrationsMigratorWouldApply(migrations, rows);
    return (
      pending.reduce((total, m) => total + m.sql.split('--> statement-breakpoint').length, 0) +
      pending.length
    );
  };

  it('agrees with PgDialect.migrate on an empty journal table', async () => {
    expect(await realExecuteCount([M0, M1, M2], [])).toBe(predicted([M0, M1, M2], []));
  });

  it('agrees with PgDialect.migrate on a partially recorded journal', async () => {
    expect(await realExecuteCount([M0, M1, M2], ROWS_UP_TO_0001)).toBe(
      predicted([M0, M1, M2], ROWS_UP_TO_0001),
    );
  });

  it('agrees with PgDialect.migrate on a complete journal', async () => {
    expect(await realExecuteCount([M0, M1, M2], ROWS_COMPLETE)).toBe(
      predicted([M0, M1, M2], ROWS_COMPLETE),
    );
  });

  it('agrees when rows arrive out of order', async () => {
    const rows = [applied(M2, 3), applied(M0, 1), applied(M1, 2)];
    expect(await realExecuteCount([M0, M1, M2], rows)).toBe(predicted([M0, M1, M2], rows));
  });

  it('agrees when hashes are wrong, which is the production shape', async () => {
    // Rows drizzle never wrote. Only created_at is read, so a wrong hash must not
    // change the answer.
    const rows = [
      { id: 1, hash: 'zzz', created_at: 1000 },
      { id: 2, hash: 'zzz', created_at: 2000 },
    ];
    expect(await realExecuteCount([M0, M1, M2], rows)).toBe(predicted([M0, M1, M2], rows));
  });

  it('runs against the real repository journal, on every fixture row count', async () => {
    // The real nine migrations, so the differential claim is not made only about
    // toy fixtures.
    const { readMigrationFiles } = loadDrizzle();
    const real = loadMigrations(MIGRATIONS_FOLDER);
    expect(readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length).toBe(real.length);

    for (const count of [0, 1, 4, 9]) {
      const rows = real.slice(0, count).map((m, i) => ({
        id: i + 1,
        hash: m.hash,
        created_at: m.when,
      }));
      expect(await realExecuteCount(real, rows)).toBe(predicted(real, rows));
    }
  });
});

// ---------------------------------------------------------------------------
// extractAssertions — what a migration claims about the schema
// ---------------------------------------------------------------------------

describe('extractAssertions', () => {
  it('reads a CREATE TABLE', () => {
    expect(extractAssertions('CREATE TABLE "branches" ("id" uuid);')).toEqual([
      { kind: 'table', name: 'branches' },
    ]);
  });

  it('reads an ALTER TABLE ADD COLUMN', () => {
    expect(extractAssertions('ALTER TABLE "customers" ADD COLUMN "member_code" text;')).toEqual([
      { kind: 'column', name: 'customers.member_code' },
    ]);
  });

  it('reads ADD COLUMN IF NOT EXISTS, which 0005 and 0006 both use', () => {
    expect(extractAssertions('ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;')).toEqual(
      [{ kind: 'column', name: 'users.email' }],
    );
  });

  it('reads a CREATE INDEX and a CREATE UNIQUE INDEX', () => {
    expect(extractAssertions('CREATE INDEX "idx_a" ON "t" USING btree ("x");')).toEqual([
      { kind: 'index', name: 'idx_a' },
    ]);
    expect(extractAssertions('CREATE UNIQUE INDEX "uq_a" ON "t" USING btree ("x");')).toEqual([
      { kind: 'index', name: 'uq_a' },
    ]);
  });

  it('reads an ALTER TABLE ADD CONSTRAINT, which is a named object', () => {
    expect(
      extractAssertions(
        'ALTER TABLE "t" ADD CONSTRAINT "t_a_fk" FOREIGN KEY ("a") REFERENCES "public"."b"("id");',
      ),
    ).toEqual([{ kind: 'constraint', name: 't_a_fk' }]);
  });

  it('reads a table-level CONSTRAINT declared inside CREATE TABLE', () => {
    const sql = 'CREATE TABLE "p" ("a" uuid, "b" uuid, CONSTRAINT "uq_p" UNIQUE("a","b"));';
    expect(extractAssertions(sql)).toEqual([
      { kind: 'table', name: 'p' },
      { kind: 'constraint', name: 'uq_p' },
    ]);
  });

  it('ignores the prose in a comment block that happens to name an object', () => {
    // 0004 opens with a long comment that names `CREATE INDEX "idx_message_log_*"`
    // and `message_log` in passing. Reading the comment would claim objects the
    // statement never creates.
    const sql = [
      '-- Restored here: CREATE INDEX "idx_never_created" ON "nope".',
      '-- message_log and whatsapp_templates were declared in src/schema.ts.',
      'CREATE TABLE "message_log" ("id" uuid);',
    ].join('\n');
    expect(extractAssertions(sql)).toEqual([{ kind: 'table', name: 'message_log' }]);
  });

  it('finds every statement in a multi-statement file', () => {
    const sql = [
      'CREATE TABLE "customer_wallet_passes" ("customer_id" uuid);',
      'ALTER TABLE "customers" ADD COLUMN "member_code" text;',
      'CREATE INDEX "idx_customer_wallet_passes_tenant" ON "customer_wallet_passes" ("tenant_id");',
    ].join('--> statement-breakpoint\n');
    expect(extractAssertions(sql)).toEqual([
      { kind: 'table', name: 'customer_wallet_passes' },
      { kind: 'column', name: 'customers.member_code' },
      { kind: 'index', name: 'idx_customer_wallet_passes_tenant' },
    ]);
  });

  it('deduplicates a name asserted twice', () => {
    const sql = ['CREATE TABLE "t" ("a" uuid);', 'CREATE TABLE "t" ("a" uuid);'].join(
      '--> statement-breakpoint\n',
    );
    expect(extractAssertions(sql)).toEqual([{ kind: 'table', name: 't' }]);
  });

  it('refuses a DDL construct it does not understand instead of skipping it', () => {
    // Silently skipping an unrecognised statement would let a migration into the
    // baseline with no evidence attached, which is the "we think it is applied"
    // case this whole mechanism exists to remove.
    expect(() => extractAssertions('DROP TABLE "branches";')).toThrow(/DROP TABLE/);
    expect(() => extractAssertions('ALTER TABLE "t" DROP COLUMN "a";')).toThrow(/DROP COLUMN/);
  });

  it('returns nothing for a statement that creates no named object', () => {
    expect(extractAssertions('CREATE SCHEMA IF NOT EXISTS "extra";')).toEqual([]);
  });
});

describe('extractAssertions over the real migrations', () => {
  const migrations = loadMigrations(MIGRATIONS_FOLDER);

  it('understands every statement in the repository journal', () => {
    // The refusal above is only safe if it never fires on real input.
    for (const m of migrations) {
      expect(() => extractAssertions(m.sql)).not.toThrow();
    }
  });

  it('finds the wallet tables 0004 creates', () => {
    const four = migrations.find((m) => m.tag.startsWith('0004_'));
    const names = extractAssertions(four.sql).map((a) => a.name);
    expect(names).toContain('customer_wallet_passes');
    expect(names).toContain('message_log');
    expect(names).toContain('tenant_wallet_programs');
    expect(names).toContain('whatsapp_templates');
    expect(names).toContain('customers.member_code');
  });

  it('finds the unique index 0006 creates', () => {
    const six = migrations.find((m) => m.tag.startsWith('0006_'));
    expect(extractAssertions(six.sql)).toEqual([{ kind: 'index', name: 'uq_users_email' }]);
  });
});

// ---------------------------------------------------------------------------
// computeDrift
// ---------------------------------------------------------------------------

describe('computeDrift', () => {
  it('reports nothing for a complete journal', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: ROWS_COMPLETE,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.forward).toEqual([]);
    expect(drift.reverse).toEqual([]);
  });

  it('reports the unregistered migration as forward drift', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: ROWS_UP_TO_0001,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.forward.map((m) => m.tag)).toEqual([M2.tag]);
  });

  it('removes a baselined migration from forward drift', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: ROWS_UP_TO_0001,
      baseline: BASELINE_COVERING_0002,
    });
    expect(drift.forward).toEqual([]);
  });

  it('reports a row whose hash matches no migration as reverse drift', () => {
    const rows = [...ROWS_COMPLETE, { id: 4, hash: 'deadbeef', created_at: 9999 }];
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.reverse).toEqual([{ id: 4, hash: 'deadbeef', created_at: 9999 }]);
  });

  it('does not call a row reverse drift when only its id is unknown', () => {
    // `id` is a SERIAL and says nothing about which migration a row is. A test
    // that treated id 99 as unknown would report drift on a healthy database.
    const rows = [{ id: 99, hash: M0.hash, created_at: M0.when }];
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.reverse).toEqual([]);
  });

  it('reports a row whose created_at contradicts the migration it carries', () => {
    // A row claiming migration 0001's hash at 0000's timestamp: the table and the
    // journal disagree about history, which is the lying-journal disease itself.
    const rows = [applied(M0, 1), { id: 2, hash: M1.hash, created_at: M0.when }, applied(M2, 3)];
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.incoherent).toEqual([
      { id: 2, hash: M1.hash, created_at: M0.when, expected: M1.when, tag: M1.tag },
    ]);
  });

  it('does not flag a row whose timestamp is the migration it carries', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: ROWS_COMPLETE,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.incoherent).toEqual([]);
  });

  it('exposes the watermark it decided on', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: ROWS_UP_TO_0001,
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.watermark).toBe(2000);
  });

  it('reports nothing rather than throwing when the table is empty', () => {
    const drift = computeDrift({
      migrations: [M0, M1, M2],
      rows: [],
      baseline: { version: 1, migrations: [] },
    });
    expect(drift.forward).toHaveLength(3);
    expect(drift.watermark).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// validateBaseline — the guards that stop the baseline being satisfied by hand
// ---------------------------------------------------------------------------

describe('validateBaseline', () => {
  const migrations = [M0, M1, M2];

  it('accepts a well-formed baseline', () => {
    expect(validateBaseline(BASELINE_COVERING_0002, migrations).errors).toEqual([]);
  });

  it('rejects an entry for a tag that is not a migration in this repo', () => {
    const baseline = {
      version: 1,
      migrations: [{ tag: '0009_does_not_exist', when: 1, hash: 'x', evidence: [] }],
    };
    const { errors } = validateBaseline(baseline, migrations);
    expect(errors.join(' ')).toMatch(/0009_does_not_exist/);
  });

  it('rejects a duplicated entry', () => {
    const entry = BASELINE_COVERING_0002.migrations[0];
    const { errors } = validateBaseline(
      { version: 1, migrations: [entry, { ...entry }] },
      migrations,
    );
    expect(errors.join(' ')).toMatch(/duplicat/i);
  });

  it('rejects entries that are not in journal order', () => {
    const two = {
      version: 1,
      migrations: [
        { tag: M2.tag, when: M2.when, hash: M2.hash, evidence: [{ kind: 'index', name: 'i' }] },
        { tag: M1.tag, when: M1.when, hash: M1.hash, evidence: [{ kind: 'column', name: 'a.b' }] },
      ],
    };
    const { errors } = validateBaseline(two, migrations);
    expect(errors.join(' ')).toMatch(/order/i);
  });

  it('rejects an entry whose hash does not match the migration file', () => {
    // The hash is what ties a baseline entry to the exact SQL it claims. If the
    // SQL is later edited, the entry must stop being trusted.
    const baseline = {
      version: 1,
      migrations: [{ ...BASELINE_COVERING_0002.migrations[0], hash: 'stale' }],
    };
    const { errors } = validateBaseline(baseline, migrations);
    expect(errors.join(' ')).toMatch(/hash/i);
  });

  it('rejects an entry whose `when` does not match the journal', () => {
    const baseline = {
      version: 1,
      migrations: [{ ...BASELINE_COVERING_0002.migrations[0], when: 42 }],
    };
    const { errors } = validateBaseline(baseline, migrations);
    expect(errors.join(' ')).toMatch(/when/i);
  });

  it('rejects evidence that the migration file does not actually produce', () => {
    // This is what makes the evidence field non-decorative: it has to be exactly
    // what extractAssertions returns for that file, so it cannot be written by
    // hand to make a gate pass.
    const baseline = {
      version: 1,
      migrations: [
        {
          ...BASELINE_COVERING_0002.migrations[0],
          evidence: [{ kind: 'table', name: 'invented_table' }],
        },
      ],
    };
    const { errors } = validateBaseline(baseline, migrations);
    expect(errors.join(' ')).toMatch(/evidence/i);
  });

  it('rejects an unknown format version', () => {
    const { errors } = validateBaseline({ version: 99, migrations: [] }, migrations);
    expect(errors.join(' ')).toMatch(/version/i);
  });

  it('rejects a missing migrations array', () => {
    const { errors } = validateBaseline({ version: 1 }, migrations);
    expect(errors.join(' ')).toMatch(/migrations/i);
  });

  it('accepts an empty baseline as structurally valid', () => {
    // An empty baseline is well-formed. Whether it is *adequate* is a different
    // question, answered by runGate, and conflating the two would mean an empty
    // baseline produced a confusing parse error instead of a clear drift report.
    expect(validateBaseline({ version: 1, migrations: [] }, migrations).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serializeBaseline / parseBaseline — determinism and the round trip
// ---------------------------------------------------------------------------

describe('serializeBaseline', () => {
  it('is byte-for-byte identical for the same input', () => {
    const a = serializeBaseline(BASELINE_COVERING_0002);
    const b = serializeBaseline(structuredClone(BASELINE_COVERING_0002));
    expect(a).toBe(b);
  });

  it('is byte-for-byte identical regardless of the order entries were built in', () => {
    const entry = BASELINE_COVERING_0002.migrations[0];
    const forwards = serializeBaseline({ version: 1, migrations: [entry] });
    const backwards = serializeBaseline({ version: 1, migrations: [{ ...entry }] });
    expect(forwards).toBe(backwards);
  });

  it('contains no timestamp of its own, so two runs a week apart match', () => {
    const text = serializeBaseline(BASELINE_COVERING_0002);
    // A generated-at field would make every regeneration a diff.
    expect(text).not.toMatch(/generatedAt/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('sorts migrations by `when` so the order is fixed', () => {
    const text = serializeBaseline({
      version: 1,
      migrations: [
        { tag: M2.tag, when: M2.when, hash: M2.hash, evidence: [{ kind: 'index', name: 'i' }] },
        { tag: M1.tag, when: M1.when, hash: M1.hash, evidence: [{ kind: 'column', name: 'a.b' }] },
      ],
    });
    expect(text.indexOf(M1.tag)).toBeLessThan(text.indexOf(M2.tag));
  });

  it('ends with a single trailing newline', () => {
    const text = serializeBaseline(BASELINE_COVERING_0002);
    expect(text.endsWith('}\n')).toBe(true);
  });
});

describe('parseBaseline', () => {
  it('round-trips a serialized baseline', () => {
    const { baseline, errors } = parseBaseline(serializeBaseline(BASELINE_COVERING_0002));
    expect(errors).toEqual([]);
    expect(baseline).toEqual(BASELINE_COVERING_0002);
  });

  it('reports invalid JSON rather than throwing', () => {
    const { errors } = parseBaseline('{ not json');
    expect(errors.join(' ')).toMatch(/json/i);
  });

  it('treats a missing file as an empty baseline, not an error', () => {
    // A fresh checkout with no baseline is normal; it is a gate finding, not a
    // crash. The gate then reports the drift it was hiding.
    const { baseline, errors } = parseBaseline(null);
    expect(errors).toEqual([]);
    expect(baseline).toEqual({ version: 1, migrations: [] });
  });
});

// ---------------------------------------------------------------------------
// runGate — the verdict
// ---------------------------------------------------------------------------

describe('runGate', () => {
  const migrations = [M0, M1, M2];
  const noBaseline = { version: 1, migrations: [] };

  it('passes a database whose journal is complete', () => {
    const gate = runGate({ migrations, observation: seen(ROWS_COMPLETE), baseline: noBaseline });
    expect(gate.ok).toBe(true);
    expect(gate.exitCode).toBe(0);
  });

  it('passes an incomplete journal that the baseline covers — the production case', () => {
    const gate = runGate({
      migrations,
      observation: seen(ROWS_UP_TO_0001),
      baseline: BASELINE_COVERING_0002,
    });
    expect(gate.ok).toBe(true);
    expect(gate.exitCode).toBe(0);
  });

  it('fails an incomplete journal with an empty baseline', () => {
    const gate = runGate({ migrations, observation: seen(ROWS_UP_TO_0001), baseline: noBaseline });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.forward.map((m) => m.tag)).toEqual([M2.tag]);
  });

  it('fails a database holding a row the repo has no migration for', () => {
    const rows = [...ROWS_COMPLETE, { id: 4, hash: 'deadbeef', created_at: 9999 }];
    const gate = runGate({ migrations, observation: seen(rows), baseline: noBaseline });
    expect(gate.ok).toBe(false);
    expect(gate.reverse).toHaveLength(1);
  });

  it('fails an unreachable database instead of reporting unknown', () => {
    const gate = runGate({ migrations, observation: unreachable(), baseline: noBaseline });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.blockedReason).toMatch(/cannot verify/i);
  });

  it('never reports `unknown` — the status does not exist', () => {
    // The readiness report has a third state and this gate must not: a safety
    // interlock that can return "I could not tell" is a gate that lets a deploy
    // through unverified.
    const gate = runGate({ migrations, observation: unreachable(), baseline: noBaseline });
    expect(gate.unknown).toBeUndefined();
  });

  it('fails when a baseline entry is not a migration in this repo', () => {
    const gate = runGate({
      migrations,
      observation: seen(ROWS_UP_TO_0001),
      baseline: {
        version: 1,
        migrations: [{ tag: '0009_ghost', when: 1, hash: 'x', evidence: [] }],
      },
    });
    expect(gate.ok).toBe(false);
    expect(gate.baselineErrors.join(' ')).toMatch(/0009_ghost/);
  });

  it('fails when a baseline entry claims objects the live schema does not have', () => {
    // The whole point of generating the baseline from the schema: an entry that
    // was not earned cannot be used to hide drift, because it gets checked.
    const gate = runGate({
      migrations,
      observation: seen(ROWS_UP_TO_0001, {
        tables: new Set(['alpha']),
        columns: new Set(),
        indexes: new Set(),
        constraints: new Set(),
      }),
      baseline: BASELINE_COVERING_0002,
    });
    expect(gate.ok).toBe(false);
    expect(gate.exitCode).toBe(1);
    expect(gate.unsatisfied).toEqual([
      { tag: M2.tag, missing: [{ kind: 'index', name: 'idx_alpha_label' }] },
    ]);
  });

  it('fails when a baseline entry is already recorded in the journal table', () => {
    // A baseline that covers a migration drizzle already recorded is stale. Left
    // alone it is a permanent exemption, and exemptions that outlive their
    // reason are how a gate stops being one.
    const gate = runGate({
      migrations,
      observation: seen(ROWS_COMPLETE),
      baseline: BASELINE_COVERING_0002,
    });
    expect(gate.ok).toBe(false);
    expect(gate.staleBaseline).toEqual([M2.tag]);
  });

  it('fails when the journal and the table disagree about a migration timestamp', () => {
    const rows = [applied(M0, 1), { id: 2, hash: M1.hash, created_at: M0.when }, applied(M2, 3)];
    const gate = runGate({ migrations, observation: seen(rows), baseline: noBaseline });
    expect(gate.ok).toBe(false);
    expect(gate.incoherent).toHaveLength(1);
  });

  it('collects every finding rather than stopping at the first', () => {
    // An unknown row *below* the watermark: the migrator still sees 0002 as
    // pending, and the row is unknown too. Both directions are reported.
    const rows = [...ROWS_UP_TO_0001, { id: 3, hash: 'deadbeef', created_at: 1500 }];
    const gate = runGate({ migrations, observation: seen(rows), baseline: noBaseline });
    expect(gate.forward.map((m) => m.tag)).toEqual([M2.tag]);
    expect(gate.reverse).toHaveLength(1);
  });

  it('still catches an unknown row that claims a watermark above every migration', () => {
    // This one is worth spelling out. A row with created_at 9999 moves the
    // watermark past every migration, so the migrator believes it has applied
    // all of them and `migrate()` would run nothing — real, unapplied schema
    // included. Forward drift is silent here by construction, because forward
    // drift is defined as what the migrator would do, and the answer is
    // "nothing".
    //
    // It is caught anyway, and only because reverse drift is keyed on `hash`
    // rather than on `created_at`: no migration in this repository hashes to
    // `deadbeef`, so the row is reported no matter how plausible its timestamp
    // is. A gate that had compared timestamps here would have passed this.
    const rows = [...ROWS_UP_TO_0001, { id: 3, hash: 'deadbeef', created_at: 9999 }];
    const gate = runGate({ migrations, observation: seen(rows), baseline: noBaseline });
    expect(gate.forward).toEqual([]);
    expect(gate.reverse).toEqual([{ id: 3, hash: 'deadbeef', created_at: 9999 }]);
    expect(gate.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  const migrations = [M0, M1, M2];

  it('says the deployment is blocked, with no third state', () => {
    const text = formatReport(
      runGate({
        migrations,
        observation: seen(ROWS_UP_TO_0001),
        baseline: { version: 1, migrations: [] },
      }),
    );
    expect(text).toMatch(/BLOCK/);
    expect(text).not.toMatch(/UNKNOWN/);
  });

  it('names the database it could not reach, so the fix is actionable', () => {
    const text = formatReport(
      runGate({
        migrations,
        observation: unreachable('timeout'),
        baseline: { version: 1, migrations: [] },
      }),
    );
    expect(text).toMatch(/timeout/);
  });

  it('shows what the migrator itself would have applied', () => {
    const text = formatReport(
      runGate({
        migrations,
        observation: seen(ROWS_UP_TO_0001),
        baseline: { version: 1, migrations: [] },
      }),
    );
    expect(text).toMatch(/0002_idx/);
  });

  it('passes cleanly when there is no drift', () => {
    const text = formatReport(
      runGate({
        migrations,
        observation: seen(ROWS_COMPLETE),
        baseline: { version: 1, migrations: [] },
      }),
    );
    expect(text).toMatch(/PASS/);
  });
});

// ---------------------------------------------------------------------------
// The committed baseline
// ---------------------------------------------------------------------------
//
// What is committed is whatever inspection proved, and nothing else. As of this
// branch that is the development database, whose only out-of-band migration is
// 0006 — 0004 is *partially* applied there (25 of its 26 objects, missing
// `uq_customer_wallet_passes_tenant_object`) and 0005, 0007 and 0008 are not
// applied at all, so the "every asserted object must be present" rule correctly
// refuses all four.
//
// Production cannot be inspected from this repository: its `DATABASE_URL` exists
// only as a GitHub Actions secret, there is no second host in any local
// `.dev.vars`, and no `CLOUDFLARE_API_TOKEN` is present to read one. So the
// tests below state three separate things and do not blur them:
//
//   - the committed file is well-formed, deterministic and non-empty;
//   - a baseline covering the *documented* production drift would clear the gate
//     against the *documented* production shape (a simulation, labelled as one);
//   - the committed file does NOT clear that production shape, and names exactly
//     which migrations are still unaccounted for.
//
// The third one is the disclosure, written as an assertion so it cannot quietly
// stop being true.

describe('the committed baseline', () => {
  const migrations = loadMigrations(MIGRATIONS_FOLDER);
  const committed = readFileSync(BASELINE_PATH, 'utf8');
  const { baseline } = parseBaseline(committed);

  /** The production shape as reported by the maintainer: 0000-0003 recorded. */
  const PRODUCTION_REGISTERED = migrations
    .slice(0, 4)
    .map((m, i) => ({ id: i + 1, hash: m.hash, created_at: m.when }));

  const FACT_SET = {
    table: 'tables',
    column: 'columns',
    index: 'indexes',
    constraint: 'constraints',
  };

  const factsFor = (entries) => {
    const facts = {
      tables: new Set(),
      columns: new Set(),
      indexes: new Set(),
      constraints: new Set(),
    };
    for (const entry of entries) {
      for (const item of entry.evidence) facts[FACT_SET[item.kind]].add(item.name);
    }
    return facts;
  };

  /** A baseline entry built from the real migration file, as the generator would. */
  const entryFor = (migration) => ({
    tag: migration.tag,
    when: migration.when,
    hash: migration.hash,
    evidence: extractAssertions(migration.sql),
  });

  it('is valid against the current journal', () => {
    expect(parseBaseline(committed).errors).toEqual([]);
    expect(validateBaseline(baseline, migrations).errors).toEqual([]);
  });

  it('is exactly what serializeBaseline produces for it, so the format is fixed', () => {
    // A baseline whose committed bytes differ from its own serialisation cannot
    // be compared against a freshly derived one, which is what makes
    // `--check-baseline` a real check rather than a diff of two arbitrary texts.
    expect(serializeBaseline(baseline)).toBe(committed);
  });

  it('is not empty', () => {
    // A gate satisfiable by an empty baseline is not a gate. Development has an
    // out-of-band migration, so an empty file here means someone deleted the
    // evidence rather than that there was none.
    expect(baseline.migrations.length).toBeGreaterThan(0);
  });

  it('claims exactly the migrations production was verified to have applied', () => {
    // This baseline used to be derived from the development schema, and it could
    // only account for 0006 — production was reported to hold 0004-0008 unregistered
    // and only development had ever been inspected. It is now derived from
    // production itself, so the assertion changed shape: not "0004 is refused"
    // but "exactly these five, and nothing else".
    //
    // The invariant is the same strength: every tag here had its objects found in
    // the live catalog, and a sixth would mean an entry nobody inspected. 0000-0003
    // are registered in the journal, so they are not out of band and must stay out.
    const tags = baseline.migrations.map((entry) => entry.tag);
    expect(tags).toEqual([
      '0004_chubby_crystal',
      '0005_wallet_demo_mode',
      '0006_users_email_unique',
      '0007_loyalty_promo_copy',
      '0008_loud_vector',
    ]);
    expect(baseline.migrations.filter((e) => e.tag.startsWith('0000')).length).toBe(0);
  });

  it('pins an object per migration, so no entry is a bare claim', () => {
    // 0004 is 26 objects, 0008 is four, 0005/0006/0007 are one each. A tag with no
    // evidence would be exactly the "escribamos a mano" the baseline exists to
    // refuse.
    for (const entry of baseline.migrations) {
      expect(entry.evidence.length, `${entry.tag} claims no objects`).toBeGreaterThan(0);
    }
  });

  it('is rejected by the gate if the schema it claims is not really there', () => {
    // Same committed file, same production-shaped rows, but an empty schema. If
    // this passed, the baseline would be a rubber stamp and could be used to hide
    // any drift at all.
    const empty = {
      tables: new Set(),
      columns: new Set(),
      indexes: new Set(),
      constraints: new Set(),
    };
    const gate = runGate({
      migrations,
      observation: seen(PRODUCTION_REGISTERED, empty),
      baseline,
    });
    expect(gate.ok).toBe(false);
    // Every one of the five, not just the one this used to claim. The guard got
    // stronger when the baseline got real: a single absent object is now enough,
    // and there are five claims to be absent from.
    expect(gate.unsatisfied.map((e) => e.tag)).toEqual(baseline.migrations.map((e) => e.tag));
  });

  it('is rejected by the gate if the journal no longer needs it', () => {
    // Everything recorded. A baseline still claiming a migration is missing from
    // the table is stale, and must fail rather than sit there as a permanent
    // exemption.
    const all = migrations.map((m, i) => ({ id: i + 1, hash: m.hash, created_at: m.when }));
    const gate = runGate({
      migrations,
      observation: seen(all, factsFor(baseline.migrations)),
      baseline,
    });
    expect(gate.ok).toBe(false);
    expect(gate.staleBaseline.length).toBeGreaterThan(0);
  });

  it('clears the verified production state — the disclosure this replaces', () => {
    // This test used to assert the opposite, and that inversion is the point.
    //
    // It read: production holds 0004-0008 unregistered, the committed baseline only
    // accounted for 0006, so the gate names four it cannot vouch for. The first CI
    // against production was therefore expected to fail, and it did — the deploy
    // after #173 was blocked at `migration-drift` with every publish skipped.
    //
    // What resolved it was not a change of heart. 0004 turned out to be applied
    // 25 objects out of 26 — `uq_customer_wallet_passes_tenant_object` was missing —
    // that index was created, and the baseline was re-derived from production
    // itself. 0004 then had all 26 and belonged in it.
    //
    // So the honest assertion now is that the committed baseline does clear the
    // verified state — and, below, that it stops clearing the moment production
    // diverges from one single object it claims.
    const gate = runGate({
      migrations,
      observation: seen(PRODUCTION_REGISTERED, factsFor(baseline.migrations)),
      baseline,
    });
    expect(gate.forward).toEqual([]);
    expect(gate.reverse).toEqual([]);
    expect(gate.unsatisfied).toEqual([]);
    expect(gate.staleBaseline).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.exitCode).toBe(0);
  });

  it('stops clearing the moment production is missing one claimed object', () => {
    // The anti-rubber-stamp guard, now per-object rather than all-or-nothing. The
    // whole value of a baseline derived from production evaporates if it also
    // passes when production is not what the baseline says it is — so one absent
    // object out of 0004's 26 must be enough to block.
    for (const entry of baseline.migrations) {
      for (const claimed of entry.evidence) {
        const facts = factsFor(baseline.migrations);
        facts[FACT_SET[claimed.kind]].delete(claimed.name);

        const gate = runGate({
          migrations,
          observation: seen(PRODUCTION_REGISTERED, facts),
          baseline,
        });
        expect(gate.ok, `${claimed.name} missing but the gate still passed`).toBe(false);
        expect(gate.unsatisfied.map((e) => e.tag)).toContain(entry.tag);
      }
    }
  });

  describe('the committed baseline is deterministic and self-consistent', () => {
    // This block used to build a hand-made baseline for the state production was
    // *reported* to have, because that state could not be reached from this
    // repository. It is now the committed baseline, derived from production
    // itself, so the shape of the assertions is the same and the simulated copy is
    // gone — keeping it would have left two descriptions of the same database, one
    // of them fiction, for a future reader to choose between.
    it('is serialised identically on every run', () => {
      expect(serializeBaseline(baseline)).toBe(serializeBaseline(structuredClone(baseline)));
    });

    it('validates against the repository migrations', () => {
      expect(validateBaseline(baseline, migrations).errors).toEqual([]);
    });
  });
});

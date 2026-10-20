// Migration drift gate.
//
// Fails a deploy when the schema of the target database does not match the
// migration journal this repository ships.
//
// Read-only, always. It opens no transaction that writes, issues no DDL and no
// DML, and it never calls `migrate`. That last one is not squeamishness: the
// migrator's own first two statements are `CREATE SCHEMA IF NOT EXISTS` and
// `CREATE TABLE IF NOT EXISTS`, so "just call migrate() to check" would write to
// the very database this exists to protect. The comparison below is a
// reimplementation of that decision, and it is held to the real migrator by a
// differential test rather than by resemblance.
//
// Not part of the shipped test suite: an operational script kept out of `src` so
// it is neither linted nor typechecked as product code.
//
// ---------------------------------------------------------------------------
// What the real migrator actually compares
// ---------------------------------------------------------------------------
//
// `drizzle-kit migrate` (the `db:migrate` script) resolves to
// `drizzle-orm/node-postgres/migrator`, which does exactly two things:
//
//   readMigrationFiles(folder) -> [{ sql: string[], bps, folderMillis, hash }]
//   db.dialect.migrate(migrations, db.session, config)
//
// and for every postgres driver `migrate` is a three-line wrapper over the same
// `PgDialect.migrate` in `drizzle-orm/pg-core/dialect`. That function is short
// and its shape is the whole reason this file is written the way it is:
//
//   const dbMigrations = await session.all(
//     `select id, hash, created_at from drizzle.__drizzle_migrations
//      order by created_at desc limit 1`);
//   const lastDbMigration = dbMigrations[0];
//   for await (const migration of migrations) {
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
//       ... run the statements, insert (hash, folderMillis) ...
//     }
//   }
//
// Four consequences, each one load-bearing here:
//
// 1. **The decision is a scalar watermark.** One row — the maximum
//    `created_at` — is compared against each migration's `folderMillis`, which
//    is the journal's `when`. There is no "walk the list and find the first
//    unapplied". So the gate's question is exactly "would `migrate()` run
//    anything right now?", and `migrationsMigratorWouldApply` is that
//    comparison, term for term.
//
// 2. **`hash` is written and never read.** It appears in the SELECT and in the
//    INSERT and in neither comparison. So the gate cannot use `hash` to decide
//    forward drift — doing so would test something drizzle does not test. It
//    uses `hash` only to *identify* a row, which is the one job hash can do
//    soundly; see (3).
//
// 3. **`id` is `SERIAL PRIMARY KEY` and nothing more.** It is an autoincrement,
//    it is not the journal `idx`, and it starts at 1. Verified against the live
//    dev database: rows for journal entries idx 0..3 carry ids 1..4. A gate that
//    compared by `id` would get a plausible, confident, wrong answer — which is
//    why reverse drift is keyed by `hash`, the sha256 of the migration file's
//    contents that `readMigrationFiles` computes. A hand-inserted row has an
//    arbitrary `created_at` that can collide with any journal entry; its hash
//    cannot be fabricated by accident.
//
// 4. **Row order and row count are irrelevant.** `order by created_at desc
//    limit 1` means only the maximum is read, so four rows in any order read the
//    same as four rows in ascending order, and a count that matches the repo's
//    migration count means nothing at all. Confirmed by driving the real
//    `PgDialect.migrate` with a fake session in the test suite.
//
// Out-of-order journal entries: the loop walks the journal array in order but
// the watermark is read once, before the transaction, so every entry is compared
// against the same frozen scalar and an out-of-order `when` changes nothing
// about which migrations qualify. This repository's `when` values ascend, and
// nothing here depends on that.
//
// ---------------------------------------------------------------------------
// Why there is a baseline
// ---------------------------------------------------------------------------
//
// Production has migrations that were applied without being registered: 0004-0006
// applied as SQL by hand, 0007-0008 applied by hand outright. The journal table
// says otherwise, so `migrate()` would try to apply all five again. Nothing runs
// `db:migrate` on deploy today, which is exactly why the lie survived.
//
// The alternative to a baseline is repairing the journal table — writing to
// production by hand, with hashes whose correspondence to the SQL actually
// applied cannot be established. A gate built on a repaired-by-hand journal would
// be lying in a new way, and would be indistinguishable from a correct one.
//
// So the baseline records what is *verified present in the schema*, and it is
// generated by inspecting the schema, never written by hand. It is pure data —
// `{ version, migrations }` and nothing else — because any prose field would be
// hand-editable and would make the file differ from what the generator produces.
// The rationale lives here instead of in the file.
//
// The format is JSON, co-located with the journal it qualifies. JSON because the
// gate has to read it in CI with no build step, and because the thing under
// scrutiny deserves to be diffable line by line: the whole file is the review.
//
// ---------------------------------------------------------------------------
// Why the baseline cannot be grown to switch the gate off
// ---------------------------------------------------------------------------
//
// Three independent guards, any one of which defeats the obvious attack:
//
// 1. **An entry must be a real migration.** `validateBaseline` rejects a tag that
//    is not in the journal, so `0009_whatever` cannot be invented.
// 2. **An entry's evidence must be what its file produces.** Each entry lists
//    the schema objects its migration creates, and that list must equal
//    `extractAssertions(fileContents)`. Hand-written evidence for a migration
//    that does not create those objects is rejected.
// 3. **An entry is re-verified against the live schema on every run.** This is
//    the one that actually matters, and it is not review, it is arithmetic: an
//    entry claims `idx_wallet_callback_deliveries_received` exists, the gate
//    asks the live catalog, and if it is not there the gate fails. So adding an
//    entry to hide drift requires the objects to genuinely be in the database.
//
// Plus: an entry whose migration the journal *already* records is stale and
// fails. A baseline is an exemption, and an exemption that outlives its reason is
// how an interlock stops being one.
//
// And in CI, `--check-baseline` re-derives the baseline from the live schema and
// compares it byte for byte with the committed file. The versioned baseline is
// therefore, by construction, the one that inspection produced — which is also
// what makes "deriving it from evidence rather than from memory" true rather than
// aspirational.
//
// ---------------------------------------------------------------------------
// Why an unreachable database fails
// ---------------------------------------------------------------------------
//
// This is the deliberate opposite of the wallet readiness report two files over,
// and the asymmetry is the design.
//
// The readiness report asks an informational question about an external service
// and cannot see some of it, so it degrades to `unknown`: reporting "the tables
// are not there" when the truth is "I could not look" would send someone off to
// re-apply a migration that was there all along. Harm is bounded because nothing
// happens automatically on the answer.
//
// This gate is a safety interlock. Its entire value is "I verified the schema
// matches the code". "I could not verify" cannot mean "deploy anyway" — it means
// the one property this gate exists to establish is unestablished, and the code
// about to go out assumes it holds. A gate with a `unknown` state is a gate that
// passes whenever the network has a bad minute, which is to say it passes
// whenever it is most convenient to pass.
//
// So: no third state, no `unknown`, exit 1. There is deliberately no flag to
// soften this, because a flag would be used the first time it was needed and the
// interlock would be advisory from then on. If this blocks a deploy, the fix is
// to make the database reachable from CI — not to make the gate quieter.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { assertVerifiedTls } from './lib/database-url.mjs';

export const MIGRATIONS_FOLDER = 'packages/db/drizzle';
export const JOURNAL_PATH = join(MIGRATIONS_FOLDER, 'meta/_journal.json');
export const BASELINE_PATH = join(MIGRATIONS_FOLDER, 'meta/_applied-outside-drizzle.json');

/**
 * The baseline's format version.
 *
 * Bumped when the shape changes, not when the contents change: a new entry is
 * not a new format. A gate that had to be migrated to keep working during an
 * incident would be a gate nobody could rely on that day.
 */
export const BASELINE_VERSION = 1;

// ---------------------------------------------------------------------------
// Reading the repo
// ---------------------------------------------------------------------------

/**
 * The journal, plus the contents and hash of every file it names.
 *
 * `hash` is `sha256(fileContents)`, computed the way `readMigrationFiles` in
 * `drizzle-orm/migrator` computes it — same bytes, same digest — because that is
 * the value `PgDialect.migrate` writes into `drizzle.__drizzle_migrations`. A
 * hash computed any other way would not match the rows drizzle wrote and every
 * row would look like reverse drift.
 *
 * Throws if the journal names a file that is not there, which is what
 * `readMigrationFiles` does: a journal entry with no SQL is a migration that can
 * never have been applied, and treating it as absent would hide it.
 */
export function loadMigrations(folder = MIGRATIONS_FOLDER) {
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8'));

  return journal.entries.map((entry) => {
    const sql = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256').update(sql).digest('hex'),
      sql,
    };
  });
}

// ---------------------------------------------------------------------------
// What a migration claims about the schema
// ---------------------------------------------------------------------------

/**
 * The named schema objects a migration file creates.
 *
 * This is the evidence the baseline is built from, so the parser is strict by
 * construction: a statement it does not recognise is an error, never a skip. A
 * parser that skipped what it did not understand would let a migration into the
 * baseline with no evidence attached, which is the "we believe it is applied"
 * case the baseline exists to eliminate.
 *
 * Comments are stripped before parsing, and that is not cosmetic. 0004 opens
 * with a long prose block that names `CREATE INDEX "idx_message_log_*"` and
 * `message_log` in passing while explaining that the statements were once
 * deleted by hand; reading the prose would claim objects the file never creates.
 */
export function extractAssertions(sql) {
  const statements = String(sql)
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');

  const found = new Map();
  const add = (kind, name) => found.set(`${kind}:${name}`, { kind, name });

  for (const statement of statements) {
    const createTable = /^CREATE\s+TABLE\s+("?)([\w.]+)\1\s*\(/i.exec(statement);
    if (createTable) {
      add('table', createTable[2]);
      // A named table-level constraint, e.g.
      // `CONSTRAINT "uq_churn_business_customer" UNIQUE("business_id","customer_id")`.
      // Unnamed ones (`"id" uuid PRIMARY KEY`) have no catalog identity to check.
      for (const [, name] of statement.matchAll(/CONSTRAINT\s+"([\w]+)"/gi)) {
        add('constraint', name);
      }
      continue;
    }

    const createIndex =
      /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([\w]+)"?/i.exec(
        statement,
      );
    if (createIndex) {
      add('index', createIndex[1]);
      continue;
    }

    const addColumn =
      /^ALTER\s+TABLE\s+"?([\w]+)"?\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([\w]+)"/i.exec(
        statement,
      );
    if (addColumn) {
      add('column', `${addColumn[1]}.${addColumn[2]}`);
      continue;
    }

    const addConstraint = /^ALTER\s+TABLE\s+"?[\w]+"?\s+ADD\s+CONSTRAINT\s+"([\w]+)"/i.exec(
      statement,
    );
    if (addConstraint) {
      add('constraint', addConstraint[1]);
      continue;
    }

    // `CREATE SCHEMA` names no object this gate can verify, and drizzle emits it
    // harmlessly. Recognised and ignored, rather than refused.
    if (/^CREATE\s+SCHEMA\b/i.test(statement)) continue;

    // `DROP` is the case worth stopping on. It is how a migration that *removes*
    // something would be read as evidence that the removal happened, and it is
    // not something this parser can verify against the live schema.
    if (/^DROP\b/i.test(statement)) {
      throw new Error(
        `Unsupported migration statement: a DROP cannot be verified against a live schema.\n` +
          `  ${statement.replace(/\s+/g, ' ').slice(0, 120)}`,
      );
    }

    throw new Error(
      `Unsupported migration statement; refusing to pass it as evidence.\n` +
        `  ${statement.replace(/\s+/g, ' ').slice(0, 120)}`,
    );
  }

  // Statement order, not alphabetical. A `Map` preserves insertion order, and the
  // input is a file whose order does not change, so this is as deterministic as
  // sorting — and it reads the way the migration does, which is what makes the
  // `evidence` block in the baseline reviewable at a glance.
  return [...found.values()];
}

/** Canonical form of an evidence list, for order-insensitive comparison. */
function compareAssertions(a, b) {
  return a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind);
}

/** The catalog names this gate looks for, keyed by assertion kind. */
const FACT_SET_FOR_KIND = {
  table: 'tables',
  column: 'columns',
  index: 'indexes',
  constraint: 'constraints',
};

// ---------------------------------------------------------------------------
// The migrator's comparison, reimplemented
// ---------------------------------------------------------------------------

/**
 * `max(created_at)` over the journal table, or `null` when it is empty.
 *
 * `null` rather than `0` because the migrator's own condition is
 * `!lastDbMigration || ...`: an empty table is a fact, and folding it into a
 * numeric zero would make an empty table indistinguishable from one holding a
 * migration stamped at the epoch.
 *
 * `Number()` on every value because `created_at` is a `bigint` and `pg` may hand
 * it back as a string. Comparing those strings would order `"900"` after
 * `"1000"`, producing a confident wrong answer from a healthy database.
 */
export function computeWatermark(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.reduce((max, row) => Math.max(max, Number(row.created_at)), Number.NEGATIVE_INFINITY);
}

/**
 * Exactly the migrations `PgDialect.migrate` would apply, by its own comparison.
 *
 * A single scalar: the highest `created_at` in the table, compared strictly
 * against each migration's `when`. A migration at the watermark counts as
 * applied. `hash` and `id` are deliberately absent — the migrator does not read
 * them either, and a gate that consulted them would be testing a different
 * property than the one that decides whether deploying is safe.
 */
export function migrationsMigratorWouldApply(migrations, rows) {
  const watermark = computeWatermark(rows);
  return migrations.filter((m) => watermark === null || watermark < m.when);
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/**
 * Both directions of drift, plus the two integrity findings that make either
 * one untrustworthy.
 *
 * Forward and reverse are keyed differently, on purpose:
 *
 * - forward (`wouldApply`, less the baseline) is keyed by `created_at` vs
 *   `when`, because that is the migrator's decision and the thing that would
 *   break a deploy;
 * - reverse is keyed by `hash`, because `created_at` cannot identify a row —
 *   a hand-inserted row carries an arbitrary one — and `id` is a SERIAL that
 *   says nothing about which migration a row is.
 */
export function computeDrift({ migrations, rows, baseline }) {
  const entries = baseline?.migrations ?? [];
  const baselined = new Set(entries.map((entry) => entry.tag));
  const watermark = computeWatermark(rows);
  const wouldApply = migrationsMigratorWouldApply(migrations, rows);

  const tagByHash = new Map(migrations.map((m) => [m.hash, m]));

  return {
    watermark,
    wouldApply,
    // Repo migrations the migrator would still apply, minus the ones the baseline
    // has verified as already present.
    forward: wouldApply.filter((m) => !baselined.has(m.tag)),
    // Rows claiming to be a migration this repository does not contain.
    reverse: (rows ?? [])
      .filter((row) => !tagByHash.has(row.hash))
      .map((row) => ({ id: row.id, hash: row.hash, created_at: row.created_at })),
    // Rows that carry a real migration's hash at a timestamp that is not that
    // migration's `when`. The table and the journal disagree about history,
    // which is the lying-journal failure itself rather than a symptom of it.
    incoherent: (rows ?? [])
      .map((row) => {
        const migration = tagByHash.get(row.hash);
        if (!migration) return null;
        if (Number(row.created_at) === migration.when) return null;
        return {
          id: row.id,
          hash: row.hash,
          created_at: row.created_at,
          expected: migration.when,
          tag: migration.tag,
        };
      })
      .filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

/**
 * Structural guards on the baseline.
 *
 * Each of these closes a way of satisfying the gate without the schema actually
 * matching. They report every problem rather than the first, because a hand-
 * authored baseline is usually wrong in more than one way and fixing them one
 * run at a time is how people end up deleting the file instead.
 */
export function validateBaseline(baseline, migrations) {
  const errors = [];

  if (!baseline || typeof baseline !== 'object') {
    return { errors: ['baseline is not an object'] };
  }
  if (baseline.version !== BASELINE_VERSION) {
    errors.push(
      `baseline version ${JSON.stringify(baseline.version)} is not the supported version ${BASELINE_VERSION}`,
    );
  }
  if (!Array.isArray(baseline.migrations)) {
    errors.push('baseline has no `migrations` array');
    return { errors };
  }

  const byTag = new Map(migrations.map((m) => [m.tag, m]));
  const seen = new Set();

  let previousWhen = -Infinity;
  for (const entry of baseline.migrations) {
    const where = entry?.tag ? `baseline entry ${JSON.stringify(entry.tag)}` : 'a baseline entry';

    if (!entry || typeof entry !== 'object' || typeof entry.tag !== 'string') {
      errors.push(`${where} has no tag`);
      continue;
    }

    if (seen.has(entry.tag)) {
      errors.push(`${where} is duplicated — the baseline must list each migration once`);
    }
    seen.add(entry.tag);

    const migration = byTag.get(entry.tag);
    if (!migration) {
      // An entry for a migration this repository does not contain is an
      // exemption from a check that does not exist, which is worse than no entry.
      errors.push(
        `${where} is not a migration in packages/db/drizzle — the journal has no such tag`,
      );
      continue;
    }

    if (entry.hash !== migration.hash) {
      // The hash is what ties an entry to the exact SQL it claims. If that file
      // is edited, the entry must stop being trusted rather than keep exempting a
      // migration that no longer exists in that form.
      errors.push(
        `${where} records hash ${JSON.stringify(entry.hash)} but ${entry.tag}.sql hashes to ` +
          `${migration.hash} — regenerate the baseline after editing the migration`,
      );
    }

    if (entry.when !== migration.when) {
      errors.push(
        `${where} records when ${JSON.stringify(entry.when)} but the journal says ${migration.when}`,
      );
    }

    if (entry.when < previousWhen) {
      errors.push(`${where} is out of journal order — the baseline must be sorted by \`when\``);
    }
    previousWhen = entry.when;

    const derived = extractAssertions(migration.sql);
    const recorded = Array.isArray(entry.evidence) ? entry.evidence : null;
    if (!recorded) {
      errors.push(`${where} has no evidence array`);
    } else if (serializeEvidence(derived) !== serializeEvidence(recorded)) {
      errors.push(
        `${where} claims evidence the migration does not produce.\n` +
          `  expected: ${serializeEvidence(derived)}\n` +
          `  recorded: ${serializeEvidence(recorded)}`,
      );
    }
  }

  return { errors };
}

/** Canonical form of an evidence list, for order-insensitive comparison. */
function serializeEvidence(evidence) {
  const sorted = [...evidence].sort(compareAssertions);
  return sorted.map((item) => `${item.kind}:${item.name}`).join(',');
}

/**
 * Deterministic serialisation.
 *
 * The same input must produce the same bytes on every run and every machine.
 * That is what lets CI re-derive the baseline and diff it against the committed
 * file, and it is why there is no generated-at timestamp: a field that changes
 * per run turns every regeneration into a diff and nobody reviews a diff that is
 * always different.
 *
 * Key order is fixed here rather than inherited from the input object, so
 * re-ordering keys in a hand edit is itself a diff.
 */
export function serializeBaseline(baseline) {
  const migrations = [...(baseline.migrations ?? [])]
    .sort((a, b) => a.when - b.when)
    .map((entry) => ({
      tag: entry.tag,
      when: entry.when,
      hash: entry.hash,
      // Evidence keeps the order its migration file creates the objects in. That
      // order is a property of the file, so the bytes stay stable; sorting it
      // here would only make the committed block harder to read against the SQL.
      evidence: [...(entry.evidence ?? [])],
    }));

  return `${JSON.stringify({ version: baseline.version, migrations }, null, 2)}\n`;
}

/**
 * Parse a baseline file.
 *
 * `null` text means the file is absent, which is a normal state for a fresh
 * checkout and not a parse failure: it yields an empty baseline, and the gate
 * then reports the drift that emptiness was hiding. Treating it as an error
 * would report a confusing parse failure instead of the actual finding.
 */
export function parseBaseline(text) {
  if (text === null || text === undefined) {
    return { baseline: { version: BASELINE_VERSION, migrations: [] }, errors: [] };
  }
  try {
    return { baseline: JSON.parse(text), errors: [] };
  } catch (error) {
    return {
      baseline: { version: BASELINE_VERSION, migrations: [] },
      errors: [`baseline is not valid JSON: ${error.message}`],
    };
  }
}

/**
 * Build the baseline for the schema as it actually is.
 *
 * A migration enters only if the live schema shows every object its file
 * creates. Not "the watermark says it is pending and we assume someone applied
 * it" — the assumption is exactly what this repository's production database was
 * built on, and it is why the journal lies there.
 *
 * A migration that is *not* pending gets no entry, even if its objects are
 * present. It is already recorded; an entry would be an exemption with nothing
 * to exempt.
 */
export function generateBaseline({ migrations, rows, facts }) {
  const pending = migrationsMigratorWouldApply(migrations, rows);

  const entries = pending
    .filter((migration) =>
      extractAssertions(migration.sql).every((item) =>
        facts[FACT_SET_FOR_KIND[item.kind]]?.has(item.name),
      ),
    )
    .map((migration) => ({
      tag: migration.tag,
      when: migration.when,
      hash: migration.hash,
      evidence: extractAssertions(migration.sql),
    }));

  return { version: BASELINE_VERSION, migrations: entries };
}

/**
 * Which of a baseline's claims the live schema does not support.
 *
 * Re-verifying every entry on every run is the guard that makes growing the
 * baseline an expensive and honest act: to exempt a migration you have to have
 * actually applied it. It is also why an entry cannot be written by hand — a
 * hand-written claim is checked exactly like a generated one.
 */
/**
 * Migrations the journal lists that the database has no record of running.
 *
 * ## Why this is the check the gate was missing
 *
 * Everything else `runGate` looks at is either a file in the repository or a fact
 * the baseline claims about the schema. The baseline is empty in this project, so
 * every live-schema assertion was vacuously satisfied, and the journal-versus-schema
 * comparison passed because both sides are generated from the same source.
 *
 * Nothing asked the database. This asks it: for each migration the journal lists,
 * is there a row in `drizzle.__drizzle_migrations`?
 *
 * Matching is by the tag embedded in the recorded hash, which is the only durable
 * join between the two. A migration whose hash is absent is reported by tag, not by
 * an opaque digest, because the operator's next command is about the tag.
 */
export function unappliedMigrations(migrations, appliedAt, baseline) {
  // `appliedAt` rows carry a bare `sha256(fileContents)` — no tag anywhere in it.
  // Matching therefore goes through `migration.hash`, which `loadMigrations`
  // computes with the same bytes and the same digest that
  // `drizzle-orm/migrator`'s `readMigrationFiles` uses, because that is the value
  // `PgDialect.migrate` wrote. An earlier version of this function tried to recover a
  // tag out of the hash and found none, and reported all ten migrations as unapplied
  // against a database that had already run five.
  const appliedHashes = new Set((appliedAt ?? []).map((row) => String(row?.hash ?? '')));

  // A migration the baseline covers was applied **outside** drizzle, by hand, so it
  // is legitimately absent from `__drizzle_migrations` — and the baseline is the
  // record of that, already checked against the live schema by
  // `unsatisfiedBaseline`. Without this exemption the gate would block every
  // deploy of a project that has ever applied a migration by hand, which is the
  // case this gate was written for.
  const covered = new Set((baseline?.migrations ?? []).map((entry) => entry.tag));

  return migrations
    .filter((m) => !appliedHashes.has(m.hash) && !covered.has(m.tag))
    .map((m) => m.tag);
}

export function unsatisfiedBaseline(baseline, migrations, facts) {
  const byTag = new Map(migrations.map((m) => [m.tag, m]));

  return (baseline?.migrations ?? [])
    .map((entry) => {
      const migration = byTag.get(entry.tag);
      if (!migration) return null;
      const missing = extractAssertions(migration.sql).filter(
        (item) => !facts[FACT_SET_FOR_KIND[item.kind]]?.has(item.name),
      );
      return missing.length ? { tag: entry.tag, missing } : null;
    })
    .filter(Boolean);
}

/**
 * Baseline entries the journal table no longer needs.
 *
 * An entry is stale when its migration is not among those the migrator would
 * apply — because drizzle has since recorded it, or because a later migration
 * moved the watermark past it. Either way the entry has stopped describing
 * reality, and left in place it is a standing exemption that nobody will
 * remember approving. Reported rather than deleted, because the fix is to
 * regenerate, not to hand-edit.
 */
export function staleBaselineEntries(baseline, migrations, rows) {
  const pending = new Set(migrationsMigratorWouldApply(migrations, rows).map((m) => m.tag));
  return (baseline?.migrations ?? [])
    .filter((entry) => !pending.has(entry.tag))
    .map((entry) => entry.tag);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Decide whether a deploy may proceed.
 *
 * Takes the observation as an argument rather than opening a connection, so
 * every branch below — including the unreachable one — is reachable from a test
 * without a database anywhere near it.
 *
 * There is no `unknown`. See the header: an unreachable database is a failure,
 * and the absence of a softer verdict is intentional enough to be worth having
 * to look up.
 */
export function runGate({ migrations, observation, baseline }) {
  const empty = { version: BASELINE_VERSION, migrations: [] };
  const effective = baseline ?? empty;

  if (!observation?.reachable) {
    return {
      ok: false,
      exitCode: 1,
      reachable: false,
      // Phrased so that nobody can read this as a pass that merely found nothing.
      blockedReason:
        `Cannot verify the target schema: the database was unreachable (${observation?.error ?? 'no error reported'}). ` +
        `This gate fails closed on purpose — deploying code against a schema it could not check is the exact ` +
        `failure this exists to prevent. Fix the connection, or run the gate from a network that can reach the database.`,
      watermark: null,
      forward: [],
      reverse: [],
      incoherent: [],
      unsatisfied: [],
      staleBaseline: [],
      baselineErrors: [],
      wouldApply: [],
    };
  }

  const { rows, facts } = observation;
  const drift = computeDrift({ migrations, rows, baseline: effective });
  const { errors: baselineErrors } = validateBaseline(effective, migrations);
  const unsatisfied = unsatisfiedBaseline(effective, migrations, facts);
const staleBaseline = staleBaselineEntries(effective, migrations, rows);
    const neverApplied = unappliedMigrations(migrations, observation.appliedAt, effective);

    const findings = [];
  if (baselineErrors.length > 0) findings.push('the baseline is not valid');
  if (drift.forward.length > 0) findings.push(`${drift.forward.length} unregistered migration(s)`);
  if (drift.reverse.length > 0) findings.push(`${drift.reverse.length} unknown journal row(s)`);
  if (drift.incoherent.length > 0)
    findings.push(`${drift.incoherent.length} contradictory timestamp(s)`);
  if (unsatisfied.length > 0) findings.push(`${unsatisfied.length} unverified baseline entry(ies)`);
if (staleBaseline.length > 0) findings.push(`${staleBaseline.length} stale baseline entry(ies)`);
    if (neverApplied.length > 0)
      findings.push(
        `${neverApplied.length} migration(s) in the journal that this database has never run: ` +
          neverApplied.join(', '),
      );

    return {
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    reachable: true,
    blockedReason: findings.length === 0 ? null : `Deploy blocked: ${findings.join(', ')}.`,
    watermark: drift.watermark,
    forward: drift.forward,
    reverse: drift.reverse,
    incoherent: drift.incoherent,
unsatisfied,
      staleBaseline,
      neverApplied,
      baselineErrors,
    wouldApply: drift.wouldApply,
  };
}

/**
 * The report.
 *
 * Names what the migrator itself would have applied, because that is the finding
 * an operator can act on: it is the same list `db:migrate` would execute.
 */
export function formatReport(gate) {
  const lines = ['', '  Vyloop migration drift gate', '  ' + '-'.repeat(60)];

  if (!gate.reachable) {
    lines.push('  [FAIL] could not read the target database');
    lines.push(`         ${gate.blockedReason}`);
    lines.push('  ' + '-'.repeat(60));
    lines.push('  BLOCKED — an unverified schema is not a passing schema.');
    lines.push('');
    return lines.join('\n');
  }

  if (gate.ok) {
    lines.push('  [PASS] the target schema matches the migration journal');
    lines.push(`         journal watermark: ${gate.watermark}`);
    lines.push('         no unregistered migrations, no unknown journal rows.');
    lines.push('  ' + '-'.repeat(60));
    lines.push('  PASS — safe to deploy.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`  [FAIL] ${gate.blockedReason}`);
  lines.push(`         journal watermark: ${gate.watermark}`);

  if (gate.baselineErrors.length > 0) {
    lines.push('');
    lines.push('  baseline is not valid:');
    for (const error of gate.baselineErrors) lines.push(`    - ${error}`);
  }

  if (gate.forward.length > 0) {
    lines.push('');
    lines.push('  unregistered migrations — `drizzle-kit migrate` would apply these:');
    for (const migration of gate.forward) {
      lines.push(`    - ${migration.tag}  (when ${migration.when})`);
    }
    lines.push('    apply them with `pnpm --filter @vyloop/db db:migrate`, or, if they were');
    lines.push('    already applied by hand, record the verified state:');
    lines.push('      node scripts/check-migration-drift.mjs --write-baseline');
  }

  if (gate.reverse.length > 0) {
    lines.push('');
    lines.push('  unknown journal rows — recorded here, present in no migration of this repo:');
    for (const row of gate.reverse) {
      lines.push(
        `    - id ${row.id}  hash ${String(row.hash).slice(0, 16)}…  created_at ${row.created_at}`,
      );
    }
    lines.push('    these were applied from SQL this repository does not contain;');
    lines.push('    code cannot reason about a schema it has no migration for.');
  }

  if (gate.incoherent.length > 0) {
    lines.push('');
    lines.push('  contradictory timestamps — the journal table and the journal disagree:');
    for (const row of gate.incoherent) {
      lines.push(
        `    - ${row.tag} recorded at ${row.created_at}, but the journal says ${row.expected}`,
      );
    }
  }

  if (gate.unsatisfied.length > 0) {
    lines.push('');
    lines.push('  baseline entries the live schema does not support:');
    for (const entry of gate.unsatisfied) {
      lines.push(
        `    - ${entry.tag} is missing ${entry.missing.map((m) => `${m.kind} ${m.name}`).join(', ')}`,
      );
    }
    lines.push('    a baseline entry is an exemption, and an exemption needs the objects');
    lines.push('    to be really there. Regenerate it against this database.');
  }

  if (gate.staleBaseline.length > 0) {
    lines.push('');
    lines.push('  stale baseline entries — the journal table already records these:');
    for (const tag of gate.staleBaseline) lines.push(`    - ${tag}`);
    lines.push('    regenerate the baseline; it is exempting migrations that no longer need it.');
  }

  lines.push('  ' + '-'.repeat(60));
  lines.push('  BLOCKED — deploying against a schema this gate could not confirm.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Observation — the only part that touches the database
// ---------------------------------------------------------------------------

const DRIFT_QUERY =
    'select id, hash, created_at from drizzle.__drizzle_migrations order by created_at';

/**
 * The migrations the database recorded as run.
 *
 * The same table `DRIFT_QUERY` reads, named separately because the two are used for
 * different questions: `DRIFT_QUERY` answers "what order were these applied in",
 * and this answers "which of the migrations in the journal is in here at all".
 */
const APPLIED_MIGRATIONS_QUERY = DRIFT_QUERY;

/**
 * Read the journal table and the schema, or report that it could not be read.
 *
 * ## Enforcing read-only rather than promising it
 *
 * `SET default_transaction_read_only = on` puts the session itself in read-only
 * mode, so any statement this script did not intend to send is refused by the
 * server rather than by review. The setting is read back with `SHOW` and the
 * connection is dropped if the server did not honour it: a gate that claims to be
 * read-only while silently holding a writable session is worse than one that
 * cannot run.
 *
 * `sslmode=verify-full` is left at the connection string's own default rather
 * than disabled. The readiness report sets `rejectUnauthorized: false` because it
 * connects constantly to a Neon branch during development; this gate runs in CI
 * against production, where an unverified TLS connection is exactly the moment
 * not to take the shortcut.
 */
export async function observeDatabase(url, { connectTimeoutMs = 10_000 } = {}) {
  if (!url) return { reachable: false, error: 'DATABASE_URL is not set' };

  // The comment below says this gate runs in CI against production, which is
  // exactly why it may not rely on the driver's current, soon-to-change reading
  // of `sslmode`.
  assertVerifiedTls(url);

  // `pg` is a dependency of packages/db, not of the repository root, so a plain
  // dynamic import from a script at the top level does not resolve it.
  const require = createRequire(join(process.cwd(), 'packages/db/package.json'));
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: connectTimeoutMs,
  });

  try {
    await pool.query('SET default_transaction_read_only = on');
    const mode = await pool.query('SHOW default_transaction_read_only');
    if (mode.rows[0]?.default_transaction_read_only !== 'on') {
      return {
        reachable: false,
        error: 'the database did not honour a read-only session; refusing to continue',
      };
    }

    const schema = (await pool.query('select current_schema() as schema')).rows[0].schema;

    const rows = await pool.query(DRIFT_QUERY);
    const tables = await pool.query(
      'select table_name from information_schema.tables where table_schema = $1',
      [schema],
    );
    const columns = await pool.query(
      'select table_name || $2 || column_name as name from information_schema.columns where table_schema = $1',
      [schema, '.'],
    );
    const indexes = await pool.query(
      'select indexname as name from pg_indexes where schemaname = $1',
      [schema],
    );
const constraints = await pool.query(
        `select c.conname as name from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = $1`,
        [schema],
      );

      /**
       * The journal rows the database itself recorded.
       *
       * Read here and, until this change, nowhere. The gate compared the committed
       * schema files against the committed journal — two files in the repository —
       * and then checked the *baseline* against the live schema. Neither of those
       * asks the database which migrations it has actually run, so a migration in
       * the journal that was never applied was invisible to it:
       *
       *     [PASS] the target schema matches the migration journal
       *     PASS — safe to deploy.
       *
       * while production was missing five of them, and `/v1/communication/templates`
       * was answering 500 on a column that migration would have created.
       *
       * A schema file and a journal agree perfectly about work that never happened.
       */
      const applied = await pool.query(APPLIED_MIGRATIONS_QUERY);

      return {
        reachable: true,
        rows: rows.rows,
        schema,
        appliedAt: applied.rows,
        facts: {
          tables: new Set(tables.rows.map((r) => r.table_name)),
          columns: new Set(columns.rows.map((r) => r.name)),
          indexes: new Set(indexes.rows.map((r) => r.name)),
          constraints: new Set(constraints.rows.map((r) => r.name)),
        },
      };
  } catch (error) {
    return { reachable: false, error: error.message };
  } finally {
    await pool.end();
  }
}

/**
 * `DATABASE_URL` from the environment, falling back to the local dev file.
 *
 * The fallback exists only so the gate can be run against development by hand.
 * On CI the file is gitignored and absent, so the environment is the only source
 * — and a missing URL is a failure, not a skip, for the reason in the header.
 */
function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, source: 'DATABASE_URL' };
  for (const path of ['apps/gateway/.dev.vars', 'workers/wallet/.dev.vars']) {
    try {
      const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(path, 'utf8'))?.[1];
      if (url) return { url, source: path };
    } catch {
      // No local dev file. Expected on CI.
    }
  }
  return { url: null, source: null };
}

function readBaselineFile() {
  try {
    return readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    return null;
  }
}

async function main(argv) {
  const wantsBaseline = argv.includes('--write-baseline');
  const applies = argv.includes('--apply');
  const checksFresh = argv.includes('--check-baseline');

  const migrations = loadMigrations();
  const { baseline, errors: parseErrors } = parseBaseline(readBaselineFile());
  const { url, source } = resolveDatabaseUrl();
  const observation = await observeDatabase(url);

  if (wantsBaseline) {
    if (!observation.reachable) {
      process.stdout.write(
        `Cannot inspect the schema: ${observation.error}\n` +
          `A baseline is only evidence if it came from a real schema, so nothing is written.\n`,
      );
      return 1;
    }

    const generated = generateBaseline({
      migrations,
      rows: observation.rows,
      facts: observation.facts,
    });
    const text = serializeBaseline(generated);

    if (applies) {
      writeFileSync(BASELINE_PATH, text);
      process.stdout.write(
        `Wrote ${BASELINE_PATH} with ${generated.migrations.length} verified migration(s).\n`,
      );
    } else {
      // Dry run by default. Writing the baseline rewrites an interlock's
      // exemptions, and that should be a deliberate act with the previous
      // contents visible in the same terminal.
      process.stdout.write(
        `Dry run — nothing was written. ${BASELINE_PATH} would contain:\n\n${text}\n` +
          `Re-run with --apply to write it.\n`,
      );
    }
    return 0;
  }

  if (checksFresh) {
    if (!observation.reachable) {
      process.stdout.write(
        `Cannot inspect the schema: ${observation.error}\n` +
          `The committed baseline cannot be confirmed, so it cannot be trusted.\n`,
      );
      return 1;
    }
    const derived = serializeBaseline(
      generateBaseline({ migrations, rows: observation.rows, facts: observation.facts }),
    );
    const committed = readBaselineFile();
    if (derived !== committed) {
      process.stdout.write(
        `The committed baseline is not what this schema produces.\n\n` +
          `  committed: ${committed === null ? '(no file)' : 'present'}\n` +
          `  derived:   ${derived.split('\n').length} lines\n\n` +
          `An entry may only be added by applying the migration to the database. Regenerate with:\n` +
          `  node scripts/check-migration-drift.mjs --write-baseline --apply\n`,
      );
      return 1;
    }
    process.stdout.write('Baseline matches the schema. Nothing to regenerate.\n');
    return 0;
  }

  const gate = runGate({ migrations, observation, baseline });
  process.stdout.write(formatReport(gate));

  if (parseErrors.length > 0) {
    for (const error of parseErrors) process.stdout.write(`  note: ${error}\n`);
  }
  if (source) process.stdout.write(`  database url read from ${source}\n`);
  process.stdout.write('\n');

  return gate.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('migration drift gate failed:', error);
      process.exitCode = 1;
    });
}

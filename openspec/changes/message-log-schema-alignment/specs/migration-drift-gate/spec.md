# Delta for migration-drift-gate

## ADDED Requirements

### Requirement: Strict Evidence Extraction

`extractAssertions` in `scripts/check-migration-drift.mjs` MUST turn every statement of a migration into evidence or refuse it with an error. A statement it does not recognise MUST NOT be skipped. Comments MUST be stripped before parsing, so prose in a migration header is never read as a claim.

#### Scenario: An unknown statement is refused

- GIVEN a migration containing `ALTER TABLE "message_log" RENAME COLUMN "status" TO "state"`
- WHEN `extractAssertions` reads it
- THEN it throws an unsupported-statement error naming the statement

### Requirement: Column Shape Evidence

The gate MUST recognise these `ALTER TABLE "<t>" ALTER COLUMN "<c>"` forms and record them as evidence with an expected value:

- `SET DATA TYPE <type>` / `TYPE <type>`, optionally with `USING <c> AT TIME ZONE '<zone>'`, as `column_type` with the normalised type;
- `SET NOT NULL` / `DROP NOT NULL` as `column_nullable` with `NO` / `YES`;
- `SET DEFAULT <expr>` / `DROP DEFAULT` as `column_default` with the normalised expression or `null`.

`observeDatabase` MUST read `data_type`, `is_nullable` and `column_default` from `information_schema.columns` for the current schema, and the gate MUST compare them after normalising the casts Postgres adds to defaults (e.g. `'queued'::text` equals `'queued'`). Any other `ALTER COLUMN` form MUST be refused.

#### Scenario: A type change is verified

- GIVEN a registered migration asserting `column_type` `message_log.created_at` = `timestamp with time zone`
- WHEN the live column is `timestamp without time zone`
- THEN `pnpm db:drift` fails and names `message_log.created_at` with the expected and observed type

#### Scenario: A default is compared without its cast

- GIVEN a registered `column_default` `message_log.status` = `'queued'`
- WHEN `information_schema.columns.column_default` is `'queued'::text`
- THEN the assertion is satisfied

#### Scenario: An unsupported USING clause is refused

- GIVEN a migration containing `ALTER TABLE "t" ALTER COLUMN "c" TYPE integer USING length(c)`
- WHEN `extractAssertions` reads it
- THEN it throws an unsupported-statement error

### Requirement: Column Absence Evidence

The gate MUST recognise `ALTER TABLE "<t>" DROP COLUMN [IF EXISTS] "<c>"` as a `column_absent` assertion named `<t>.<c>`, satisfied when the column is not in the live catalog. Baseline evidence MUST be evaluated in migration order, so a later `column_absent` supersedes an earlier `column` assertion for the same name, and a later `column` supersedes an earlier `column_absent`. `DROP TABLE`, `DROP INDEX` and `DROP CONSTRAINT` MUST remain refused.

#### Scenario: A dropped column is verified

- GIVEN a registered migration asserting `column_absent` `message_log.payload`
- WHEN the live `message_log` still has `payload`
- THEN `pnpm db:drift` fails and names the column

#### Scenario: A later drop supersedes an earlier add

- GIVEN migration A asserting `column` `t.c` and a later migration B asserting `column_absent` `t.c`
- WHEN the live table has no column `c`
- THEN neither entry is reported as unsatisfied

#### Scenario: A table drop is still refused

- GIVEN a migration containing `DROP TABLE "message_log"`
- WHEN `extractAssertions` reads it
- THEN it throws an unsupported-statement error

### Requirement: Versioned Baseline Format

Evidence entries for `column_type`, `column_nullable` and `column_default` MUST carry a `value` field in `packages/db/drizzle/meta/_applied-outside-drizzle.json`. `BASELINE_VERSION` MUST be 2, `parseBaseline` MUST refuse a version-1 file with a message that names `--write-baseline`, and `serializeBaseline` MUST stay deterministic.

#### Scenario: An old baseline is refused with a remedy

- GIVEN a committed baseline with `"version": 1`
- WHEN `pnpm db:drift` runs
- THEN it fails and its message names `node scripts/check-migration-drift.mjs --write-baseline`

### Requirement: Schema Parity Check

A check run as `pnpm db:parity` MUST compare every table exported by `packages/db/src/schema.ts` with the live catalog: for each Drizzle column (from `getTableConfig`), the column MUST exist with the same SQL type, nullability and normalised default, and every live column of that table MUST be declared. Tables MUST be collected with drizzle's `is(value, PgTable)`, not `instanceof`. The check MUST use a read-only session and MUST run in the `migration-drift` job of `.github/workflows/deploy.yml`, failing the deploy on any difference.

#### Scenario: An undeclared live column fails the check

- GIVEN production's `message_log` with a `payload` column that `schema.ts` does not declare
- WHEN `pnpm db:parity` runs
- THEN it exits non-zero and reports `message_log.payload: present in database, not declared`

#### Scenario: A declared default that differs fails the check

- GIVEN `schema.ts` declaring `message_log.status` with default `'queued'`
- WHEN the live default is `'pending'`
- THEN the check reports `message_log.status` with both defaults

#### Scenario: A matching schema passes

- GIVEN a database where every declared table matches its declaration
- WHEN `pnpm db:parity` runs
- THEN it exits 0 and reports the number of tables and columns compared

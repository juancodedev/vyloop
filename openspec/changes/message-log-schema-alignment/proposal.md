# Proposal: message_log Schema Alignment

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Make production's `message_log` identical to its declaration in
`packages/db/src/schema.ts` (lines 802-831), and teach the migration drift gate
to verify the kinds of change that alignment needs, so that a schema difference
like this one can never again sit unseen behind a passing gate.

`0019_message_log_shape.sql` added the four columns the code needs and stopped
there on purpose. Its header ("What this migration deliberately leaves as it
is") lists what still differs and why it was left: the gate refuses
`ALTER COLUMN` and `DROP` as unverifiable evidence, so any migration that made
these changes could not be registered in
`packages/db/drizzle/meta/_applied-outside-drizzle.json`. None of the
differences breaks anything today; every insert sets every column involved.

## The remaining differences

| Column | Production | `schema.ts` | Why it is harmless today |
|---|---|---|---|
| `payload` | exists, nullable | not declared | Empty; read or written by no code. |
| `error` | exists, nullable | not declared | Empty; read or written by no code. |
| `customer_id` | nullable | `NOT NULL` | Every insert sets it. |
| `channel` | no default | default `'whatsapp'` | Every insert sets it. |
| `status` | default `'pending'` | default `'queued'` | Every insert sets it. |
| `created_at` | `timestamp` (no time zone) | `timestamptz` | Filled by `now()`; database and workers run in UTC. |

They stop being harmless the first time someone writes an insert that relies on
the declared default or reads `created_at` from a session in another time zone.

## Scope

### In Scope

1. Drift gate: three new evidence kinds — column type, column nullability and
   column default — extracted from `ALTER TABLE ... ALTER COLUMN` statements and
   verified against `information_schema.columns`.
2. Drift gate: an absence evidence kind for `ALTER TABLE ... DROP COLUMN`,
   verified as "this column does not exist", with later absence superseding an
   earlier presence assertion for the same column.
3. Baseline format: evidence entries carry an expected value for the new kinds;
   `BASELINE_VERSION` (`scripts/check-migration-drift.mjs:170`) moves to 2 and the
   committed baseline is regenerated.
4. A migration (next free number, reserved per `docs/18-Trabajo-Pendiente.md`) aligning the six columns above,
   with a pre-flight query that proves the data allows it.
5. A schema-parity check that compares every Drizzle table in `schema.ts` with
   the live catalog column by column, wired into the `migration-drift` job of
   `.github/workflows/deploy.yml`.
6. Documentation in `docs/09-Database-Design.md` and the pending-work entry in
   `docs/18-Trabajo-Pendiente.md`.

### Out of Scope

- **`DROP TABLE`, `DROP INDEX`, `DROP CONSTRAINT`, renames.** Only `DROP COLUMN`
  is needed here; the others stay refused until a change needs them.
- **Other tables.** On 2026-10-20 `message_log` was the only one of 26 tables
  that differed (`0019` header). The parity check is what keeps that true.
- **Adopting `drizzle-kit migrate`.** Migrations stay hand-applied.
- **Indexes and constraints in the parity check.** The drift gate already
  verifies them by name; the parity check adds what the gate cannot see.

## Capabilities

### New Capabilities

- `migration-drift-gate`: what `scripts/check-migration-drift.mjs` accepts as
  evidence, how it verifies evidence against the live catalog, and the
  schema-parity check that runs next to it. No spec exists for it today.

### Modified Capabilities

- `database`: `message_log` matches its declaration.

## Approach

**Evidence carries a value.** Today an assertion is `{ kind, name }` and a fact is
a `Set` of names (`FACT_SET_FOR_KIND`, line 308; `observeDatabase`, lines
871-950). A type, nullability or default is not a name, so the new kinds are
`{ kind: 'column_type' | 'column_nullable' | 'column_default', name: 'table.column', value }`
and the matching facts are a `Map` from `table.column` to the normalised
`data_type`, `is_nullable` and `column_default` read from
`information_schema.columns`. Defaults are compared after normalising the
casts Postgres adds (`'queued'::text` and `'queued'` are the same default).

**Absence is evidence too.** `DROP COLUMN [IF EXISTS] "c"` yields
`{ kind: 'column_absent', name: 'table.c' }`, satisfied when the column is not
in the live catalog. Because migrations run in order, the gate evaluates the
baseline's evidence as a sequence: a later `column_absent` supersedes an earlier
`column` for the same name, and vice versa. Without that rule, dropping a column
some older migration asserted would make the older entry fail for ever.

**Still strict.** Any `ALTER COLUMN` form the parser does not recognise —
`USING` expressions other than `AT TIME ZONE`, `SET DATA TYPE` with collation,
`DROP` of anything but a column — is still refused. The parser's contract
("a statement it does not recognise is an error, never a skip",
`check-migration-drift.mjs:207-215`) does not change.

**The migration proves its pre-conditions.** `SET NOT NULL` on `customer_id`
fails if any row has a null, and `DROP COLUMN` on `payload`/`error` loses data
if any row has a value. The migration header carries the read-only query that
must return zero before it is applied:

```sql
SELECT count(*) FILTER (WHERE customer_id IS NULL) AS null_customer,
       count(*) FILTER (WHERE payload IS NOT NULL)  AS has_payload,
       count(*) FILTER (WHERE error IS NOT NULL)    AS has_error
FROM message_log;
```

The type change uses `USING created_at AT TIME ZONE 'UTC'`, which keeps every
stored instant because the values were written in UTC.

**Parity, not just presence.** The drift gate proves that what a migration says
it created exists. It cannot see a table that was created in another shape
before the migration that declares it — which is exactly how `message_log` went
wrong (`0019` header, "The drift gate could not see it"). The parity check
compares the declaration itself: for every table in `schema.ts` (collected with
drizzle's `is(value, PgTable)`, not `instanceof`, because duplicate module copies
break `instanceof` — `packages/db/src/rls.test.ts:98` does the same with
`Table`), it reads `getTableConfig(table).columns` and compares name, SQL type,
nullability and default against `information_schema.columns`. It is a TypeScript
script run with `tsx` (already a devDependency of `packages/db`) because it
imports `schema.ts`.

## Risks

- **A default normaliser that is too lenient** hides a real difference; one that
  is too strict fails on cosmetic casts. Mitigated by fixture tests built from
  the exact `column_default` strings production returns today.
- **`ALTER COLUMN TYPE` rewrites the table** and takes an `ACCESS EXCLUSIVE`
  lock. `message_log` is small at PMV scale; the migration is applied in a quiet
  window.
- **The baseline version bump** invalidates the committed baseline until it is
  regenerated; `pnpm db:drift:baseline` fails in that window, which is the
  intended signal.

## Rollback Plan

The gate changes are code and revert with the PR. The migration is reverted by
hand:

```sql
ALTER TABLE "message_log" ALTER COLUMN "created_at" TYPE timestamp USING created_at AT TIME ZONE 'UTC';
ALTER TABLE "message_log" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "message_log" ALTER COLUMN "channel" DROP DEFAULT;
ALTER TABLE "message_log" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "message_log" ADD COLUMN "payload" jsonb, ADD COLUMN "error" text;
```

The dropped columns come back empty, which is the state they were in. The types
of `payload` and `error` MUST be read from production before the forward
migration is applied and written into this rollback, since they are not
declared anywhere in the repository. The baseline entry is removed by
regenerating it with `node scripts/check-migration-drift.mjs --write-baseline`
and confirming with `pnpm db:drift:baseline`, never by hand-editing.

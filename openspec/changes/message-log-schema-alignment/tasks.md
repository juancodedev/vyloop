# Tasks: message_log Schema Alignment

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| Estimated changed lines | ~750 (additions + deletions)                                       |
| 400-line budget risk    | Medium                                                             |
| Chained PRs recommended | Yes                                                                |
| Suggested split         | Unit 1 (gate) → Unit 2 (migration) ; Unit 3 (parity) in parallel   |
| Delivery strategy       | ask-on-risk                                                        |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal                                                  | Likely PR | Lines | Notes                                        |
| ---- | ----------------------------------------------------- | --------- | ----- | -------------------------------------------- |
| 1    | Drift gate learns column shape and absence evidence   | PR #1     | ~380  | Must land before Unit 2.                     |
| 2    | The aligning migration                                | PR #2     | ~120  | Needs Unit 1; applied by hand after review.  |
| 3    | Schema-parity check wired into deploy                 | PR #3     | ~250  | Independent of Units 1–2; fails until Unit 2 is applied, so merge after it. |

## Unit 1: The drift gate

- [ ] 1.1 `scripts/check-migration-drift.mjs` — in `extractAssertions` (lines 221-300), parse `ALTER TABLE "<t>" ALTER COLUMN "<c>"` with `SET DATA TYPE`/`TYPE` (optionally `USING "<c>" AT TIME ZONE '<zone>'`), `SET NOT NULL`/`DROP NOT NULL`, `SET DEFAULT`/`DROP DEFAULT`, emitting `column_type`, `column_nullable` and `column_default` with a `value`; parse `DROP COLUMN [IF EXISTS]` as `column_absent`; these `ALTER TABLE` forms fall through to the generic refusal today (lines 288-292); keep the leading-`DROP` refusal (lines 278-286) unchanged.
- [ ] 1.2 `scripts/check-migration-drift.mjs` — `observeDatabase` (lines 871-950): extend the `information_schema.columns` query to return `data_type`, `is_nullable` and `column_default`, and expose them as a `Map` keyed by `table.column`; keep the read-only session check.
- [ ] 1.3 `scripts/check-migration-drift.mjs` — `FACT_SET_FOR_KIND` (line 308) becomes a per-kind predicate table, so `column_absent` checks non-membership and the value kinds compare values; add a `normaliseDefault` helper that strips trailing `::<type>` casts.
- [ ] 1.4 `scripts/check-migration-drift.mjs` — `unsatisfiedBaseline` (line 632) evaluates evidence in migration order and lets a later presence/absence assertion supersede an earlier one for the same `table.column`.
- [ ] 1.5 `scripts/check-migration-drift.mjs` — `BASELINE_VERSION = 2`; `serializeEvidence`, `parseBaseline` and `validateBaseline` accept and require `value` on the value kinds; a version-1 file is refused with a message naming `--write-baseline`.
- [ ] 1.6 `scripts/check-migration-drift.test.mjs` — under `describe('extractAssertions')`: each accepted form and its assertion; an `ALTER COLUMN ... USING length(c)`, a `RENAME COLUMN`, a `DROP TABLE` and a `DROP INDEX` still throw. Under `describe('runGate')`: a type, nullability, default and absence mismatch are each reported with expected and observed values; supersession in both directions; `'queued'::text` equals `'queued'`.
- [ ] 1.7 Regenerate `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `node scripts/check-migration-drift.mjs --write-baseline` against production; `pnpm db:drift:baseline` and `pnpm db:drift` green; the `the committed baseline` tests in the test file pass.

## Unit 2: The migration

- [ ] 2.1 Read production's current types of `message_log.payload` and `message_log.error` (`information_schema.columns`, read-only) and record them in the migration header for the rollback.
- [ ] 2.2 `packages/db/drizzle/<next>_message_log_alignment.sql` (next free number, reserved per `docs/18-Trabajo-Pendiente.md`; `tenant-isolation-rls` also adds migrations) — header with the reason, the pre-flight query and the rollback statements; body: `ALTER COLUMN "customer_id" SET NOT NULL`, `ALTER COLUMN "channel" SET DEFAULT 'whatsapp'`, `ALTER COLUMN "status" SET DEFAULT 'queued'`, `ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC'`, `DROP COLUMN "payload"`, `DROP COLUMN "error"`, separated by `--> statement-breakpoint`; add the journal entry in `packages/db/drizzle/meta/_journal.json`.
- [ ] 2.3 `packages/db/src/migration-sql.test.ts` — the new file parses (the existing `pg-query-emscripten` parser), contains no `DROP TABLE`, and its header carries the pre-flight query.
- [ ] 2.4 Run the pre-flight on production; apply by hand only if it returns zeros; register with `--write-baseline`; `pnpm db:drift` green.
- [ ] 2.5 `workers/communication/src/*.test.ts` — no change expected; run `pnpm --filter @vyloop/communication-worker test` to confirm nothing read `payload`/`error`.

## Unit 3: Schema parity

- [ ] 3.1 `packages/db/scripts/check-schema-parity.ts` — collect tables from `schema.ts` with `is(value, PgTable)`; for each, `getTableConfig(table).columns` → name, `getSQLType()`, `notNull`, default; read `information_schema.columns` in a read-only session (`SET default_transaction_read_only = on`, read back with `SHOW`); report missing, undeclared and differing columns; exit 1 on any difference, 1 on an unreachable database.
- [ ] 3.2 `packages/db/src/schema-parity.test.ts` — the comparison function against fixture catalog rows: an undeclared column, a nullability difference, a cast-only default difference (passes), a type difference; the table collector finds all 26 tables.
- [ ] 3.3 `packages/db/package.json` — `"db:parity": "tsx scripts/check-schema-parity.ts"`; root `package.json` — `"db:parity": "pnpm --filter @vyloop/db db:parity"`.
- [ ] 3.4 `.github/workflows/deploy.yml` — a `Schema parity` step in the `migration-drift` job after `Migration drift gate`, with the same `DATABASE_URL` secret.

## Unit 4: Documentation

- [ ] 4.1 `docs/09-Database-Design.md` — the evidence kinds the gate accepts, the supersession rule, and `pnpm db:parity`.
- [ ] 4.2 `packages/db/drizzle/0019_message_log_shape.sql` — no edit (applied migrations are immutable); reference it from the new migration's header instead.
- [ ] 4.3 `docs/18-Trabajo-Pendiente.md` — move `message-log-schema-alignment` out of the pending table.

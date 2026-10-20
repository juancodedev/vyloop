# Production runbook: `idx_pos_terminals_business`

Objective: put index `idx_pos_terminals_business` on the production database, record it in
`packages/db/drizzle/meta/_applied-outside-drizzle.json`, and leave `pnpm db:drift` green so the
deploy gate accepts the next deploy.
Branch: `feat/wave-0-hardening` · Test runner: `pnpm --filter @vyloop/db test` · Read-only script:
`node scripts/check-migration-drift.mjs`

## Specs

- **S1** — Production is the Neon endpoint `ep-shiny-paper-aibbf0hk` (project `polished-firefly-68401534`,
  branch `br-delicate-paper-aitqyq9y`). Dev is `ep-divine-bonus-ai05bdy3`. Every command below must
  name the host it is about to touch before touching it.
- **S2** — The index is created with `CREATE INDEX CONCURRENTLY`, never inside a transaction:
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pos_terminals_business" ON "pos_terminals" USING btree ("business_id","created_at" DESC NULLS LAST);`
  The plain form takes a write lock on `pos_terminals`, which is on the path of every terminal
  installation.
- **S3** — `drizzle-kit migrate` must never run this migration: `packages/db/drizzle/0020_pos_terminals_business.sql`
  holds the non-concurrent statement and the concurrent form cannot run inside the migrator's
  transaction. `pnpm db:drift` reads the ledger instead, which is why the ledger entry is the
  deliverable that closes the deploy gate.
- **S4** — The ledger entry is generated, not hand-written: `node scripts/check-migration-drift.mjs --write-baseline`
  is a dry run that prints the file it would write; `--apply` writes it. It derives each entry from
  the live catalog, so the `hash` and the `evidence` list are what the schema actually shows.
- **S5** — The new `assertVerifiedTls` guard refuses `sslmode=require`. The 8 local `.dev.vars` still
  say `require`, so a command run straight from them fails closed. Use an explicit `verify-full` URL
  for the operator session (same host, same credentials); do not edit `.dev.vars` here — that is
  `supply-chain-hardening` task 2.5, a separate rotation.

## Tasks

| ID | Task | Route | Evidence |
| --- | --- | --- | --- |
| T1 | Confirm the target host and that the index is absent | inline | host printed, `pg_indexes` row count `0` |
| T2 | Confirm the current gate state fails only on `0020` | inline | `pnpm db:drift` reports `0020_pos_terminals_business` as unregistered |
| T3 | Create the index with `CONCURRENTLY` on production | inline | `CREATE INDEX` succeeds; `pg_indexes` shows the definition |
| T4 | Generate the ledger entry as a dry run and review the diff | inline | dry-run output lists exactly one new entry, tag `0020_pos_terminals_business` |
| T5 | Write the ledger entry and prove the gate is green | inline | `--apply` writes it; `pnpm db:drift` exits `0` |
| T6 | Commit the ledger entry and merge before the next deploy | inline | commit on the feature branch; `deploy.yml` gate passes |

## Commands

**T1 — target and current state.** `DATABASE_URL` below is the operator's `verify-full` URL, held in
the shell only, never written to a file in the repo.

```bash
# Host only, never the password. Compare against S1 before continuing.
echo "$DATABASE_URL" | sed -E 's#^[^:]+://[^@]+@([^/?]+).*#host: \1#'
psql "$DATABASE_URL" -c "select indexname from pg_indexes where tablename = 'pos_terminals' order by 1"
```

**T2 — gate state.**

```bash
pnpm db:drift
```

**T3 — the index.** One statement per `-c`, so nothing wraps it in a transaction.

```bash
psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pos_terminals_business" ON "pos_terminals" USING btree ("business_id","created_at" DESC NULLS LAST)'
psql "$DATABASE_URL" -c "select indexdef from pg_indexes where indexname = 'idx_pos_terminals_business'"
```

**T4 — dry run.**

```bash
node scripts/check-migration-drift.mjs --write-baseline
```

Expected: every already-applied migration keeps its current entry unchanged, plus one new entry for
`0020_pos_terminals_business` whose evidence is `index:idx_pos_terminals_business`. Anything else in
that diff means production is not in the state T1 and T3 reported — stop and re-read.

**T5 — write and verify.**

```bash
node scripts/check-migration-drift.mjs --write-baseline --apply
pnpm db:drift
pnpm db:drift:baseline
git diff --stat packages/db/drizzle/meta/_applied-outside-drizzle.json
```

**T6 — delivery.** Commit only the baseline file, push the branch, and merge before the next deploy;
`deploy.yml` runs the same gate and fails closed while `0020` is unregistered.

## Rollback

```bash
psql "$DATABASE_URL" -c 'DROP INDEX CONCURRENTLY IF EXISTS "idx_pos_terminals_business"'
```

Then revert the `0020` entry from `_applied-outside-drizzle.json` and re-run `pnpm db:drift`: it must
report `0020` as unregistered again, which is the state before T3. `pos_terminals` is not modified by
any of this, so nothing else needs undoing.

## Log

- **L1** — "create el pr y las tareas necesarias para ejecutar en produccion los ajustes de la base de datos"
- **L2** — Order is mandatory: index first, ledger second, merge third. The reverse order leaves the
  deploy gate red with an index already in place, which looks like a failed migration and invites the
  wrong fix.

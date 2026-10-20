# Proposal: Tenant Isolation with Row-Level Security

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Make tenant isolation a property of the database instead of a convention every
route has to remember.

Today a merchant cannot read another merchant's rows only because every handler
writes `WHERE business_id = ...` by hand. Row-level security (RLS) was designed
as the second line of defence (`docs/09-Database-Design.md` §4, "Estado actual:
RLS no está desplegado") and the building blocks exist in
`packages/db/src/rls.ts`, but nothing in production calls
`createRlsPolicies()`, `enableRls()`, `enableTenantRls()` or
`createTenantRlsPolicies()`. One missing filter in a new route is a cross-tenant
disclosure, and no test or gate would notice.

This change rolls RLS out, and before that fixes the three things that would
make the rollout either a no-op or an outage.

## What the investigation found

These facts shape the design; each was verified in the code on 2026-10-20.

1. **The session context does not survive to the next query.** `withRls(db, id)`
   (four copies: `workers/{growth,automation,communication,customer}/src/helpers.ts`,
   e.g. `workers/communication/src/helpers.ts:116-118`) runs
   `db.execute(setCurrentBusinessId(id))`. That statement is
   `SELECT set_config('app.current_business_id', $1, true)` (`packages/db/src/rls.ts:175-177`):
   the third argument `true` makes the setting **transaction-local**. It is
   executed on the Drizzle `neon-serverless` Pool (`packages/db/src/index.ts:6-9`,
   `new Pool({ connectionString })`) outside any transaction, so it runs in its
   own implicit transaction and the setting is discarded when that statement
   returns. The following query may also be served by a different pooled client,
   and the production URL points at Neon's `-pooler` endpoint
   (`ep-shiny-paper-aibbf0hk-pooler`, `docs/18-Verificacion-y-Seguridad-Operativa.md:159`),
   which multiplexes server connections per transaction, so not even a
   session-level `SET` would be reliable. The wallet's `openTenantSession`
   (`workers/wallet/src/drizzle-store.ts:105-110`) has the same shape. The 41
   `withRls(db, ...)` call sites therefore set nothing that the next query sees.
   The customer worker defines `withRls` (`workers/customer/src/helpers.ts:138`)
   and never calls it, so its routes set no context at all.
   The only correct pattern in the repository is the identity worker's
   `db.transaction(async (tx) => { await tx.execute(setCurrentBusinessId(...)); ... })`
   (`workers/identity/src/branches.ts:136-146`).
2. **The application connects as the table owner.** `DATABASE_URL` uses
   `neondb_owner` (`docs/18-Verificacion-y-Seguridad-Operativa.md:144`). In
   PostgreSQL the owner of a table is exempt from its policies unless the table
   is `FORCE ROW LEVEL SECURITY`. Enabling RLS while the workers keep that
   credential would change nothing at all.
3. **A missing context is an error, not an empty result.** The policy predicate
   is `business_id = current_setting('app.current_business_id')::UUID`
   (`rls.ts:82-84`). Without the `missing_ok` argument, a connection that never
   set the variable raises `unrecognized configuration parameter`, and one that
   set it in an earlier transaction now holds `''`, which fails the `::UUID` cast.
   The comment in `workers/communication/src/subscription-maintenance.ts:126-130`
   and the note on `WalletStore.listTenantsWithoutProgram`
   (`workers/wallet/src/store.ts:750-760`) say such a query would "see no rows";
   with the current predicate it would fail loudly instead. This change keeps the
   loud failure on purpose (see Approach).
4. **Cross-tenant jobs read without a tenant.** The push subscription sweep
   (`handleSubscriptionMaintenance`, `subscription-maintenance.ts:78`) reads
   `customers` table-wide; the wallet sweep (`runScheduledSweep`,
   `workers/wallet/src/sweep.ts:1009`) enumerates `tenant_wallet_programs` via
   `listProgramTenants` and anti-joins it via `listTenantsWithoutProgram`
   (`drizzle-store.ts:624-680`); the automation crons `handleBirthdayCron` and
   `handleInactivityCron` (`workers/automation/src/cron-handler.ts:21,167`) start
   with `SELECT DISTINCT business_id FROM workflows` on a bare session. All of
   them break once their tables enforce RLS.
5. **The table lists are incomplete.** `push_subscriptions` has `business_id` and
   is not in `BUSINESS_ID_TABLES`; `wallet_callback_deliveries` has `tenant_id`
   and is not in `TENANT_ID_TABLES`. `packages/db/src/rls.test.ts` checks that the
   listed tables have the column, not that every table with the column is listed.
6. **The drift gate cannot carry an RLS migration.** `extractAssertions` in
   `scripts/check-migration-drift.mjs:221-300` accepts only `CREATE TABLE`,
   `CREATE INDEX`, `ADD COLUMN`, `ADD CONSTRAINT` and `CREATE SCHEMA`, and throws
   on anything else, so `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and
   `CREATE POLICY` cannot be registered in
   `packages/db/drizzle/meta/_applied-outside-drizzle.json` today.
7. **There is no RLS verification script.** No `db:verify-rls` (or similar)
   exists in `package.json`; only `db:drift`, `db:drift:baseline`,
   `db:checkin-backlog`, `db:payment-reconciliation` and `deps:overrides`.

## Scope

### In Scope

1. One shared helper in `@vyloop/db`, `withTenantTransaction`, that opens a
   transaction, sets `app.current_business_id` and/or `app.current_tenant_id`
   inside it, and runs the caller's queries on that transaction. The four worker
   copies of `withRls` and the wallet's `openTenantSession` are replaced by it.
2. A non-owner application role (`vyloop_app`) without `BYPASSRLS`, holding only
   DML grants, and the workers' `DATABASE_URL` moved to it. The owner credential
   stays with migrations and the read-only operational scripts.
3. Complete table lists: `push_subscriptions` added to `BUSINESS_ID_TABLES`,
   `wallet_callback_deliveries` to `TENANT_ID_TABLES`, and a test that fails when
   a schema table carrying `business_id` or `tenant_id` is in neither list nor in
   an explicit exemption list (`tenants`, `cross_loyalty_alliances`).
4. Cross-tenant jobs rewritten as a per-tenant loop: enumerate `tenants` (which
   has no RLS), then run each tenant's work inside its own
   `withTenantTransaction`.
5. Drift gate support for two new evidence kinds, `rls` and `policy`, so an RLS
   migration can be registered and verified like any other.
6. A read-only verification script, `scripts/check-rls.mjs` (`pnpm db:rls`),
   that reports per table whether RLS is enabled, which policies exist, and
   whether the role in `DATABASE_URL` owns tables or holds `BYPASSRLS`.
7. A staged rollout: wallet tables first, then the business tables in batches,
   each preceded by a shadow phase.
8. Documentation: `docs/09-Database-Design.md` §4 and the pending-work entry in
   `docs/18-Trabajo-Pendiente.md`.

### Out of Scope

- **Removing the explicit `business_id` filters from the routes.** They stay.
  RLS is the second line of defence, not a replacement for the first.
- **`FORCE ROW LEVEL SECURITY`.** Moving the workers off the owner role gives the
  same effect without making migrations and operational scripts subject to
  policies they were not written for.
- **A `BYPASSRLS` role for the workers.** See Approach.
- **RLS on ClickHouse or on queues.** Different stores, different mechanisms.
- **Per-user (row owner) policies.** The boundary here is the merchant.

## Capabilities

### New Capabilities

- None. The drift-gate requirements are written against `migration-drift-gate`,
  which the `message-log-schema-alignment` change introduces; whichever of the
  two changes is archived first creates that spec.

### Modified Capabilities

- `database`: the `RLS` requirement is rewritten to cover both scoping shapes, the
  transaction-scoped session context, the non-owner role, table-list
  completeness and cross-tenant jobs.
- `migration-drift-gate`: the `rls` and `policy` evidence kinds.

## Approach

**Session context lives in a transaction, always.** `withTenantTransaction(db,
scope, fn)` in `packages/db/src/rls.ts` calls `db.transaction`, executes
`setCurrentBusinessId` and/or `setCurrentTenantId` on the transaction handle,
and passes that handle to `fn`. `set_config(..., true)` is then exactly as wide
as the transaction, which is what the pooler endpoint can honour. A route that
needs several statements under one tenant runs them all inside `fn`. The helper
lives in `@vyloop/db`, as `rls.ts:192-205` already argues for `withTenantRls`.

**A missing context fails loudly.** The predicate keeps
`current_setting(name)` without `missing_ok`. A query that reaches an
RLS-enabled table with no tenant set raises an error the worker logs, rather than
returning zero rows that read as "nothing to do". For a sweep, an empty result is
indistinguishable from health, which is the worst failure mode a background job
can have.

**Cross-tenant jobs loop over tenants; no worker gets `BYPASSRLS`.** A bypass
credential bound into a Worker that also serves HTTP requests is a standing
cross-tenant capability one bug away from a route. The jobs already reason per
tenant (the wallet sweep is a keyset walk over tenant ids, the automation crons
already iterate `business_id`s), so each job enumerates `tenants` (no RLS, no
`business_id`) and does that tenant's work inside `withTenantTransaction`. The
cost is one transaction per tenant per run, which is bounded by the existing
per-run budgets (`MAX_RECONCILES_PER_TENANT` and the sweep's page limits). The
operational scripts under `scripts/` keep the owner credential: they are
read-only (`SET default_transaction_read_only = on` in
`check-migration-drift.mjs`) and run from CI or by hand, not from a Worker.

**Roles are created outside migrations.** A role is cluster-wide state with a
password, and the drift gate refuses `CREATE ROLE` and `GRANT` as evidence. The
role is created through the Neon console or API by a runbook in `docs/09`, and
`pnpm db:rls` verifies its attributes afterwards.

**The rollout is staged.**

| Phase | What changes | Exit criterion |
|---|---|---|
| 0 | Session plumbing, table lists, per-tenant jobs, `pnpm db:rls`, gate kinds. No database change. | All tests green; no `withRls(db` left in `workers/`. |
| 1 | `vyloop_app` role created; workers' `DATABASE_URL` secrets moved to it. RLS still off. | `pnpm db:rls` reports the app role as non-owner, no `BYPASSRLS`; smoke tests pass. |
| 2 | Shadow on a Neon branch: RLS enabled on every listed table of a branch of `ep-shiny-paper-aibbf0hk`, workers' preview deploy pointed at it, full suite and smoke run. | Zero RLS errors in the branch's logs. |
| 3 | Wallet tables in production: `tenant_wallet_programs`, `customer_wallet_passes`, `wallet_callback_deliveries`. | One week with no RLS errors in worker logs; wallet sweep report counts unchanged. |
| 4 | Business tables in production, in batches (communication tables, then growth, then the rest). | Same, per batch. |

The wallet tables go first because they are three tables, read through one
store (`drizzle-store.ts`) that already scopes every `WHERE` by `tenant_id` and
already sets both variables, and are behind one worker; a failure there is
contained and visible in the sweep report.

**Each phase-3 and phase-4 batch is one migration**, e.g.
`packages/db/drizzle/<next>_wallet_rls.sql`, written from `enableTenantRls()` and
`createTenantRlsPolicies()`, applied by hand like every migration in this
repository, and registered in `_applied-outside-drizzle.json` with `rls` and
`policy` evidence.

## Risks

- **A code path not moved to `withTenantTransaction`** fails with an error once
  its table enforces RLS. Mitigated by phase 0's exit criterion (a grep-backed
  test that no `withRls(db` call remains) and by the branch shadow in phase 2.
- **A job that loops per tenant runs longer.** Bounded by the existing per-run
  budgets; the sweep reports already count tenants reached and deferred.
- **Neon role semantics.** Whether a role created by `neondb_owner` can be denied
  ownership and `BYPASSRLS` as intended must be confirmed on a branch in phase 1;
  `pnpm db:rls` is what confirms it.
- **The pooler and `set_config`.** Transaction-local settings are compatible with
  transaction pooling by construction; a session-level `SET` would not be, and
  the helper must never use one.

## Rollback Plan

RLS is reverted per table, without a deploy:

```sql
ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "<table>";
```

`dropRlsPolicies()` and `dropTenantRlsPolicies()` in `rls.ts` already render the
second statement. Disabling RLS restores today's behaviour immediately, because
the explicit `business_id` filters never left the routes. The role change is
reverted by pointing the workers' `DATABASE_URL` secret back at `neondb_owner`
(owner bypasses policies). Phase 0 code is safe to keep after a rollback: a
transaction that sets a variable no policy reads is harmless. Each rollback is
recorded in `_applied-outside-drizzle.json` only once the gate can verify
absence (the `message-log-schema-alignment` change); until then it is recorded
in `docs/09` §4.

# Tasks: Tenant Isolation with Row-Level Security

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| Estimated changed lines | ~1600 (additions + deletions), of which ~600 are mechanical call-site moves                   |
| 400-line budget risk    | High                                                                                          |
| Chained PRs recommended | Yes                                                                                           |
| Suggested split         | Unit 1 → Unit 2 → (Unit 3 ∥ Unit 4 ∥ Unit 5) → Unit 6 → Unit 7, one PR each                   |
| Delivery strategy       | ask-on-risk                                                                                   |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                                       | Likely PR | Lines | Notes                                                    |
| ---- | ---------------------------------------------------------- | --------- | ----- | -------------------------------------------------------- |
| 1    | `withTenantTransaction` and complete table lists           | PR #1     | ~250  | Shared code; must land first.                            |
| 2    | Move every worker call site to the helper                  | PR #2–#3  | ~600  | Mechanical; split growth (`routes.ts`, 20 sites) from the rest. |
| 3    | Cross-tenant jobs loop per tenant                          | PR #4     | ~350  | Needs Unit 1.                                            |
| 4    | `pnpm db:rls` verification script                          | PR #5     | ~250  | Independent of Units 2–3.                                |
| 5    | Drift gate `rls` / `policy` evidence                       | PR #6     | ~200  | Independent of Units 2–4.                                |
| 6    | Role, shadow branch, wallet migration (phases 1–3)         | PR #7     | ~100  | Operational; needs Units 1–5.                            |
| 7    | Business-table migrations (phase 4) and docs               | PR #8+    | ~150  | One PR per batch.                                        |

## Unit 1: Phase 0 — the shared helper and the table lists

- [ ] 1.1 `packages/db/src/rls.ts` — add `withTenantTransaction(db, { businessId?, tenantId? }, fn)`: `db.transaction`, `tx.execute(setCurrentBusinessId(...))` and/or `tx.execute(setCurrentTenantId(...))`, then `return fn(tx)`; throw if neither id is given. Deprecate `withTenantRls` (it executes outside a transaction) in its doc comment.
- [ ] 1.2 `packages/db/src/index.ts` — export `withTenantTransaction`.
- [ ] 1.3 `packages/db/src/rls.ts` — add `push_subscriptions` to `BUSINESS_ID_TABLES` and `wallet_callback_deliveries` to `TENANT_ID_TABLES`; add `RLS_EXEMPT_TABLES` (`tenants`, `cross_loyalty_alliances`) with the reason for each.
- [ ] 1.4 `packages/db/src/rls.test.ts` — completeness test: every table from `schema.ts` (collected with `is(value, Table)`, as the file already does at line 98) that has a `business_id` or `tenant_id` column is in exactly one of the three lists; a test that `withTenantTransaction` issues the `set_config` statements on the transaction handle, before `fn`, and never on the outer `db`.
- [ ] 1.5 `packages/db/src/rls.test.ts` — the predicate rendered by `createRlsPolicies()` and `createTenantRlsPolicies()` contains `current_setting('app.current_business_id')` / `current_setting('app.current_tenant_id')` with no second argument (the fail-loud rule).

## Unit 2: Phase 0 — move the worker call sites

- [ ] 2.1 `workers/growth/src/routes.ts` and `workers/growth/src/event-handler.ts` — replace each `await withRls(db, businessId)` + following queries with `withTenantTransaction(db, { businessId }, async (tx) => ...)`; remove `withRls` from `workers/growth/src/helpers.ts`.
- [ ] 2.2 `workers/customer/src/*.ts` — the customer worker defines `withRls` (`helpers.ts:138`) and never calls it, so its routes set no tenant context at all; wrap every tenant-table query in `withTenantTransaction` and delete the unused helper.
- [ ] 2.3 `workers/communication/src/` (`routes.ts`, `campaign-routes.ts`, `push-routes.ts`, `push-campaigns.ts`, `push-delivery.ts`, `delivery-stats.ts`, `event-handler.ts`) — same, and remove `withRls` from `workers/communication/src/helpers.ts`.
- [ ] 2.4 `workers/automation/src/event-handler.ts` (lines 138, 288, 424) — same, and remove `withRls` from `workers/automation/src/helpers.ts` (the cron handlers move in Unit 3).
- [ ] 2.5 `workers/wallet/src/drizzle-store.ts` — replace `openTenantSession` (lines 105-110) with a store whose methods run inside `withTenantTransaction(db, { businessId: tenantId, tenantId }, ...)`; update its 9 callers.
- [ ] 2.6 `workers/identity/src/branches.ts` and `business-signup.ts` — switch the existing correct `db.transaction` + `setCurrentBusinessId` blocks to the helper, so there is one pattern.
- [ ] 2.7 A contract test (e.g. `packages/db/src/rls-call-sites.contract.test.ts`) that reads every `workers/*/src/**/*.ts` (excluding tests) and fails on `withRls(` or `openTenantSession(`.
- [ ] 2.8 Update each touched worker's existing route tests so the mocked `db` exposes `transaction` and assertions run against the transaction handle.

## Unit 3: Phase 0 — cross-tenant jobs

- [ ] 3.1 `workers/communication/src/subscription-maintenance.ts` — enumerate `tenants` by keyset; per tenant, run the stale-subscription prune and the deleted-customer prune inside `withTenantTransaction(db, { businessId })`; keep the per-step failure capture and add the tenant id to the report. Fix the comment at lines 126-130 (a missing context errors, it does not return no rows).
- [ ] 3.2 `workers/wallet/src/drizzle-store.ts` — `listProgramTenants` and `listTenantsWithoutProgram` page over `tenants` and read the tenant's program row inside a tenant transaction; update the RLS notes in `workers/wallet/src/store.ts` (around lines 710, 750 and 881).
- [ ] 3.3 `workers/wallet/src/sweep.ts` and `workers/wallet/src/inactivity.ts` — per-tenant work runs through the tenant-scoped store from 2.5.
- [ ] 3.4 `workers/automation/src/cron-handler.ts` — `handleBirthdayCron` and `handleInactivityCron` replace `SELECT DISTINCT business_id FROM workflows` on a bare session with a `tenants` enumeration, then read workflows and customers per tenant inside the helper.
- [ ] 3.5 Tests: `subscription-maintenance.test.ts`, `sweep.test.ts`, `inactivity.test.ts`, `cron-handler.test.ts` — every query for tenant data is issued on a transaction handle that set that tenant; a failure for one tenant is reported with its id and the next tenant is still processed.

## Unit 4: Phase 0 — verification script

- [ ] 4.1 `scripts/check-rls.mjs` — read-only session (`SET default_transaction_read_only = on`, read back with `SHOW`, as `observeDatabase` does); report `relrowsecurity`, `relforcerowsecurity` and `tenant_isolation` presence for every listed table, plus `current_user`, `rolbypassrls` and the listed tables it owns; `--expect none|wallet|all|<batch>` turns the report into a pass/fail exit code. The table lists are read from `packages/db/src/rls.ts`, not copied.
- [ ] 4.2 `scripts/check-rls.test.mjs` — the report and the exit code for each expectation, against fixture catalog rows; a writable session is refused.
- [ ] 4.3 `package.json` — `"db:rls": "node scripts/check-rls.mjs"`. The test runs under the existing `Test operational scripts` step in `.github/workflows/ci.yml`.

## Unit 5: Phase 0 — drift gate evidence kinds

- [ ] 5.1 `scripts/check-migration-drift.mjs` — in `extractAssertions`, recognise `ALTER TABLE "<t>" ENABLE ROW LEVEL SECURITY` (`rls`) and `CREATE POLICY <p> ON "<t>"` (`policy`); add `rls: 'rlsTables'` and `policy: 'policies'` to `FACT_SET_FOR_KIND`; in `observeDatabase`, read `pg_class` (`relrowsecurity = true`, current schema) and `pg_policies` (`tablename || '.' || policyname`).
- [ ] 5.2 `scripts/check-migration-drift.test.mjs` — both statements extract the expected assertions; a missing policy is reported by `unsatisfiedBaseline`; `FORCE ROW LEVEL SECURITY`, `GRANT` and `CREATE ROLE` still throw.
- [ ] 5.3 `packages/db/src/migration-sql.test.ts` — keep the guard at line ~303 for `0004`; add an equivalent guard that no migration other than the explicit RLS ones contains `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY`.

## Unit 6: Phases 1–3 — role, shadow, wallet tables

- [ ] 6.1 `docs/09-Database-Design.md` §4 — runbook: create `vyloop_app` (LOGIN, NOBYPASSRLS, owns nothing), `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`, `GRANT USAGE ON ALL SEQUENCES`, `ALTER DEFAULT PRIVILEGES` for future tables; run on a Neon branch first; confirm with `pnpm db:rls`.
- [ ] 6.2 Phase 1: move the workers' `DATABASE_URL` GitHub secret (consumed by `.github/workflows/deploy.yml`) to the `vyloop_app` credential; keep the owner credential in a separate secret for the `migration-drift` job and the scripts. Record the decision in `docs/09` §4.
- [ ] 6.3 Phase 2: on a Neon branch of `ep-shiny-paper-aibbf0hk`, apply `enableRls()`, `createRlsPolicies()`, `enableTenantRls()` and `createTenantRlsPolicies()`; point a preview deploy at it; run the smoke flows and the wallet sweep; record the error count from the branch logs.
- [ ] 6.4 Phase 3: `packages/db/drizzle/<next>_wallet_rls.sql` (next free number) — `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY tenant_isolation` for the three `TENANT_ID_TABLES`; apply by hand; register in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `rls`/`policy` evidence; `pnpm db:drift` and `pnpm db:rls -- --expect wallet` green.

## Unit 7: Phase 4 — business tables and docs

- [ ] 7.1 One migration per batch (communication: `message_log`, `whatsapp_templates`, `push_subscriptions`; growth: `loyalty_programs`, `membership_tiers`, `points_transactions`, `rewards`, `reward_grants`, `referrals`, `checkins`, `settled_payments`, `pos_terminals`; the rest), each applied, registered and verified as in 6.4.
- [ ] 7.2 `docs/09-Database-Design.md` §4 — replace "Estado actual: RLS no está desplegado" with the state per table, the rollback statements, and the per-tenant-loop rule for scheduled jobs.
- [ ] 7.3 `docs/18-Trabajo-Pendiente.md` — move `tenant-isolation-rls` out of the pending table.
- [ ] 7.4 `openspec/specs/database/spec.md` — confirm the archived delta matches what was deployed.

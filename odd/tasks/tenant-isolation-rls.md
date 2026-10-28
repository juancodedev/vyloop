Objective: make Postgres RLS actually isolate tenants, following `openspec/changes/tenant-isolation-rls/` (proposal, specs, tasks: Units 1–7).
Branch: one per unit (`feat/rls-unit<N>-…`). Delivery: one PR per unit, stacked-to-main as the openspec tasks suggest (user: "con un pr aparte"). Runner: vitest per package (`npx vitest run`, Node 22).

## Specs

- S1 Unit 1 (openspec tasks 1.1–1.5): `withTenantTransaction(db, { businessId?, tenantId? }, fn)` in `packages/db/src/rls.ts`, exported from `@vyloop/db`; it opens `db.transaction`, issues `set_config` on the transaction handle before `fn`, never on the outer `db`, and throws if neither id is given. `withTenantRls` is deprecated. Table lists complete: `push_subscriptions` in `BUSINESS_ID_TABLES`, `wallet_callback_deliveries` in `TENANT_ID_TABLES`, `RLS_EXEMPT_TABLES` (`tenants`, `cross_loyalty_alliances`) with reasons; a test proves every schema table with `business_id`/`tenant_id` is in exactly one list. The policy predicate keeps `current_setting(...)` with no second argument (fail loud).
- S2 Unit 2: every runtime call site moves to the helper (openspec 2.1–2.10).
- S3 Unit 3: cross-tenant jobs loop per tenant (openspec 3.1–3.5).
- S4 Unit 4: read-only `pnpm db:rls` verification script (openspec 4.1–4.3).
- S5 Unit 5: drift gate learns `rls` / `policy` evidence (openspec 5.1–5.3).
- S6 Unit 6: `vyloop_app` role, Neon branch rehearsal, wallet-table migration (openspec 6.1–6.4). Remote and credential steps need the user's explicit authorization each time.
- S7 Unit 7: business-table migrations in batches, then docs (openspec 7.1–7.4).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1 | inline | done: RED (missing exports), then packages/db 281 tests, tsc, eslint green | PR #317 |
| T2 | S2 | delegated (parallel writers: growth, customer, communication, wallet) + inline (automation, identity, analytics, gateway, contract test) | done: RED per worker, then 2271 tests + tsc + eslint green in 9 packages; independent verifier (risk item 4) | 3d3c7e0..1f7a0fe |
| T3 | S3 | inline | pending | |
| T4 | S4 | inline | pending | |
| T5 | S5 | inline | pending | |
| T6 | S6 | inline (remote steps need authorization) | pending | |
| T7 | S7 | inline (remote steps need authorization) | pending | |

## Log

- L1 (2026-10-28) User: "veamos ahora lo de Queda la activación de RLS, con un pr aparte / lo de la espera de google, va a quedar así, hasta que ellos respondan".
- L2 Diagnosis (explorer, 2026-10-28): no migration enables RLS or creates policies; `withRls` and `withTenantRls` run `set_config(..., true)` outside a transaction; workers connect as `neondb_owner` without FORCE. Only identity sets the tenant correctly (`db.transaction` + `tx.execute(setCurrentBusinessId)`). Meanwhile `business_id` filters are the boundary (PRs #312–#314).
- L3 Uncommitted wallet demo-mode files (workers/wallet/wrangler.jsonc, its contract test, docs/18) belong to the Google Wallet case; they stay uncommitted until Google answers.
- L4 T1: the completeness test found only the two tables the openspec named (`push_subscriptions`, `wallet_callback_deliveries`); every other tenant table was already listed. The existing exact-list test for `TENANT_ID_TABLES` was updated to include `wallet_callback_deliveries`. The fail-loud predicate (1.5) was already asserted by the exact-string policy tests; a named test now states the intent.
- L5 T2 (2026-10-28) User: "vamos con la unidad 2". Route: four parallel writers (disjoint worker surfaces, each several hundred lines), the rest inline. Deviations: `business-signup.ts` keeps its own transaction (the business id is created inside it), listed as a contract-test exception with the automation crons (Unit 3). Growth `POST /v1/loyalty/rewards` relies on rollback instead of the compensating delete, which an aborted transaction could not run. `push-campaigns.ts` wallet-pass read and customer `/lookup` set `tenantId` too. docs/09 §4 records the gateway credential decision for Unit 6. Writes that must survive later failures keep separate transactions; no transaction spans a network call.

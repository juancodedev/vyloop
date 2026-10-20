# Tasks: Wallet Pass Correctness

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| Estimated changed lines | ~1100 (additions + deletions)                                               |
| 400-line budget risk    | High                                                                        |
| Chained PRs recommended | Yes                                                                         |
| Suggested split         | Unit 1 (balance) → Unit 2 (member code) → Unit 3 (operator API) → Unit 4 (dashboard) |
| Delivery strategy       | ask-on-risk                                                                 |

Decision needed before apply: Yes — the Google object state for a revocation (`INACTIVE` or `EXPIRED`), and how the backfill is invoked (operator script or one scheduled run).
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                              | Likely PR | Lines | Notes                                      |
| ---- | ------------------------------------------------- | --------- | ----- | ------------------------------------------ |
| 1    | Integer balance on build, patch and read-back     | PR #1     | ~200  | Independent.                               |
| 2    | Member code at registration, and the backfill     | PR #2     | ~300  | Independent of Unit 1.                     |
| 3    | Operator list, revoke and reissue endpoints       | PR #3     | ~400  | Independent of Units 1-2.                  |
| 4    | Dashboard pass-management view                    | PR #4     | ~250  | Needs Unit 3.                              |

## Unit 1: Integer balance

- [ ] 1.1 `workers/wallet/src/object.ts:129-138,273-276` — `LoyaltyPointsBalance` writes `{ int: number }`; the builder sends the validated integer instead of `formatBalance(...)`
- [ ] 1.2 `workers/wallet/src/balance.ts` — add `displayableBalance(points): number` that throws `BalanceNotDisplayableError` on the same `balanceDisplayFailure` predicate; keep `formatBalance` only if another caller still needs a string (grep before removing); update the module comment, which today says the field "is a **string**"
- [ ] 1.3 `workers/wallet/src/reconcile.ts:295-341` — replace `formatBalance`/`balanceStringOf` with numeric comparison via a new `balancePointsOf(object)` that reads `balance.int`, falls back to an all-digit `balance.string`, else `null`; patch with `{ int }`; compare the echo as a number in the post-condition
- [ ] 1.4 `workers/wallet/src/object.test.ts`, `reconcile.test.ts`, `balance.test.ts` — new pass carries `int` and no `string`; legacy `string` in sync is not patched; legacy out of sync is patched with `int`; a fractional or over-ceiling balance is still refused before Google
- [ ] 1.5 Verify against the Google Wallet REST reference whether the `int` echo is a JSON number or string, and keep `balancePointsOf` tolerant of both
- [ ] 1.6 `docs/14-Backlog.md:284-287` — mark the item resolved with the commit

## Unit 2: Member code at registration

- [ ] 2.1 `workers/wallet/src/index.ts` — export `ensureCustomerMemberCode({ tenantId, customerId }, env)` beside `reconcileCustomer` (default export at `:496-502`); it opens the tenant session (`openTenantSession` today; `withTenantTransaction` if `tenant-isolation-rls` landed first), reads `global_id` and `member_code`, and calls `ensureMemberCode` (`issuance.ts:317`)
- [ ] 2.2 `workers/growth/src/helpers.ts:48-50` — add `ensureCustomerMemberCode` to `WalletWorker`
- [ ] 2.3 `workers/growth/src/event-handler.ts` (`handleCustomerRegistered`) — after the ledger initialisation, call the binding; a missing binding or a thrown error is logged and swallowed, as `schedulePassReconcile` does (`helpers.ts:549-580`)
- [ ] 2.4 `workers/growth/src/event-handler.test.ts` (new; no handler test exists today) — the call is made with the internal customer id; a throwing binding does not fail the event; a missing binding does not fail the event
- [ ] 2.5 `workers/wallet/src/member-code-rpc.test.ts` (new) — idempotent on a second call; returns the stored code when one exists
- [ ] 2.6 `workers/wallet/src/issuance.ts:296-306` — rewrite the "When a code is created" comment: eager at registration through growth, lazy issuance kept as the guarantee
- [ ] 2.7 `workers/wallet/src/member-code-backfill.ts` — `backfillMemberCodes({ batchSize })` over the batch shape in `workers/wallet/sql/member-code-backfill.sql`, returning `{ claimed, skipped, remaining }`; export it from `index.ts`
- [ ] 2.8 `workers/wallet/src/member-code-backfill.test.ts` — claims only `NULL` codes, never changes a stored code, reports remaining, safe to re-run
- [ ] 2.9 Invocation path for the backfill (`scripts/backfill-member-codes.mjs` or a one-off scheduled run), run once in production, and record date and counts in the header of `workers/wallet/sql/member-code-backfill.sql`
- [ ] 2.10 `docs/14-Backlog.md:176-183` — mark the item resolved with the counts

## Unit 3: Operator pass API

- [ ] 3.1 `workers/wallet/src/object.ts:121-127,197-213` — add `revoked` to `PassTrackingState` and map it in `objectStateFor`
- [ ] 3.2 `workers/wallet/src/drizzle-store.ts` — `listPasses(tenantId, { limit, cursor, state })` with keyset pagination on `(updated_at desc, customer_id)` joined to `customers`; `markRevoked` / `markReissued` row writers
- [ ] 3.3 `workers/wallet/src/pass-admin.ts` — `revokePass` and `reactivatePass`: Google first, post-condition on the echoed state, then the tracking row (the pattern of `applyInactivityDeactivation`, `inactivity.ts:443-529`)
- [ ] 3.4 `workers/wallet/src/routes.ts` — `GET /v1/wallet/passes`, `POST /v1/wallet/passes/:customerId/revoke`, `POST /v1/wallet/passes/:customerId/reissue`, each behind `requireOperatorRole` (`helpers.ts:390`) and scoped to `auth.businessId`; 404 for a customer of another business
- [ ] 3.5 `workers/wallet/src/routes.ts:506` (`GET /v1/wallet/pass`) — answer 409 `WALLET_PASS_REVOKED` while the row is `revoked`
- [ ] 3.6 `workers/wallet/src/inactivity.ts` and `reconcile.ts` — confirm neither writes over `revoked`; add a test for each
- [ ] 3.7 `workers/wallet/src/pass-admin.test.ts` and `routes.test.ts` — operator-only (customer role gets 403 `OPERATOR_ROLE_REQUIRED`), tenant isolation, pagination cap 200, Google failure leaves the row unchanged, revoked → reissue → issued
- [ ] 3.8 `apps/gateway/src/wrangler-route-reachability.contract.test.ts` — passes unchanged (the new routes are under `/v1/wallet`); run it
- [ ] 3.9 `docs/08-API-Design.md` (Wallet section, ~line 141) — document the three routes and the new error code

## Unit 4: Dashboard view

- [ ] 4.1 `apps/dashboard/src/lib/api.ts` — `listWalletPasses`, `revokeWalletPass`, `reissueWalletPass` with typed responses
- [ ] 4.2 `apps/dashboard/src/lib/pass-state.ts` — add the `revoked` wording; keep `not_issued` and `not_saved` distinct
- [ ] 4.3 `apps/dashboard/src/app/dashboard/loyalty/passes/page.tsx` — the list, the next-page control, Reissue, Revoke with confirmation copy stating the pass stays on the phone marked inactive
- [ ] 4.4 `apps/dashboard/src/lib/navigation.ts` — add the entry to the loyalty section and its breadcrumb label
- [ ] 4.5 `apps/dashboard/src/__tests__/pass-state.contract.test.ts` (extend for `revoked`) and a pure helper test for the confirmation and pagination logic (the dashboard runs Vitest in `node`, per `pass-state.ts:6-10`)
- [ ] 4.6 `docs/14-Backlog.md:258-263` — mark the item resolved
- [ ] 4.7 Run `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`

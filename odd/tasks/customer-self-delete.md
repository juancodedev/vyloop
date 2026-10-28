Objective: a customer deletes their own account; deletion anonymises immediately (customer-profile-redesign 5.2-5.3).
Branch: feat/customer-self-delete. Delivery: single-pr (user approves PR per phase). Runner: vitest per package (`npx vitest run`, Node 22).
Design source: openspec/changes/archive/2026-10-27-customer-profile-redesign/design.md, "Account deletion (Phase 5)".

## Specs

- S1 Deleting anonymises at once, no grace period (user: "Inmediata"). `customers`: `full_name`, `phone`, `email`, `birth_date`, `identity_doc`, `identity_type`, `metadata`, `member_code` nulled (or emptied where the column is NOT NULL); `deleted_at` set. Kept without free text: `points_transactions.note`, `checkins.note`/`items` cleared. Cleared: `customer_events.payload`, `message_log.content`/`metadata`, `consents.ip_address`. Deleted: `push_subscriptions`, `churn_predictions`. One transaction.
- S2 A nulled phone frees `uq_customers_business_phone`: the same phone can register again as a new customer.
- S3 `DELETE /v1/customers/me` (customer token, `profile:write` scope at the gateway) and the merchant `DELETE /v1/customers/:id` share the same anonymisation.
- S4 Deleting an already deleted customer answers 204 and changes nothing in the database; it only retries a pending wallet expiry. Concurrent deletes converge.
- S5 After the transaction the Wallet pass is expired (Google object state EXPIRED, name removed); a failure is logged, never rolled back, and the pass stays not expired. The daily wallet sweep retries every pass of a deleted customer that is not expired yet.
- S6 A live token for a deleted customer gets 404 on reads and on `PATCH /v1/customers/me`. Check-ins, points assignment, redemptions and referrals refuse a deleted customer.
- S7 Web: "Eliminar mi cuenta" with an in-page confirm step that says the points are lost; on success the web signs out.
- S8 (from #294 review) worker test pinning the exact UTC+14 boundary; merge test asserting the starting profile has email and birth date.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1-S4, S6 (customer routes) | delegated: parallel units (writer trigger a) + context backstop | done | e99a4c6 |
| T2 | S5 | delegated: parallel units | done | 5a856f9 |
| T3 | S6 (growth writes) | delegated: parallel units | done | 609f4c5 |
| T4 | S3 gateway scope, S7, S8 | inline | done | e99a4c6, 387714e, last commit |
| T5 | all | independent verifier (Risk items 1, 3, 5) | done: S1-S8 PASS, no blockers | |

## Log

- L1 (2026-10-27) User: "Veamos 5.1, como podemos abordar eso?" → "Inmediata" → "Avanza".
- L2 Contract between T1 and T2: wallet worker exports RPC `expireCustomerPass(input: { tenantId: string; customerId: string })`, called by the customer worker through a new `WALLET` service binding under `waitUntil`, mirroring growth's `schedulePassReconcile`.
- L3 Verifier: S1-S8 PASS, no blockers. S7 caveat (balance unnamed without a currency) fixed with a test. Advisories left for the PR: customers soft-deleted before this change keep their data (needs a one-off backfill); the expiry retry takes the 100 oldest per run and can stall behind persistent failures; inactivity sweep and wallet pushes do not exclude deleted customers (baseline); read-then-insert race in points assign; `checkins.member_code` keeps the old code; Google's handling of `accountName: null` is unconfirmed against Wallet.

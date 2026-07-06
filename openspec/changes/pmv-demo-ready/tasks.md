# Tasks: PMV Demo Ready

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 450–550 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (backend + seed) → PR 2 (dashboard sell flow) → PR 3 (customer-web real data + redeem fix) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Backend endpoints + seed data | PR 1 | `feature/pmv-demo-backend`; unblocks all frontend work |
| 2 | Dashboard Registrar Venta modal | PR 2 | base = PR 1 branch; depends on `POST /points/assign` (already live) |
| 3 | Customer-web real profile, history, redeem fix | PR 3 | base = PR 1 branch; depends on `/me` + `/transactions` endpoints |

## Phase 1: Investigation & Foundation

- [ ] 0.1 Investigate `customer_id` FK mismatch: `points_transactions.customer_id` references `customers.id` (schema L129) but `POST /points/assign` inserts `body.customer_id` looked up via `customers.globalId` (routes L355, L380). Verify at DB level whether FK is enforced. Document finding and fix if needed (resolve `globalId` → `id` before insert, or confirm FK is not enforced).
- [ ] 1.1 Create `scripts/seed-demo.ts`: standalone seed using `@vyloop/db`. Accept `DATABASE_URL` env. Insert 3 tiers (Bronce 0/1.0x, Plata 500/1.5x, Oro 1000/2.0x), 3–5 rewards, 3 customers with wallets, ~5 transactions (earn+redeem mix). Use `ON CONFLICT DO NOTHING` on slug/phone for idempotency. Warn if targeting prod branch. ~180 lines.

## Phase 2: Backend Endpoints

- [ ] 2.1 Add `GET /v1/customers/me` to `workers/customer/src/routes.ts`. Register BEFORE `/:id` (before L209). Read `globalId` from `X-User-Id` via `extractAuthHeaders()`. Query customer by `global_id + business_id`. Join: latest `points_transactions.balance_after`, tier from `membership_tiers`, last 10 `customer_events`. Return per spec contract. ~45 lines.
- [ ] 2.2 Add `GET /v1/loyalty/points/transactions` to `workers/growth/src/routes.ts`. Use `extractAuthHeaders()` + `withRls()`. Support `?customer_id=`, `?type=earn|redeem`, `?page=`, `?per_page=`. Order by `created_at DESC`. Return `{ data, meta }` per spec contract. ~55 lines.

## Phase 3: Dashboard — Registrar Venta

- [ ] 3.1 Add `assignPoints(customerId, points, referenceId)` method to `apps/dashboard/src/lib/api.ts`. Calls `POST /v1/loyalty/points/assign`. ~12 lines.
- [ ] 3.2 Add "Registrar Venta" button + modal to `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx`. State: `showModal`, `amount`, `submitting`. Input validates non-empty/positive. On submit: `api.assignPoints(id, amount, sale-{id}-{ts})`. On success: close modal, refetch customer. ~90 lines.

## Phase 4: Customer Web — Real Data & Redeem Fix

- [ ] 4.1 Fix `redeemReward()` in `apps/customer-web/app/lib/api.ts`. Change payload from `{ rewardId }` to `{ customer_id, points, reward_id, reference_id }`. Accept `globalId` + reward object as params. Build `reference_id = redeem-{globalId}-{rewardId}-{ts}`. ~12 lines.
- [ ] 4.2 Add `getTransactions(filters?)` method to `apps/customer-web/app/lib/api.ts`. Calls `GET /v1/loyalty/points/transactions` with optional `?customer_id=&type=`. ~15 lines.
- [ ] 4.3 Wire `apps/customer-web/app/profile/page.tsx` to real data. Replace placeholder card (L37-41) with `api.getProfile()` fetch. Show points balance, tier name, total earned. Add loading state + error retry. ~40 lines changed.
- [ ] 4.4 Wire `apps/customer-web/app/profile/history/page.tsx` to real data. Replace empty `movements` state (L26) with `api.getTransactions()` fetch. Map API response to `Movement` type. Wire filter tabs to already-fetched data. Add loading + empty states. ~45 lines changed.

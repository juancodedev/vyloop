# Tasks: Rewards CRUD

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 660–820 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | DB schema + migration → API + events + auto-reward → Dashboard UI |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Base Boundary |
|------|------|-----------|---------------|
| 1 | DB schema + migration — `rewards`, `reward_grants` tables, indexes, RLS, drizzle migration, exports | PR #1 | main |
| 2 | API + events + auto-reward — 5 CRUD endpoints, redeem update, event constant, schema-registry, event builder, auto-reward hook in event-handler | PR #2 | main (chain after PR #1) |
| 3 | Dashboard UI — API client methods, rewards page (table + modal), sidebar nav, page title | PR #3 | main (chain after PR #2) |

## Phase 1: Foundation — DB Schema & Migration

- [x] 1.1 Add `rewards` table to `packages/db/src/schema.ts` — all columns, UUID PK, FK to tenants, unique(business_id, name), type exports
- [x] 1.2 Add `reward_grants` table to `packages/db/src/schema.ts` — id, business_id, customer_id, reward_id FK, unique(customer_id, reward_id), type exports
- [x] 1.3 Add indexes to `packages/db/src/indexes.ts` — `idxRewardsCategory`, `idxRewardsAutoGrant` (partial), `idxRewardGrantsCustomer` + add to `allIndexes`
- [x] 1.4 Add `rewards`, `reward_grants` to `BUSINESS_ID_TABLES` in `packages/db/src/rls.ts`
- [x] 1.5 Re-export new tables, types, indexes in `packages/db/src/index.ts`; run `drizzle-kit generate` → create `0003_windy_magus.sql`

## Phase 2: Core Implementation — API, Events & Auto-Reward

- [x] 2.1 Add `REWARD_AUTO_GRANTED` constant to `packages/event-bus/src/index.ts`
- [x] 2.2 Update `rewardRedeemedSchema` (`reward_id` required) + add `rewardAutoGrantedSchema` in `packages/schema-registry/src/index.ts`
- [x] 2.3 Add `buildRewardAutoGrantedEvent()` to `workers/growth/src/helpers.ts`
- [x] 2.4 Add 5 CRUD endpoints to `workers/growth/src/routes.ts`: POST/GET `/v1/loyalty/rewards`, GET/PUT/DELETE `/v1/loyalty/rewards/:id`
- [x] 2.5 Update redeem endpoint in `routes.ts`: accept `reward_id`, validate catalog (active, in-stock, valid dates, points match), atomic stock deduction via `UPDATE ... SET stock = stock - 1 WHERE stock > 0`, include `reward_id` in event
- [x] 2.6 Add auto-reward hook in `workers/growth/src/event-handler.ts` (`handlePointsAssigned`): query rewards where threshold <= balance, check `reward_grants` idempotency, insert grant + publish event

## Phase 3: Dashboard UI

- [x] 3.1 Add API client methods to `apps/dashboard/src/lib/api.ts`: `getRewards`, `createReward`, `updateReward`, `deleteReward`
- [x] 3.2 Create `apps/dashboard/src/app/dashboard/loyalty/rewards/page.tsx` — `'use client'` with table view (name, points_cost, category, stock, validity) + modal create/edit form + delete confirmation
- [x] 3.3 Update `apps/dashboard/src/app/dashboard/layout.tsx`: add "Recompensas" sidebar link in Loyalty section after tiers, add page title mapping for `/dashboard/loyalty/rewards`

## Phase 4: Seed Data

- [x] 4.1 Update `packages/db/scripts/seed.ts` — add 2–3 sample rewards (1 with auto_grant_threshold, 1 unlimited stock) for seeded businesses

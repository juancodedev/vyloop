# Tasks: Growth Engine

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,100 (45:55 add:del ratio) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 Foundation → PR 2 Worker → PR 3 Consumer → PR 4 Dashboard → PR 5 Tests |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Base |
|------|------|-----------|------|
| 1 | Event types + schemas + DB migration | PR 1 | main |
| 2 | Growth Worker infra + HTTP endpoints | PR 2 | main |
| 3 | Queue consumer (event-handler) | PR 3 | main |
| 4 | Dashboard nav + loyalty views | PR 4 | main |
| 5 | Integration tests | PR 5 | main |

## Phase 1: Foundation

- [x] 1.1 `packages/event-bus/src/index.ts` — Add `POINTS_ASSIGNED`, `REWARD_REDEEMED` constants; update tests
- [x] 1.2 `packages/schema-registry/src/index.ts` — Export `pointsAssignedSchema`, `rewardRedeemedSchema` (envelope format with header + payload, `$id` version `v1.0.0`)
- [x] 1.3 `packages/schema-registry/scripts/register-schemas.ts` — Add PointsAssigned + RewardRedeemed to `SCHEMAS_TO_REGISTER`; update tests
- [x] 1.4 `packages/db/src/schema.ts` — Add `currentTierId` column to `customers`; add `unique('uq_points_tx_reference').on(table.customerId, table.referenceId)` to `pointsTransactions`
- [x] 1.5 `packages/db/drizzle/` — Run `drizzle-kit generate` for new migration file

## Phase 2: Growth Worker Infra + HTTP Endpoints

- [x] 2.1 `workers/growth/package.json` — Add deps: hono, @vyloop/db, @vyloop/event-bus, @vyloop/schema-registry, drizzle-orm
- [x] 2.2 `workers/growth/wrangler.jsonc` — Add `DATABASE_URL`, `SCHEMA_REGISTRY` KV, queue consumer (vyloop-domain-events, max_concurrency:1, max_batch_size:5) + producer (DOMAIN_EVENTS_QUEUE)
- [x] 2.3 `workers/growth/src/helpers.ts` — Create Bindings type (DATABASE_URL, DOMAIN_EVENTS_QUEUE, SCHEMA_REGISTRY), AppEnv, extractAuthHeaders, buildPointsAssignedEvent, buildRewardRedeemedEvent, withRls
- [x] 2.4 `workers/growth/src/index.ts` — Rewrite to Hono app (customer worker pattern: auth middleware, 404, onError) + `queue()` export calling `consume()` + `event-handler.ts` dispatcher
- [x] 2.5 `workers/growth/src/routes.ts` — Loyalty Program Config CRUD (`GET/PUT /v1/loyalty/config`), Tier CRUD (`GET/POST/PUT/DELETE /v1/loyalty/tiers{/id}` with delete guard for assigned tiers, lowest-tier protection)
- [x] 2.6 `workers/growth/src/routes.ts` — Points Assign (`POST /v1/loyalty/points/assign` with atomic `balance_after = balance_after + N`, tier multiplier, referenceId dedup 409, publish PointsAssigned)
- [x] 2.7 `workers/growth/src/routes.ts` — Rewards Redeem (`POST /v1/loyalty/rewards/redeem` with balance check, partial redeem, referenceId dedup 409, publish RewardRedeemed)

## Phase 3: Queue Consumer

- [x] 3.1 `workers/growth/src/event-handler.ts` — `CustomerRegistered` handler: find lowest tier (min_points=0), upsert wallet with 0 balance, assign tier; create Bronze if none exists
- [x] 3.2 `workers/growth/src/event-handler.ts` — `PointsAssigned` handler: re-read total balance, find highest tier where min_points ≤ balance, update currentTierId if changed (downgrade never)

## Phase 4: Dashboard

- [x] 4.1 `apps/dashboard/src/app/layout.tsx` — Add sidebar nav with "Loyalty" section (Program Config, Tiers, Customer Points) after "Customers", before "Analytics"; active state highlight via `usePathname`
- [x] 4.2 `apps/dashboard/src/app/loyalty/config/page.tsx` — Inline edit form for earn_rate + program_name, persists via PUT /v1/loyalty/config
- [x] 4.3 `apps/dashboard/src/app/loyalty/tiers/page.tsx` — List tiers by display_order, create/edit/delete actions, error on delete-with-customers
- [x] 4.4 `apps/dashboard/src/app/loyalty/customers/page.tsx` — Paginated customer points list with search, current tier name, row links to `/dashboard/customers/{id}`

## Phase 5: Tests

- [ ] 5.1 `workers/growth/src/index.test.ts` — Unit: helpers auth extraction, event builders, points formula, RLS call
- [ ] 5.2 Integration: Miniflare tests for all HTTP endpoints (points assign, redeem, tier CRUD, config get/put, referenceId dedup → 409, insufficient balance → 409)
- [ ] 5.3 Integration: Miniflare queue tests (CustomerRegistered → wallet init, PointsAssigned → tier eval, idempotent registration)
- [ ] 5.4 Integration: Duplicate referenceId at DB level (second INSERT fails unique constraint → handler returns 409)
- [ ] 5.5 Integration: Partial redeem (INS-6 from spec) and insufficient balance (INS-7)

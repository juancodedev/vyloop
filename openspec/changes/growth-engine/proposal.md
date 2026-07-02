# Proposal: Growth Engine (Fase 2B)

## Intent

Implement the Growth Domain for Vyloop's loyalty engine — points assignment, redemption, membership tiers, wallet initialization, and dashboard views for loyalty management.

## Scope

### In Scope
1. **Growth Worker**: Hono router (follows customer worker pattern) + queue consumer (`queue()` export on `DOMAIN_EVENTS_QUEUE`) + atomic points mutations
2. **Endpoints**: `POST /v1/loyalty/points/assign`, `POST /v1/loyalty/rewards/redeem`, CRUD `/v1/loyalty/tiers`, loyalty program config endpoints
3. **Queue Consumer**: `CustomerRegistered` → initialize wallet in Bronze tier; `PointsAssigned` → evaluate tier upgrade
4. **Event Types**: Add `POINTS_ASSIGNED`, `REWARD_REDEEMED` constants to `@vyloop/event-bus`
5. **Schema Registry**: Export + register `PointsAssigned`, `RewardRedeemed` JSON Schemas (envelope format)
6. **DB Migration**: Add `current_tier_id` column to `customers` table
7. **Dashboard Views**: Loyalty program config, customer points list, tier management (Next.js app router)
8. **FIFO Per Customer**: Queue consumer concurrency keyed by `customer_id` for sequential event processing

### Out of Scope
- Cross-loyalty alliances (Fase 2+)
- Analytics / segmentation / RFM
- QR generation
- Points expiry cron job
- Tier downgrade logic (only upgrade on PointsAssigned)
- Schema format migration for existing `CustomerRegistered`

## Capabilities

### New Capabilities
- `growth-engine`: Growth Worker HTTP endpoints + queue event consumers for points, tiers, and wallet initialization
- `growth-dashboard`: Dashboard views for loyalty program configuration, customer points, and tier management

### Modified Capabilities
- `event-bus`: Add `POINTS_ASSIGNED`, `REWARD_REDEEMED` constants
- `schema-registry`: Add `PointsAssigned`, `RewardRedeemed` schemas (envelope format with header + payload)

## Approach

| Layer | Approach |
|-------|----------|
| Worker | Hono app (same pattern as `workers/customer`) — routes, helpers, RLS, auth extraction |
| Queue Consumer | Native `queue()` export on same Worker, uses `consume()` from `@vyloop/event-bus` |
| Points Mutations | Atomic SQL `SET balance_after = balance_after + N` inside transactions with `referenceId` UNIQUE constraint for idempotency |
| Tier Eval | On `PointsAssigned`, re-read customer's total balance, find matching tier from `membership_tiers` ordered by `min_points DESC`, update `current_tier_id` if changed |
| Wallet Init | On `CustomerRegistered`, upsert a `points_transactions` record with zero balance + assign Bronze tier |
| FIFO Ordering | Wrangler queue consumer concurrency set per `customer_id` (max 1 concurrent per key) |
| Dashboard | Next.js app router — server components fetching from gateway-bound growth worker |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `workers/growth/src/index.ts` | Modified | Rewrite to Hono app + queue export |
| `workers/growth/src/routes.ts` | New | Points assign/redeem, tier CRUD, program config |
| `workers/growth/src/helpers.ts` | New | Auth extraction, event builders, RLS, atomic points helpers |
| `workers/growth/src/event-handler.ts` | New | Queue consumer logic (CustomerRegistered → wallet, PointsAssigned → tier eval) |
| `workers/growth/wrangler.jsonc` | Modified | Add DATABASE_URL, SCHEMA_REGISTRY KV, DOMAIN_EVENTS_QUEUE consumer binding |
| `workers/growth/package.json` | Modified | Add @vyloop/db, @vyloop/event-bus, @vyloop/schema-registry, hono, drizzle-orm |
| `packages/event-bus/src/index.ts` | Modified | Export POINTS_ASSIGNED, REWARD_REDEEMED constants |
| `packages/schema-registry/src/index.ts` | Modified | Export reward_redeemed.json schema |
| `packages/schema-registry/scripts/register-schemas.ts` | Modified | Register new schemas |
| `packages/db/src/schema.ts` | Modified | Add `currentTierId` to customers table |
| `packages/db/drizzle/` | Modified | New migration for current_tier_id |
| `apps/dashboard/src/app/` | Modified | Add loyalty views (program config, customer points, tiers) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Points balance race condition (Neon connectionless) | Medium | `referenceId` UNIQUE constraint + atomic `balance_after = balance_after + N` SQL |
| Redeem double-spend | Medium | `referenceId` UNIQUE across (customerId, referenceId) + balance check before insert |
| Missed customer during deploy (first queue consumer) | Low | Wallet init is idempotent — upsert by customerId, no-op if already exists |
| Event ordering after retries | Low | `balanceAfter` is computed value (not read), tier eval re-reads actual balance |
| FIFO misconfiguration | Low | Wrangler `max_concurrency` per consumer key properly scoped to customer_id |

## Rollback Plan

1. **Revert DB migration**: `drizzle-kit drop` the `current_tier_id` column migration
2. **Revert Growth Worker**: Restore `workers/growth/src/index.ts` to placeholder `fetch()`
3. **Unregister schemas**: Remove PointsAssigned, RewardRedeemed from register-schemas.ts
4. **Remove event constants**: Revert event-bus POINTS_ASSIGNED, REWARD_REDEEMED additions
5. **Restore dashboard**: Git revert dashboard view additions
6. **Verify**: Gateway returns placeholder response for `/v1/loyalty/*`, no queue consumers active

## Dependencies

- `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry` packages published/available in monorepo
- `DOMAIN_EVENTS_QUEUE` queue exists (created in Fase 1)
- Gateway `/v1/loyalty` route already configured → growth binding (done in Fase 2A)
- Auth header injection active (done in Fase 2A)

## Success Criteria

- [ ] `POST /v1/loyalty/points/assign` creates transaction + emits `PointsAssigned` event
- [ ] `POST /v1/loyalty/rewards/redeem` deducts balance + emits `RewardRedeemed` event
- [ ] `CustomerRegistered` event consumed → wallet initialized with zero balance + Bronze tier
- [ ] `PointsAssigned` event consumed → tier upgraded when balance crosses threshold
- [ ] Redeem fails with `INSUFFICIENT_BALANCE` when points < amount
- [ ] `referenceId` prevents double-credit: second call with same referenceId returns 409
- [ ] Tier CRUD endpoints correctly scoped by `business_id`
- [ ] Dashboard views render loyalty program config, customer points, and tier management
- [ ] All tests green (`vitest run` in workers/growth, packages/event-bus, packages/schema-registry)

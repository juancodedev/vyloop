# Proposal: Rewards CRUD

## Intent

Rewards are implicit today — no catalog defines what customers can redeem points for. Merchants cannot create, edit, or manage rewards, and the auto-reward (threshold-based grant) pattern exists only as a concept. This change introduces a full rewards catalog: CRUD for merchants, catalog-validated redemption, and auto-reward grants triggered by points thresholds.

## Scope

### In Scope

1. `rewards` + `reward_grants` DB tables with RLS, indexes, Drizzle exports
2. 5 CRUD endpoints in growth worker: `POST/GET /v1/loyalty/rewards`, `GET/PUT/DELETE /v1/loyalty/rewards/:id`
3. Redeem endpoint update: validate `reward_id` against catalog (active, in-stock, valid-dates, points match), atomic stock deduction
4. Auto-reward logic in `handlePointsAssigned`: check `auto_grant_threshold`, insert `reward_grants` to prevent double-grant, publish `RewardAutoGranted` event
5. New `RewardAutoGranted` event type + schema registry entry
6. Dashboard rewards page at `/dashboard/loyalty/rewards` (table + create/edit modal)
7. Sidebar nav link + page title in dashboard layout

### Out of Scope

- Customer-web rewards redemption UI (canje page)
- Rewards analytics (most redeemed, stock alerts)
- Bulk import/export of rewards
- Reward image upload (URL only, storage by merchant)

## Capabilities

### New Capabilities
- `rewards-crud`: CRUD endpoints, catalog data model, DTOs, validation
- `rewards-auto-grant`: Auto-reward engine hook, RewardAutoGranted event, reward_grants tracking

### Modified Capabilities
- `growth-engine`: Redeem validates reward_id/stock; PointsAssigned handler gets auto-reward hook
- `database`: New `rewards` + `reward_grants` tables, indexes, RLS entries
- `growth-dashboard`: Rewards page at `/dashboard/loyalty/rewards`, sidebar nav
- `event-bus`: `RewardAutoGranted` event type constant
- `schema-registry`: Updated `rewardRedeemedSchema` (add reward_id, reward_name optional), new `rewardAutoGrantedSchema`

## Approach

**DB**: `rewards` table — FK to `tenants.id`, follows existing schema pattern (snake_case columns, camelCase TS, `pgTable`, UUID PK). `reward_grants` tracks customer × reward auto-grants for idempotency. Indexes on `(businessId, category)`, `(businessId, auto_grant_threshold)` where not null. Add both to `BUSINESS_ID_TABLES` in RLS. Drizzle migration generated via `drizzle-kit generate`.

**API**: 5 endpoints in `workers/growth/src/routes.ts` following existing tiers CRUD pattern — Hono router, `extractAuthHeaders`, `createDb`, `withRls`, manual validation, `{ data }` / `{ error }` response shape. Redeem endpoint updated to accept `reward_id`, look up `points_cost`/stock/valid dates, use atomic `UPDATE rewards SET stock = stock - 1 WHERE stock > 0` for race safety.

**Events**: Add `REWARD_AUTO_GRANTED` constant to event-bus. New `buildRewardAutoGrantedEvent()` in helpers. Register `rewardAutoGrantedSchema` in schema-registry.

**Auto-reward**: In `handlePointsAssigned` (event-handler.ts), after tier upgrade check, query rewards where `auto_grant_threshold IS NOT NULL AND auto_grant_threshold <= balance`. For each match, check `reward_grants` for existing grant (idempotency), then insert grant + publish event.

**Dashboard**: New `loyalty/rewards/page.tsx` — table view with name, points_cost, category, stock, validity dates. Modal form for create/edit with all fields. Sidebar link "Recompensas" added in loyalty section after "Niveles". Page title mapping in layout.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `packages/db/src/schema.ts` | Modified | Add `rewards` + `reward_grants` tables, type exports |
| `packages/db/src/indexes.ts` | Modified | Add rewards query indexes + `allIndexes` |
| `packages/db/src/rls.ts` | Modified | Add `rewards`, `reward_grants` to `BUSINESS_ID_TABLES` |
| `packages/db/src/index.ts` | Modified | Re-export new tables, types, indexes |
| `packages/db/drizzle/*` | New | Migration `0004_rewards.sql` |
| `workers/growth/src/routes.ts` | Modified | 5 new CRUD endpoints + redeem reward_id validation |
| `workers/growth/src/helpers.ts` | Modified | Add `buildRewardAutoGrantedEvent()` |
| `workers/growth/src/event-handler.ts` | Modified | Auto-reward hook in `handlePointsAssigned` |
| `packages/event-bus/src/index.ts` | Modified | Add `REWARD_AUTO_GRANTED` constant |
| `packages/schema-registry/src/index.ts` | Modified | Update `rewardRedeemedSchema`, add `rewardAutoGrantedSchema` |
| `apps/dashboard/src/lib/api.ts` | Modified | Add `getRewards`, `createReward`, `updateReward`, `deleteReward` |
| `apps/dashboard/src/app/dashboard/loyalty/rewards/page.tsx` | New | Rewards management page |
| `apps/dashboard/src/app/dashboard/layout.tsx` | Modified | Sidebar nav + page title for rewards |
| `packages/db/scripts/seed.ts` | Modified | Seed sample rewards |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Stock race condition on concurrent redeems | Med | Atomic `UPDATE ... SET stock = stock - 1 WHERE stock > 0` — no separate read-then-write |
| Points balance check timing (between tx read and insert) | Low | Single atomic SQL insert with `COALESCE((SELECT balance_after ...), 0) - points` — same pattern as existing redeem |
| Change size > 400 lines | High | Chain PRs: #1 DB schema + migration, #2 API + events + auto-reward, #3 Dashboard UI |

## Rollback Plan

1. Revert DB migration: `drizzle-kit drop` on new tables or run down migration
2. Revert API additions: `git revert` on routes.ts changes
3. Revert event type: remove `REWARD_AUTO_GRANTED` constant + schema
4. Revert dashboard: restore layout.tsx, delete rewards page

## Dependencies

- Existing growth worker queue infrastructure (unchanged)
- Existing event-bus publish/consume pattern (unchanged)
- Existing dashboard layout/auth pattern (unchanged)

## Success Criteria

- [ ] Merchant can create/edit/list/delete rewards via API and dashboard
- [ ] Redeem endpoint validates reward_id (active, in-stock, valid dates, points)
- [ ] Stock decrements atomically on redeem
- [ ] Customer reaching auto_grant_threshold receives reward automatically
- [ ] RewardAutoGranted event published and schema-registry validates
- [ ] No duplicate auto-grants (reward_grants idempotency)

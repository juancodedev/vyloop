# Exploration: Rewards CRUD

## Current State

The loyalty program has config, tiers, points, and a basic redeem endpoint — but no `rewards` catalog table, no CRUD endpoints, and no integration between the redeem flow and a rewards catalog.

## Affected Areas

### 1. DB Schema — `packages/db/src/schema.ts`

**Existing loyalty tables** (lines 100–162):
- `loyalty_programs` — config per business (1:1 with tenant), no `rewards` relationship
- `membership_tiers` — tier definitions per program, linked by `programId`
- `points_transactions` — ledger of earn/redeem entries, linked by `customerId` (note: uses `customers.globalId`, see below)
- `referrals` — referral tracking

**Naming pattern**: snake_case columns, camelCase TS names, `pgTable('plural_name', ...)`, UUID PKs with `defaultRandom()`, all tables have `businessId` + `createdAt` at minimum.

**BIG FINDING — Potential bug in existing points/assign**: The raw SQL insert at routes.ts:380 passes `${body.customer_id}::uuid` into `points_transactions.customer_id`, but `body.customer_id` was matched against `customers.globalId` (line 355), not `customers.id`. The FK constraint points to `customers.id`. This should be `customer.id` (internal PK) instead — same pattern used in `event-handler.ts:147`.

**No `rewards` table exists yet.** Must be added as new table.

**Type exports** (lines 228-273): Every table gets `$inferSelect` and `$inferInsert` types at the bottom.

### 2. DB Indexes — `packages/db/src/indexes.ts`

Indexes defined for: `customers` (phone, last_visit, metadata GIN), `points_transactions` (balance queries), `customer_events` (customer + type).

**Existing relevant index**: `idxPointsBalance` (lines 31-32) — composite on `(businessId, customerId, createdAt DESC)` for fast current-balance lookup.

**Will need**: A composite index on `rewards` for queries by `businessId + is_active` and `auto_grant_threshold`.

### 3. DB RLS — `packages/db/src/rls.ts`

- `BUSINESS_ID_TABLES` (lines 9-23): lists every table with `business_id` — `rewards` must be added here
- `setCurrentBusinessId(id)` (line 67): sets `app.current_business_id` session variable
- `enableRls()`, `createRlsPolicies()`, `dropRlsPolicies()` — standard helpers for RLS setup
- Every request that touches business-scoped tables calls `withRls(db, businessId)` (from `helpers.ts:132`)

### 4. DB Index — `packages/db/src/index.ts`

Exports: `createDb`, `schema` object, all table references, all `$inferSelect`/`$inferInsert` types, RLS helpers, and index definitions. The `rewards` table + types + index must be added to all export sections.

### 5. Growth Worker — `workers/growth/src/routes.ts`

**Pattern**: Hono router with `{ Bindings: Bindings }`, every handler:
1. `extractAuthHeaders(c)` → `{ userId, businessId, userRole }`
2. `createDb(c.env.DATABASE_URL)` → Drizzle instance
3. `withRls(db, businessId)` → set session variable
4. Validate body manually (no zod/validation library used)
5. Execute query
6. Return `c.json({ data: ... })` or error shape `{ error: { code, message } }`

**Request/Response shapes**:
- `GET /v1/loyalty/config` → `{ data: { earn_rate, program_name, ... } }`
- `PUT /v1/loyalty/config` → `{ data: { earn_rate, program_name } }`
- `GET /v1/loyalty/tiers` → `{ data: Array<tier> }`
- `POST /v1/loyalty/tiers` → `{ data: tier }` (201)
- `PUT /v1/loyalty/tiers/:id` → `{ data: tier }`
- `DELETE /v1/loyalty/tiers/:id` → `null` (204)
- `POST /v1/loyalty/points/assign` → `{ data: tx }` (201)
- `POST /v1/loyalty/rewards/redeem` → `{ data: tx, partial, fulfilled, requested }` (201)

**Existing redeem endpoint** (lines 433-581): `POST /v1/loyalty/rewards/redeem` — validates `customer_id`, `points`, `reference_id`. **No validation against a rewards catalog** — it accepts any `points` amount and `reward_name` is purely informational string. To connect with the catalog, this endpoint needs to:
- Accept a `reward_id` instead of/in addition to `points`
- Look up the reward's `points_cost` from the `rewards` table
- Verify the reward is active and in-stock
- Deduct stock on successful redemption

### 6. Growth Worker — `workers/growth/src/helpers.ts`

**Types** (lines 16-28): `AuthHeaders`, `Bindings` (DATABASE_URL, DOMAIN_EVENTS_QUEUE, SCHEMA_REGISTRY), `AppEnv`.

**Event builders** (lines 63-120):
- `buildPointsAssignedEvent()` — payload: `customer_id, points_assigned, points_multiplier, total_points, reference_id, assignment_id`
- `buildRewardRedeemedEvent()` — payload: `customer_id, points_redeemed, total_points_after, reference_id, partial, redemption_id, reward_name?`

**Note**: `buildRewardRedeemedEvent` takes `rewardName?: string` — would need to accept `rewardId` as well for catalog integration.

### 7. Growth Worker — `workers/growth/src/index.ts`

**Setup**: Hono app with global auth middleware (extracts headers), routes, not-found handler, error handler.

**Queue consumer** (lines 83-85): `queue()` → `consume(batch, handleEvent)` → dispatches to event handler.

### 8. Growth Worker — `workers/growth/src/event-handler.ts`

**Handlers**:
- `handleCustomerRegistered` (lines 54-176): creates wallet + assigns lowest tier
- `handlePointsAssigned` (lines 195-298): checks tier upgrade based on balance

**THIS IS WHERE AUTO-REWARD LOGIC HOOKS IN**: After the tier upgrade check in `handlePointsAssigned` (around line 295), we need to check if any reward has `auto_grant_threshold <= currentBalance` and hasn't been granted yet. This requires a new `reward_grants` table or a check against existing grants to avoid double-granting.

**The PointsAssigned flow**:
1. `POST /v1/loyalty/points/assign` (routes.ts:308) — inserts points_transaction + publishes PointsAssigned event
2. Queue delivers to `handlePointsAssigned` (event-handler.ts:195) — re-reads balance, checks tier upgrade
3. **Hook point**: after line 295 (or at the end of `handlePointsAssigned`), add auto-reward check.

### 9. Growth Worker — `workers/growth/wrangler.jsonc`

No changes needed unless we add new bindings (unlikely for rewards CRUD — it's all DB-backed).

### 10. Growth Worker — `workers/growth/package.json`

Dependencies: `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry`, `@vyloop/types`, `drizzle-orm`, `hono`. No changes needed.

### 11. Event Bus — `packages/event-bus/src/index.ts`

**Event types**: `CustomerRegistered`, `PointsAssigned`, `RewardRedeemed`.

**Note**: We may need a new event type like `RewardAutoGranted` for auto-reward notifications, or reuse `RewardRedeemed`. Adding a new event type means adding a constant here and a schema definition in `packages/schema-registry/src/index.ts`.

### 12. Gateway Router — `apps/gateway/src/router.ts`

**Route map** (lines 16-28): `/v1/loyalty` → `growth` service binding. **No changes needed** — all new endpoints (`/v1/loyalty/rewards`) will automatically route to the growth worker.

### 13. Dashboard API Client — `apps/dashboard/src/lib/api.ts`

**Pattern**: Functions grouped under `export const api = { ... }` with typed return types.

**Existing loyalty methods**:
- `getLoyaltyConfig()`, `updateLoyaltyConfig()` — `/v1/loyalty/config`
- `getTiers()`, `createTier()`, `updateTier()`, `deleteTier()` — `/v1/loyalty/tiers`
- `getCustomerPoints()` — customers with points

**Must add**: `getRewards()`, `createReward()`, `updateReward()`, `deleteReward()` — `/v1/loyalty/rewards`

### 14. Dashboard UI — `apps/dashboard/src/app/dashboard/loyalty/`

**Directory structure**:
```
loyalty/
├── config/page.tsx    — inline edit card for program config
├── tiers/page.tsx     — card grid + modal CRUD
├── customers/page.tsx — data table with pagination + search
```

**No `rewards/` subdirectory exists yet.** Must create `loyalty/rewards/page.tsx`.

**UI patterns**:
- All pages are `'use client'` with `useState`/`useEffect`
- Loading state: `<div className="card"><div className="card-body text-center text-muted">Cargando…</div></div>`
- Toast notifications: `{toast && <div className="toast-container"><div className={`toast toast-${toast.type}`}>{toast.message}</div></div>}`
- Modal pattern (from tiers page):
  ```tsx
  {modal && (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>...</h3><button className="modal-close" onClick={closeModal}>&times;</button></div>
        <div className="modal-body">...form fields...</div>
        <div className="modal-footer">...buttons...</div>
      </div>
    </div>
  )}
  ```
- Form fields: `<div className="form-group"><label>...</label><input className="form-control" .../></div>`
- Table pattern (from customers page): `card > table-container > table.data-table > thead + tbody`

**Dashboard layout** (`apps/dashboard/src/app/dashboard/layout.tsx`, lines 96-138): Sidebar has loyalty section with Config, Niveles (tiers), Puntos (customers) links. **Must add a Rewards nav link** in the loyalty section.

**Page title mapping** (layout.tsx lines 148-157): Must add a case for the rewards page.

### 15. DB Migrations — `packages/db/drizzle/`

**Migration chain**: 3 existing migrations via Drizzle Kit (`drizzle.config.ts` with `dialect: postgresql`, `out: ./drizzle`). New migration will be `0003_<name>.sql` generated by `drizzle-kit generate`.

### 16. Schema Registry — `packages/schema-registry/src/index.ts`

**Existing reward-related schema** (lines 246-270): `rewardRedeemedSchema` — JSON Schema v1.0.0 for the RewardRedeemed event envelope.

**Will need**: Either update `rewardRedeemedSchema` payload to include `reward_id` or create a new schema for `RewardAutoGranted`.

### 17. DB Seed — `packages/db/scripts/seed.ts` (existing)

Will need updates to seed sample rewards data.

### 18. Tests — `workers/growth/src/index.test.ts`

Currently just a scaffold test (`expect(true).toBe(true)`). The new endpoints and event handler changes should have proper tests.

## Gaps Identified

1. **No `rewards` table** — must be added to schema.ts + migration
2. **No rewards CRUD endpoints** — must be added to routes.ts
3. **Redeem endpoint doesn't validate against catalog** — must check `reward_id`, `points_cost`, stock, validity dates
4. **No auto-reward grant logic** — must hook into `handlePointsAssigned` in event-handler.ts
5. **No `reward_grants` table** — needed to track which rewards were auto-granted to which customers (idempotency)
6. **Dashboard has no rewards page** — must create `loyalty/rewards/page.tsx`
7. **Dashboard layout has no rewards nav link** — must add to sidebar + page title mapping
8. **No rewards API methods in dashboard client** — must add to `api.ts`
9. **Potential bug**: `points/assign` uses `body.customer_id` (globalId) in raw SQL instead of resolved PK — needs investigation
10. **No validation library** — manual validation in every handler (zod? custom helpers?)
11. **RLS list** — `BUSINESS_ID_TABLES` must include `rewards` and `reward_grants`
12. **DB index exports** — must add new index(es) for rewards queries
13. **Schema registry** — `RewardRedeemed` event schema payload may need `reward_id` field

## Approaches

1. **Simple CRUD + standalone auto-reward check**
   - Add `rewards` table + CRUD endpoints following existing tiers pattern
   - In `handlePointsAssigned`, add auto-reward check as a simple loop: find eligible rewards, check if already granted, insert grant record, optionally publish event
   - Pros: Follows existing patterns exactly, minimal new concepts
   - Cons: Auto-reward logic inline in event handler could grow complex
   - Effort: Medium

2. **CRUD + workflow-driven auto-reward**
   - Same CRUD + reward_grants table
   - Auto-reward logic dispatched via the existing workflow engine (`workflows` table) instead of hardcoded
   - Pros: More flexible, configurable by business users
   - Cons: Over-engineered for PMV, workflows table is generic and may not support this pattern yet
   - Effort: High

3. **CRUD + catalog-validated redeem only (no auto-reward)**
   - Build rewards table + CRUD + update redeem to validate against catalog
   - Skip auto-reward for now (auto-reward can be added later)
   - Pros: Smaller scope, lower risk
   - Cons: Leaves auto-reward for a future change, incomplete "rewards" story
   - Effort: Low-Medium

## Recommendation

**Approach 1** — Full CRUD + auto-reward check in event handler. It's the complete feature as requested, follows established patterns, and the auto-reward hook is a natural extension of the existing `handlePointsAssigned` flow. The `reward_grants` table keeps idempotency simple.

The redeem endpoint should be updated to:
1. Accept `reward_id` (optional — backward compat with existing callers)
2. If `reward_id` provided, validate the reward exists, is active, in stock, within valid dates, and that the points_cost matches the requested points
3. If reward is auto-grant (threshold), prevent manual redeem (or allow it — business decision)
4. Deduct stock atomically alongside points_transaction insert
5. Include `reward_id` in the RewardRedeemed event payload

## Risks

- **Risk: Existing points/assign uses globalId instead of PK** — if this is a real bug, fixing it could affect the auto-reward check (need to use the resolved `customer.id` from the `handlePointsAssigned` handler, which currently receives `customer_id` as the globalId but resolves `customer.id` internally)
- **Risk: Stock deduction race condition** — multiple simultaneous redeems of the same reward could over-deduct. Need atomic `UPDATE rewards SET stock = stock - 1 WHERE stock > 0` or use advisory lock
- **Risk: DB migration on a live table** — `rewards` is new so no migration risk per se, but adding `reward_grants` with FK to `rewards` and `customers` needs careful ordering
- **Risk: Schema registry update** — if we add `reward_id` to RewardRedeemed event, all existing events in the queue won't have it (backward compat needed)
- **Risk: Review budget** — Rewards CRUD + auto-reward + redeem update + dashboard page + layout changes likely exceeds 400 lines. Consider chained PRs: #1 = DB schema + migration, #2 = API endpoints + redeem update, #3 = Dashboard UI

## Ready for Proposal

**Yes** — full codebase understanding is complete. All touch points are identified.

Artifacts:
- `openspec/changes/rewards-crud/exploration.md` (this file)
- Engram `sdd/rewards-crud/explore`

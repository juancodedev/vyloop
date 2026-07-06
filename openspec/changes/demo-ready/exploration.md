## Exploration: demo-ready

### 1. Customer Web — Auth (mock → real)

#### Current State

**Customer-web uses 100% mock auth.** The `AuthProvider` in `app/lib/auth.tsx`:
- Reads a customer ID from `localStorage` key `vyloop_customer_id`
- Matches against a single hardcoded `MOCK_CUSTOMER` (`cust-005` / `Lucía Fernández`)
- `login(phone)` checks `getCustomerByPhone()` which only accepts `+56956789012`
- Profile page reads `MOCK_MOVEMENTS` and `MOCK_CUSTOMER` directly from `mock-data.ts`

**Registration** (`/register/page.tsx`) DOES call the real API: `PUT /v1/customers` to the gateway. But after registration, it redirects to `/confirm?name=...` without issuing any token or session — the user must manually navigate to `/login`.

**Gateway auth flow** (for dashboard users only):
1. `POST /v1/auth/token` in the identity worker validates email+password against the `users` table (PBKDF2), issues a JWT (HS256, `jose` library) with `sub`, `business_id`, `role`, `scopes`
2. Gateway middleware chain: JWT validation → header injection (X-User-Id, X-Business-Id, X-User-Role) → business-id enforcement → rate limiting → route dispatch
3. Public routes skip JWT: `/v1/auth/*`, `PUT /v1/customers`

**No customer JWT flow exists.** The JWT flow is exclusively for dashboard users with email/password credentials. Customers authenticate by phone number only — there is no phone-based token issuance endpoint.

**Customer-worker** (`workers/customer/`): Registration (`PUT /v1/customers`) creates a customer record and publishes a `CustomerRegistered` event. But it does NOT issue any token.

#### Affected Areas
- `apps/customer-web/app/lib/auth.tsx` — Mock AuthProvider, needs real JWT handling
- `apps/customer-web/app/lib/mock-data.ts` — Entirely mock, to be replaced
- `apps/customer-web/app/login/page.tsx` — Mock login flow
- `apps/customer-web/app/profile/page.tsx` — Uses mock data for movements
- `apps/customer-web/app/profile/history/page.tsx` — Likely uses mock data
- `workers/identity/src/index.ts` — Needs phone-based token endpoint
- `workers/identity/src/auth.ts` — JWT issuance (can be reused)
- `apps/gateway/src/middleware/auth.ts` — JWT validation (works for any JWT)
- `apps/gateway/src/index.ts` — Public route exemptions (may need adjustment)
- `apps/customer-web/package.json` — May need jose dependency

#### Approaches

1. **Phone-based JWT flow (OTP-style)** — Add `POST /v1/auth/customer/token` to identity worker that accepts phone + (future: OTP code). Issue customer JWT with role `customer` and limited scopes. Reuse the same JWT structure and gateway middleware.
   - Pros: Reuses existing gateway middleware chain, same security model, clean
   - Cons: Requires new endpoint + phone verification logic (even if simplified for demo)
   - Effort: Medium

2. **API-key based flow** — Customer-web sends a long-lived customer API key (generated at registration, returned in response). Gateway validates via API key → injects customer identity headers.
   - Pros: Simple, no OTP complexity, API key management already exists in identity worker
   - Cons: Less secure for customer-facing app, API keys can leak client-side
   - Effort: Low

3. **Minimal: localStorage + real balance endpoint** — Keep mock login but replace mock data with real API calls for points balance and movements. The login just stores customer ID, all subsequent reads come from the growth worker.
   - Pros: Fastest path to demo, no auth changes needed
   - Cons: Not real auth, won't scale, feels fake in demo
   - Effort: Low

#### Recommendation
**Approach 1** — Phone-based JWT. Even without real OTP, we can issue a JWT on successful customer lookup by phone for the demo. This validates the full auth chain end-to-end (gateway → identity → JWT → header injection → growth worker), which is what prospects will see. The identity worker already has the JWT issuance infrastructure; we just need a new endpoint that looks up customers by phone instead of users by email.

#### Risks
- Customer-worker uses `globalId` (uuid) not phone as primary identifier; need to resolve globalId from phone for JWT `sub`
- Gateway currently skips auth header injection for `PUT /v1/customers` — registration-after-login flow needs `PATCH` with JWT
- No password/secret for customers — JWT security depends on phone verification (for demo we can skip true OTP)

---

### 2. Customer Web — Reward Redemption

#### Current State

**Growth worker has a fully functional redeem endpoint** (`POST /v1/loyalty/rewards/redeem` in `workers/growth/src/routes.ts`):
- Catalog validation: reward exists, active dates, stock > 0, points cost ≤ requested points
- Balance check against `points_transactions` ledger
- Partial redemption support (`partial: true`)
- Atomic stock deduction within a transaction
- Dedup via `reference_id` unique per customer (unique constraint `uq_points_tx_reference`)
- Publishes `RewardRedeemed` event after success
- Both reward_id (catalog) and ad-hoc (just points, no reward) redemptions supported

**Rewards catalog endpoints** (`GET /v1/loyalty/rewards`):
- Supports `?category=`, `?active=true` filters
- Paginated with meta
- Validates reward lifecycle: `validFrom`, `validUntil`, `stock`, `deletedAt`

**But customer-web has NO reward redemption UI.** The profile page shows:
- Points balance
- Tier info and progress
- Recent movements (from mock)
- Link to history (no redeem)

**No reward catalog browsing** exists in customer-web.

**Points balance**: No dedicated endpoint. The redeem endpoint reads balance inline via `SELECT balance_after FROM points_transactions ... ORDER BY created_at DESC LIMIT 1`. A separate balance endpoint could be added.

**Customer-web pages structure:**
- `/` (landing) → `/login` or `/register`
- `/profile` → points, tier, recent movements, history link
- `/profile/history` → full movement history
- No `/redeem`, `/rewards`, or `/catalog` pages

#### Affected Areas
- `apps/customer-web/app/profile/page.tsx` — Add rewards section and redeem button
- `apps/customer-web/app/profile/redeem/` (new) — Reward catalog + redeem page
- `apps/customer-web/app/lib/mock-data.ts` — Replace mock movements with API calls
- `workers/growth/src/routes.ts` — May need minor adjustments (e.g., balance-only endpoint)
- `workers/growth/src/helpers.ts` — Already has event builders
- `apps/customer-web/app/lib/api.ts` (new) — API client for customer-web

#### Approaches

1. **Full catalog + redeem flow** — Add `/profile/rewards` page that calls `GET /v1/loyalty/rewards?active=true`, shows catalog, handles redeem flow, and confirms. Uses JWT to authenticate calls to growth worker.
   - Pros: Complete demo experience, shows the full product
   - Cons: More pages to build, needs auth first
   - Effort: Medium

2. **Quick-redeem from profile** — Add a "Canjear puntos" button on profile that opens a simple form (enter reward name/points). Uses the ad-hoc redeem path (no reward_id). Shows confirmation inline.
   - Pros: Fast to implement, demonstrates the core flow
   - Cons: Doesn't show catalog management, less impressive
   - Effort: Low

3. **Points balance endpoint + partial catalog** — Add `GET /v1/loyalty/points/balance` endpoint, show balance prominently, and a simple redeem-now button that uses the reward catalog.
   - Pros: Clean separation, reusable balance endpoint
   - Cons: Still needs the redeem UI regardless
   - Effort: Medium

#### Recommendation
**Approach 1** — Full catalog + redeem. The growth worker already has all the backend pieces (rewards CRUD, redeem with catalog validation). Building the UI to browse and redeem demonstrates the complete loyalty loop to prospects. Auth must be real first (Section 1).

#### Risks
- Customer-web images for rewards (image_url) may need CDN/upload setup
- Stock management: if multiple customers redeem simultaneously, stock decrement needs proper isolation (currently uses `stock - 1 WHERE stock > 0` inside a transaction — adequate for PMV)
- Points display mismatch: customer-web shows `customer.points` from mock, real data comes from `points_transactions`

---

### 3. Dashboard Analytics — KPIs

#### Current State

**Analytics worker is a COMPLETE PLACEHOLDER.** It returns `{ service: 'analytics', status: 'placeholder' }` with zero implementation. The gateway maps `/v1/analytics` to it but there are no routes.

**Dashboard has NO analytics/KPI pages.** Current dashboard pages:
- `/dashboard` → redirects to `/dashboard/customers`
- `/dashboard/customers` — Customer list (real API)
- `/dashboard/customers/[id]` — Customer detail (real API)
- `/dashboard/loyalty/config` — Program config (real API)
- `/dashboard/loyalty/tiers` — Tier management
- `/dashboard/loyalty/rewards` — Reward CRUD (real API)
- `/dashboard/loyalty/customers` — Customer points list (real API)
- `/dashboard/qr` — QR code page

**Dashboard uses real API** for most pages (via `src/lib/api.ts`). The `api.ts` client:
- Reads JWT from localStorage
- Uses Bearer token auth
- Calls gateway endpoints
- Has types for Customer, LoyaltyConfig, Tier, Reward

**Dashboard mock-data.ts** (`src/lib/mock-data.ts`) still exists but is only used by legacy pages — the current pages consume real API.

**DB data available for analytics** (all has `business_id` for RLS):
- `customers` — count, new registrations, tiers, lastVisitAt
- `points_transactions` — points issued (type='earn'), points redeemed (type='redeem'), balances
- `rewards` — available rewards, counts
- `reward_grants` — auto-granted rewards
- `membership_tiers` — tier definitions, customer distribution
- `customer_events` — event stream for activity tracking

**Current dashboard data-fetching pattern** (from `api.ts` and pages):
- `useEffect` + `useState` pattern in client components
- `api.*` functions call gateway endpoints with Bearer token
- `'use client'` directive on all dashboard pages
- No server components or server-side data fetching

#### Affected Areas
- `workers/analytics/src/index.ts` — Needs full analytics endpoint implementation
- `apps/dashboard/src/app/dashboard/analytics/` (new) — Analytics page(s)
- `apps/dashboard/src/app/dashboard/layout.tsx` — Add analytics nav item
- `apps/dashboard/src/lib/api.ts` — Add analytics API client methods
- `packages/db/src/schema.ts` — Data already available (customers, points_transactions, etc.)

#### Approaches

1. **Direct DB queries from analytics worker** — Analytics worker queries PostgreSQL directly for KPIs (COUNT customers, SUM points, etc.) via Drizzle. Exposes `GET /v1/analytics/kpi` returning aggregated metrics.
   - Pros: Simple, uses existing DB access pattern, real-time data
   - Cons: Can be slow on large datasets, no caching, no historical snapshots
   - Effort: Medium

2. **Event-sourced materialized views** — Consume domain events (CustomerRegistered, PointsAssigned, RewardRedeemed) to build materialized aggregate tables (daily_kpis). Analytics worker reads from aggregates.
   - Pros: Fast reads, historical trends, scales better
   - Cons: Higher initial complexity, needs event consumer in analytics worker, eventual consistency
   - Effort: High

3. **Hybrid: direct queries + KV cache** — Worker queries DB with caching via KV namespace. Cache invalidated on new events via the event queue (analytics worker consumes events to bust cache).
   - Pros: Better performance than pure direct, simpler than full materialized views
   - Cons: Add caching complexity without full event-sourcing benefits
   - Effort: Medium-High

#### Recommendation
**Approach 1** — Direct DB queries for PMV. The customer base for demo prospects will be small. We can add caching later. Focus on delivering meaningful KPIs:
- Total customers (new, active, churned)
- Points issued (total, period)
- Points redeemed (total, period, rate)
- Rewards claimed (count, type breakdown)
- Redemption rate (points redeemed / points issued)
- Tier distribution
- These are all simple SQL aggregations on existing tables.

#### Risks
- Business-day/month comparisons need date-truncation queries
- No pre-computed historical data — first queries will show only data from today
- Analytics worker needs its own DB connection (separate from other workers)

---

### 4. Growth Engine — Tests & Validation

#### Current State

**Growth worker tests are essentially non-existent.** `workers/growth/src/index.test.ts`:
```typescript
describe('Growth service', () => {
  it('is scaffolded', () => {
    expect(true).toBe(true);
  });
});
```

**Other workers have solid test coverage:**
- **Gateway**: 402 lines of tests covering JWT validation, rate limiting, event ingestor, routing, spoofed headers
- **Identity**: 238 lines covering JWT lifecycle (issue, validate, expire, malformed), token pairing, API key generation/validation, auth endpoint, /v1/me
- **Customer**: 973 lines — extensive tests for CRUD routes, auth headers, registration, event publishing, RLS isolation, soft deletes
- **DB package**: Schema snapshot tests, RLS helper exports, index definitions

**Test runner**: Vitest (v4.1.10) across all packages, with `globals: true` in most vitest configs. Standard pattern: `describe/it/expect` with `vi.mock` for external dependencies.

**Known issues with loyalty endpoints** (from code review):
- Points list in customer list (`GET /v1/customers`) returns `points: 0` for all customers — the `api.ts` client notes "Points not available in basic customer list — will improve later"
- The `getCustomerPoints()` function in dashboard `api.ts` calls the same endpoint but can't get real points
- No dedicated balance endpoint — every consumer has to query `points_transactions` directly with raw SQL
- `withRls()` helper is inconsistently applied: customer worker uses it in routes, growth worker uses it, but some routes might miss it
- `cross_loyalty_alliances` and `referrals` tables are defined in schema but have no API routes

**Areas lacking test coverage:**
- Growth worker routes (points assign, redeem, rewards CRUD, tiers CRUD, config CRUD)
- Event handler in growth worker (`CustomerRegistered` → wallet init, tier assignment, auto-rewards)
- Analytics worker (placeholder — entire implementation needed)
- Customer-web (no tests exist — `src/__tests__/` is empty)
- Dashboard (only a scaffold test `scaffold.test.ts`)

#### Affected Areas
- `workers/growth/src/index.test.ts` — Replace scaffold with real tests
- `workers/growth/src/routes.ts` — Need tests for all routes
- `workers/growth/src/event-handler.ts` — Need tests for event processing
- `workers/growth/vitest.config.ts` — May need adjustment

#### Approaches

1. **Test the critical paths first (MVP)** — Write tests for the 3 most critical endpoints: points assign, redeem, and rewards list. Use the same mock-DB pattern as customer worker tests.
   - Pros: Fast coverage on the highest-risk paths, follows established pattern
   - Cons: Leaves event handler and edge cases uncovered
   - Effort: Low-Medium

2. **Comprehensive test suite** — Test all routes (config, tiers CRUD, rewards CRUD, points assign, redeem, event handler) following customer-worker patterns. Add integration tests for the event queue interactions.
   - Pros: Confidence in all growth engine behavior, demonstrated quality for demos
   - Cons: Significant effort, may delay demo
   - Effort: High

3. **Contract/golden tests** — Write integration tests that hit the actual gateway with real JWTs and assert JSON response shapes. Use a test DB branch.
   - Pros: End-to-end confidence, tests the auth chain too
   - Cons: Requires DB setup, slower tests, more complex
   - Effort: High

#### Recommendation
**Approach 1** — Test critical paths first. Focus on:
- `POST /v1/loyalty/points/assign` — happy path, duplicate reference, validation errors
- `POST /v1/loyalty/rewards/redeem` — happy path (with and without reward_id), insufficient balance, out of stock, expired reward
- `GET /v1/loyalty/rewards` — pagination, active filter, category filter
- Follow the existing customer-worker test patterns (`vi.mock` for `@vyloop/db`, chain builders)

Status: The growth worker is the core engine for demos — it needs basic test coverage to protect against regressions during demo-ready changes.

#### Risks
- Mocking the raw SQL queries (used in points assign/redeem) is harder than mocking Drizzle queries — need `db.execute` mock patterns similar to customer-worker
- The `extractAuthHeaders` helper throws `HTTPException` — tests need to set X-* headers properly
- No existing test for the `handlePointsAssigned` or `handleCustomerRegistered` event handlers

---

### General Risks & Dependencies

1. **Auth is the gate**. Sections 1 and 2 both depend on customer JWT auth. Until auth is real, we can't securely call growth endpoints from customer-web.
2. **No analytics worker**. Section 3 requires building a new worker from scratch (it doesn't exist).
3. **Points data gap**. The customer list endpoint doesn't return current points. The dashboard shows `points: 0` for all customers in the customer list. This needs fixing before analytics are meaningful.
4. **DB migration risk**. Any new endpoints (customer JWT, analytics, balance) may require DB migrations. The DB is on Neon with serverless Postgres.
5. **Deployment coordination**. Changes span 3+ apps (customer-web, gateway, identity, growth, analytics) and must be deployed together.

### Ready for Proposal
**Yes** — we have deep understanding of all four areas. Each area has clear current state, affected files, and viable approaches with tradeoffs. The exploration is sufficient to write the proposal. Key next step: decide on the customer auth approach and the redeen/catalog UI before starting design.

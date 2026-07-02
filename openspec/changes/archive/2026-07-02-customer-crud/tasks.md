# Tasks: Customer CRUD

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 750-900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Foundation → PR 2: Gateway → PR 3: Customer Worker → PR 4: PWA |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed: resolved (user chose stacked-to-main)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | DB migration, schema, event-bus, schema-registry | PR 1 | ~60 lines, base=main |
| 2 | Gateway auth header injection | PR 2 | ~40 lines, base=main |
| 3 | Customer Worker CRUD + tests | PR 3 | ~550 lines, base=main |
| 4 | Customer-web PWA registration | PR 4 | ~180 lines, base=main |

## Phase 1: Foundation

### Task 1: DB Driver Migration

**Area**: `packages/db`
**File**: `packages/db/src/index.ts`
**Testing**: Unit
**Dependencies**: None

#### What
Migrate `createDb` from `postgres.js` to `@neondatabase/serverless` HTTP driver. Replace `postgres` import with `neon()` + `drizzle()` with ws transport.

#### Requirements
- [x] `packages/db/package.json` replaces `postgres` with `@neondatabase/serverless`
- [x] `createDb()` uses `neon(dbUrl)` HTTP client + `drizzle(client, { schema })`
- [x] Existing export surface unchanged (backward compat)
- [x] All existing schema tests pass

#### Test Notes
Update `index.test.ts` — `createDb` should accept a Neon pooled connection string. Verify exports unchanged.

### Task 2: Add `deletedAt` to Customers Schema

**Area**: `packages/db`
**File**: `packages/db/src/schema.ts`
**Testing**: None
**Dependencies**: None

#### What
Add `deletedAt: timestamp('deleted_at')` column (nullable, no default) to the `customers` table for soft-delete support.

#### Requirements
- [x] `customers` table has `deleted_at` column (nullable timestamp)
- [x] Drizzle `Customer` type includes `deleted_at` field
- [ ] Drizzle migration generated via `drizzle-kit generate`

#### Test Notes
Manual verify: schema snapshot test in `index.test.ts` should still pass (backward-compatible add).

### Task 3: Event Bus — CustomerRegistered Constant

**Area**: `packages/event-bus`
**File**: `packages/event-bus/src/index.ts`
**Testing**: None
**Dependencies**: None

#### What
Export `CUSTOMER_REGISTERED = 'CustomerRegistered'` constant alongside existing event bus API.

#### Requirements
- [x] `CUSTOMER_REGISTERED` constant exported from `@vyloop/event-bus`
- [x] Value exactly `'CustomerRegistered'`

#### Test Notes
Assert constant string matches expected value.

### Task 4: Schema Registry — CustomerRegistered Schema

**Area**: `packages/schema-registry`
**File**: `packages/schema-registry/src/index.ts`
**Testing**: Unit
**Dependencies**: None

#### What
Export `customerRegisteredSchema` (JSON Schema v1.0.0) with `customer_id` (uuid), `full_name` (string, minLength 1), `business_id` (uuid), all required. Add `CustomerRegistered` to registration script.

#### Requirements
- [x] `customerRegisteredSchema` object exported
- [x] All 3 fields required with correct types/format constraints
- [x] Registration script stores schema in KV under `CustomerRegistered:v1.0.0` and `CustomerRegistered:latest`

#### Test Notes
Test `validate()` passes for valid payload, fails for missing/empty/invalid fields per spec scenarios.

## Phase 2: Gateway Integration

### Task 5: Auth Header Injection Middleware

**Area**: `apps/gateway`
**File**: `apps/gateway/src/middleware/auth-inject.ts`
**Testing**: Unit
**Dependencies**: Task 1 (uses existing DB patterns)

#### What
Create middleware that strips incoming `X-User-Id`, `X-Business-Id`, `X-User-Role` headers, then injects them from `c.get('jwt')` claims (`sub` → `X-User-Id`, `business_id` → `X-Business-Id`, `role` → `X-User-Role`). Wire in `apps/gateway/src/index.ts` as middleware 3.5 (before `routerMiddleware`).

#### Requirements
- [x] Incoming `X-*` headers stripped before processing
- [x] Headers injected from `c.get('jwt')` claims before forwarding
- [x] Missing JWT claim omits header (does not fail)
- [x] Middleware placed between rate-limit and router in chain

#### Test Notes
Mock JWT context, assert forwarded request contains correct headers. Assert spoofed incoming headers are stripped.

## Phase 3: Customer Worker

### Task 6: Worker Config & Dependencies

**Area**: `workers/customer`
**File**: `workers/customer/wrangler.jsonc`
**Testing**: None
**Dependencies**: Task 1 (DB driver)

#### What
Update `wrangler.jsonc` with DB (Neon via env var), `DOMAIN_EVENTS_QUEUE` producer binding, `SCHEMA_REGISTRY` KV binding. Update `package.json` with `hono`, `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry`.

#### Requirements
- [x] `wrangler.jsonc` has DB env var, DOMAIN_EVENTS_QUEUE producer, SCHEMA_REGISTRY KV
- [x] `package.json` has all 4 new dependencies

#### Test Notes
Verify `wrangler.jsonc` parses as valid JSONC. Verify `pnpm install` resolves.

### Task 7: Worker Helpers

**Area**: `workers/customer`
**File**: `workers/customer/src/helpers.ts`
**Testing**: Unit
**Dependencies**: Task 6

#### What
Create helpers: `extractAuthHeaders()` (extract `X-User-Id`, `X-Business-Id`, `X-User-Role` from request headers, 403 if missing), `buildCustomerRegisteredEvent(customer, businessId)` (create event envelope with `createEnvelope`), `withRls(c, db)` (set business_id session variable).

#### Requirements
- [x] `extractAuthHeaders()` returns typed object or throws 403 error
- [x] `buildCustomerRegisteredEvent()` returns valid `EventEnvelope` with correct payload shape
- [x] `withRls()` calls `setCurrentBusinessId()` from `@vyloop/db`

#### Test Notes
Pure function unit tests. Test header extraction with valid/missing/spoofed headers.

### Task 8: CRUD Route Handlers

**Area**: `workers/customer`
**File**: `workers/customer/src/routes.ts`
**Testing**: N/A (tested via integration)
**Dependencies**: Task 7

#### What
Implement 5 route handlers:
- **upsert**: `PUT /` — query by `business_id + phone`, insert or update. Insert generates `global_id`, publishes CustomerRegistered via event-bus + schema-registry validation.
- **list**: `GET /` — paginated (`?page`, `?limit`, defaults 1/20), search by `?q=` on name/email/phone, exclude soft-deleted.
- **profile**: `GET /:id` — return customer + `customer_events` + `consents`, 404 if deleted.
- **patch**: `PATCH /:id` — partial update (spread body), ignore `business_id`.
- **delete**: `DELETE /:id` — set `deleted_at = now()`, return 204.

#### Requirements
- [x] Upsert: insert new row with `global_id` + publish event on first registration
- [x] Upsert: update existing row + skip event on repeat
- [x] List: paginated with `page`/`limit`, search with `?q=`
- [x] List: excludes soft-deleted customers
- [x] Profile: returns customer + events + consents
- [x] Profile: 404 for soft-deleted or cross-business
- [x] Patch: only sets provided fields
- [x] Delete: sets `deleted_at`, returns 204
- [x] Event only published after schema validation passes

#### Test Notes
Integration tests via miniflare with mock bindings.

### Task 9: Worker Main (Hono App)

**Area**: `workers/customer`
**File**: `workers/customer/src/index.ts`
**Testing**: N/A (tested via Task 10)
**Dependencies**: Task 8

#### What
Rewrite `index.ts` as a Hono app with typed `Bindings` (DB URL, QUEUE, KV). Apply `extractAuthHeaders` middleware globally, mount route handlers from `routes.ts`. Add 404 and error handlers.

#### Requirements
- [x] Hono app exported as default
- [x] `Bindings` type includes `DATABASE_URL`, `DOMAIN_EVENTS_QUEUE`, `SCHEMA_REGISTRY`
- [x] Auth header extraction middleware runs on all routes
- [x] 404/error handlers return JSON error responses

#### Test Notes
Integration tests cover this.

### Task 10: Customer Worker Tests

**Area**: `workers/customer`
**File**: `workers/customer/src/index.test.ts`
**Testing**: Integration
**Dependencies**: Task 9, Task 2 (deletedAt), Task 3 (event constant), Task 4 (schema)

#### What
Rewrite tests with vitest. Unit tests for helpers (extractAuthHeaders, event creation). Integration tests for all 5 CRUD endpoints via miniflare (mock DB, queue, KV). Cover spec scenarios: first-time registration (201 + event), repeat upsert (200 + no event), paginated list, search, soft-delete exclusion, 360° profile, cross-business isolation (404), partial update, delete hides from list, get after delete returns 404, invalid schema rejected.

#### Requirements
- [x] All 11 spec scenarios covered with assertions
- [x] Helper unit tests for `extractAuthHeaders` and event creation
- [x] Integration tests use mock bindings (vitest)
- [x] Cross-business isolation verified (RLS scenario)

#### Test Notes
Mock `@neondatabase/serverless` client, mock Queue binding, mock `SCHEMA_REGISTRY` KV with pre-registered schema. Use `SELF` URL for in-worker requests.

## Phase 4: Customer-Web PWA

### Task 11: Landing Page

**Area**: `apps/customer-web`
**File**: `apps/customer-web/app/page.tsx`
**Testing**: None
**Dependencies**: None

#### What
Replace placeholder with QR scan placeholder image + "Start Registration" button linking to `/register`. Mobile-first responsive layout.

#### Requirements
- [ ] QR placeholder image or icon displayed
- [ ] "Start Registration" button visible
- [ ] Fits 320px+ viewports without horizontal scroll
- [ ] Touch targets ≥ 44x44px

#### Test Notes
Manual: render at 375px width, verify layout. No horizontal scroll.

### Task 12: Registration Form Page

**Area**: `apps/customer-web`
**File**: `apps/customer-web/app/register/page.tsx`
**Testing**: None
**Dependencies**: Task 11

#### What
Create form with `fullName` (required), `phone` (required), `email` (optional), `birthDate` (optional). On submit, `POST` to gateway `/v1/customers` (via fetch). On success, redirect to `/confirm` with customer name in query/state. Show inline validation errors for missing required fields.

#### Requirements
- [ ] All 4 fields rendered with labels
- [ ] Required fields show validation error on submit if empty
- [ ] Valid submission calls `POST /v1/customers` via gateway
- [ ] Successful registration redirects to `/confirm`

#### Test Notes
Manual: enter valid data, verify POST call. Submit empty form, verify error.

### Task 13: Confirmation Screen

**Area**: `apps/customer-web`
**File**: `apps/customer-web/app/confirm/page.tsx`
**Testing**: None
**Dependencies**: Task 12

#### What
Display customer name from query params or router state, show "Thank you" message with registration summary.

#### Requirements
- [ ] Customer name displayed from registration response
- [ ] Thank-you message shown
- [ ] Mobile-first responsive

#### Test Notes
Manual: navigate from form, verify name shown.

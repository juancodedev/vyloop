# Exploration: Customer CRUD (Fase 2A)

## Current State

### Infrastructure Already in Place (reused, not built)

The following infrastructure from Fase 1 is ready and needs zero changes for customer-crud:

| Component | Status | Details |
|-----------|--------|---------|
| **DB schema** | ✅ Complete | `customers`, `customer_events`, `consents` tables with all columns, FKs, unique constraints, RLS-ready |
| **DB package** | ✅ Complete | `createDb()`, RLS helpers, indexes exported from `@vyloop/db` |
| **Gateway routing** | ✅ Complete | `/v1/customers` → `customer` service binding in gateway's `ROUTE_MAP` and `wrangler.jsonc` |
| **Gateway middlewares** | ✅ Complete | JWT auth → business-id check → rate limit → route dispatch. `c.get('jwt')` injects `JwtClaims` (sub, business_id, role, scopes) |
| **Event bus** | ✅ Complete | `publish()`, `createEnvelope()`, `EventEnvelope` type - all reusable |
| **Schema registry** | ✅ Complete | `customer_registered.json` schema already exists at `packages/schema-registry/src/schemas/` |
| **Types** | ✅ Complete | `CustomerId`, `BaseEvent`, `Entity` branded types in `@vyloop/types` |
| **Customer service binding** | ✅ Configured | Gateway `wrangler.jsonc` has `{ "binding": "customer", "service": "customer" }` |

### What Needs Work

| Area | Current State | Gap |
|------|-------------|-----|
| **Customer Worker** | Placeholder returning `{ service: 'customer', status: 'placeholder' }` | No DB bindings, no Hono router, no CRUD logic, no event publishing |
| **Customer Worker config** | `wrangler.jsonc` — no bindings defined | Needs DB URL (Neon), `DOMAIN_EVENTS_QUEUE` binding, `SCHEMA_REGISTRY` KV binding |
| **Customer Worker deps** | Only `@vyloop/types` | Needs `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry`, `hono` |
| **Tests** | Scaffold test (`expect(true).toBe(true)`) | Needs full CRUD tests, event emission tests, 360° profile tests |
| **Event schema** | `customer_registered.json` exists | Schema looks correct for `CustomerRegistered`, but need to verify header format aligns with `EventEnvelope` vs the schema's own header format (they differ — see Risks) |
| **API design** | Defined in `docs/08-API-Design.md` | Endpoints listed but not implemented |
| **360° profile** | `customer_events` table has indexes for this | No endpoint to join customer + events + consents in one call |

## Affected Areas

### Primary (must change)

- `workers/customer/src/index.ts` — Placeholder → Customer CRUD worker (Hono app, DB queries, event publishing)
- `workers/customer/wrangler.jsonc` — Add Neon DB binding, `DOMAIN_EVENTS_QUEUE` producer, `SCHEMA_REGISTRY` KV binding
- `workers/customer/package.json` — Add deps: `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry`, `hono`
- `workers/customer/src/index.test.ts` — Rewrite with full test coverage

### Secondary (might change)

- `packages/db/src/index.ts` — Already exports `Customer`/`NewCustomer` types and `customers` table — may need query helpers added
- `packages/types/src/index.ts` — May want to add `CustomerResponse` or API-facing types (or define in the worker itself)
- `packages/schema-registry/src/schemas/customer_registered.json` — Verify header schema compatibility with `EventEnvelope` format. The schema expects `header.event_id`, `header.event_type`, `header.event_version`, etc. but `EventEnvelope` has `id`, `type`, `source`, `specversion` as top-level fields and `header.business_id`. These must be reconciled.
- `apps/gateway/src/index.ts` — Verify `/v1/customers` routes are not blocked by middleware (they use `/v1/*` middleware chain which already skips `/v1/auth/` only — customers are protected)

### Not Affected (deferred)

- `apps/customer-web/` — PWA landing is a separate change (Fase 2B or 2C)
- `apps/dashboard/` — Customer list view is separate
- `workers/identity/` — No auth changes needed for this phase
- `packages/event-bus/` — Already complete
- All other workers and packages

## Approaches

### Approach 1: Direct CRUD in Customer Worker (Recommended)

Implement all CRUD endpoints + CustomerRegistered event + 360° profile directly in the customer worker using Hono, Drizzle, and the event-bus package.

- **Endpoints to implement** (per `docs/08-API-Design.md`):
  - `GET /v1/customers` — List with filters (initially simple: all customers for business, with search by name/phone/email)
  - `POST /v1/customers` — Create + publish `CustomerRegistered` event
  - `GET /v1/customers/{id}` — 360° profile (customer + events + consents)
  - `PATCH /v1/customers/{id}` — Update profile
  - `DELETE /v1/customers/{id}` — Soft delete / GDPR removal
  - `GET /v1/customers/{id}/events` — Timeline events
  - `POST /v1/customers/{id}/consents` — Consent registration
- **Pros**: Simple, all in one place, no indirection. Follows existing patterns (gateway's ingestor uses the same event-bus + schema-registry packages)
- **Cons**: Customer worker holds both query and command logic. May want CQRS separation later.
- **Effort**: Medium (~500-600 changed lines across all files)

### Approach 2: Separate Query Service

Split the 360° profile endpoint into a dedicated read-model worker, keeping the customer worker for writes only.

- **Pros**: Clean CQRS separation, read model can be optimized differently
- **Cons**: Premature for PMV — two workers to deploy and maintain. The `customer_events` indexes already support fast 360° queries on the same DB.
- **Effort**: High (two workers, additional service binding, more deploy complexity)

### Approach 3: Inline in Gateway (Not Recommended)

Handle customer CRUD directly in the gateway instead of routing to a customer worker.

- **Pros**: Fewer moving parts
- **Cons**: Violates DDD bounded context isolation. Gateway becomes monolith. Noisy neighbor risk. Doesn't scale.
- **Effort**: Low initially, high refactor cost later

## Recommendation

**Approach 1** — Direct CRUD in the Customer Worker. Rationale:

1. It's what the architecture designed for: the gateway routes, the domain worker handles business logic.
2. The `customer` service binding already exists in the gateway. The worker is literally a placeholder.
3. DB layer (@vyloop/db), event bus (@vyloop/event-bus), and schema registry (@vyloop/schema-registry) are all designed and ready to be consumed.
4. Splitting into read/write (Approach 2) is premature without evidence of performance need.
5. The scope is well-bounded and testable.

## Key Technical Details Discovered

### How auth context flows to workers

From `apps/gateway/src/middleware/auth.ts`:
- JWT is validated, decoded as `JwtClaims` (sub, business_id, role, scopes)
- Set via `c.set('jwt', claims)` in Hono context
- The `businessIdMiddleware` validates `X-Business-ID` header matches JWT
- When routing to a service worker (`binding.fetch(request)`), the **original request is forwarded as-is** with all headers — so the worker receives the original `Authorization` and `X-Business-ID` headers
- **However**, the forwarded request does NOT include decoded JWT claims — the receiving worker would need to either:
  a. Re-validate the JWT (duplicating auth logic), or
  b. Have the gateway inject claims as headers before forwarding

This is a **design decision to make**: does the customer worker re-validate the JWT, or does the gateway pass trusted claims? Current architecture doc implies the gateway is the auth boundary, but the worker receives raw requests.

### EventEnvelope vs customer_registered.json schema mismatch

**`packages/event-bus/src/index.ts`** defines `EventEnvelope`:
```
{ id, type, source, specversion, time, header: { business_id, timestamp, localization? }, payload }
```

**`packages/schema-registry/src/schemas/customer_registered.json`** defines the schema that the **Event Ingestor** validates against:
```
{ header: { event_id, event_type, event_version, business_id, timestamp }, payload: { customer_id, full_name, ... } }
```

These are **different formats**. The `customer_registered.json` schema validates data as it arrives at the ingestor endpoint (`POST /v1/events/customer_registered`). The `EventEnvelope` is the internal format used for Queue messages.

For the customer worker publishing `CustomerRegistered`:
- The worker creates an `EventEnvelope` via `createEnvelope()`, passing the payload
- This goes directly to `DOMAIN_EVENTS_QUEUE` — it does NOT go through the ingestor endpoint
- Therefore the `customer_registered.json` schema in KV is only for external ingestion, not for internal publication

**This means**: The worker does NOT need to validate against the schema registry when publishing internally. The schema is for external POST calls. The worker just uses `publish()` + `createEnvelope()`.

### RLS setup

From `packages/db/src/rls.ts`:
- Business isolation is at DB level via `SET LOCAL app.current_business_id = '<uuid>'`
- Every query on `business_id`-scoped tables automatically filters by this session variable
- The customer worker must call `setCurrentBusinessId()` before any DB query, using the `business_id` from the request context

### DB query pattern

From `packages/db/src/index.ts`:
- `createDb(dbUrl)` creates a Drizzle client with postgres.js
- All tables and types are re-exported
- The customer worker will need to:
  1. Create a DB client at request time (or per-worker-instantiation)
  2. Set the current business ID via RLS
  3. Use Drizzle query builder for CRUD

## Risks

1. **Header mismatch risk (Schema)** — The `customer_registered.json` expects `header.event_id`/`header.event_type`/`header.event_version`/`header.business_id`, but the event-bus `createEnvelope()` produces top-level `id`/`type`/`specversion` with `header.business_id` inside. If anyone publishes via the ingestor endpoint (`POST /v1/events/customer_registered`), the schema validation expects one format while the Queue consumer receives another. However, for this change, the worker publishes internally (bypassing the ingestor), so the schema mismatch between the two formats is not a blocker. **Mitigation**: The spec/design phase should clarify that `customer_registered.json` is for external ingestor validation only, and consumers subscribe to the Queue which delivers `EventEnvelope` format.

2. **JWT re-validation** — The gateway forwards the raw request to the customer worker. The worker receives headers (Authorization, X-Business-ID) but the JWT is NOT decoded again. The worker must either re-validate the JWT (needs the JWT_SECRET) or trust the gateway to pass claims. **Decision needed**: Does the gateway inject decoded claims as headers (e.g., `X-JWT-Claims`), or does every worker re-validate?

3. **DB connection management** — Drizzle + postgres.js in a Workers environment needs careful handling. Postgres connections in Workers are not long-lived — the worker is ephemeral and each request may get a different isolate. The worker should create a fresh connection per request (or use Neon's serverless driver for connection pooling). **Mitigation**: Investigate using `@neondatabase/serverless` with Drizzle instead of raw `postgres.js`, or ensure connection pooling via Neon's pooled connection string.

4. **Scope/Business-ID propagation** — The route dispatcher (`router.ts`) forwards the raw request to the service binding. The customer worker receives `X-Business-ID` header but has NO access to the `role` or `scopes` from the JWT unless the gateway injects them or the worker re-validates. This is relevant for PATCH/DELETE authorization (e.g., cashier vs admin).

5. **global_id generation** — Already handled at schema level (`defaultRandom()`), but the response should include the generated `global_id` so the client/PWA can use it.

6. **Event ordering** — When creating a customer, the DB insert and event publish are not atomic. If the publish fails after DB insert, there's an orphan customer (no `CustomerRegistered` event). **Mitigation**: The Queue retry mechanism + idempotent consumers handle downstream. For the DB itself, consider wrapping in a transaction, though Queue publish cannot be rolled back with the DB transaction.

## Questions (decisions needed before planning)

1. **JWT trust boundary**: Should the gateway inject JWT claims as headers for downstream workers? Or should each worker validate the JWT independently (requires passing JWT_SECRET to every worker)? **Recommendation**: Gateway injects `X-JWT-Claims` header (base64-encoded JSON) so workers don't re-validate. This keeps auth centralized.

2. **Advanced filtering in GET /customers**: The backlog says "filtros avanzados de segmentación (AND/OR)" for Fase 3. For Fase 2A, should GET /customers support simple search (by name, phone, email) only, or the full advanced segmentation? **Recommendation**: Simple search + pagination for Fase 2A. Advanced segmentation is Fase 3 (per backlog).

3. **Customer deletion semantics**: DELETE /v1/customers/{id} — hard delete, soft delete (mark inactive), or anonymization (GDPR)? `customer_events` has `ON DELETE CASCADE` so hard-deleting a customer removes their events. **Recommendation**: Anonymization (null out PII fields, keep the row + events for analytics) — this is the GDPR/LGPD-compliant approach and matches the "cumplimiento GDPR/LGPD" note in the API design doc.

4. **360° shape**: What data should `GET /v1/customers/{id}` return? Options:
   - Customer profile only
   - Customer + recent events (paginated)
   - Customer + events + consents + points balance
   **Recommendation**: Customer profile + paginated events + consents. Points balance can be added when the growth domain is ready (or stubbed as `null`).

5. **CustomerRegistered event payload**: Should it include ALL customer fields or only a subset? The schema defines customer_id, full_name, phone, email, birth_date, identity_doc, identity_type, language, metadata. **Recommendation**: Match the schema exactly — send all provided fields but only require customer_id + full_name.

6. **DB driver**: Which Postgres driver should the customer worker use? `postgres.js` (as in @vyloop/db) needs a socket — works in Workers but needs connection pooling. Neon's `@neondatabase/serverless` or `ws`-based transport? **Recommendation**: Investigate compatibility during design phase. The `@vyloop/db` package wraps `postgres.js` which works in Workers with Neon's pooled connection string.

## Estimated Scope

| Category | Files | Estimated Changed Lines |
|----------|-------|----------------------|
| Worker implementation | `workers/customer/src/index.ts` | ~350-400 |
| Worker config | `workers/customer/wrangler.jsonc` | ~20 |
| Worker deps | `workers/customer/package.json` | ~10 |
| Tests | `workers/customer/src/index.test.ts` | ~200-300 |
| **Total** | **4 files** | **~580-730 lines** |

## PR Split Recommendation

**Single PR** — the scope is within the 400-line budget guard (barely at ~580-730, but most of the lines are test boilerplate which is less review-burden per line than production logic). However, if we include the DB driver migration or JWT re-validation infrastructure, it may push over.

**Option A**: Single PR ~600-700 lines (acceptable if tests are straightforward)
**Option B**: Split into 2 stacked PRs:
  - PR 1: Worker scaffold + config + deps + GET endpoints (~300 lines)
  - PR 2: POST/PATCH/DELETE + event publishing + 360° profile (~300 lines)

**Recommendation**: Start with Option A (single PR) and let the tasks phase make the call based on actual line estimates.

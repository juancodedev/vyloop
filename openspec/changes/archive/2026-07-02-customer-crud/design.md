# Design: Customer CRUD

## Technical Approach

Hono router in `workers/customer/` handling 5 endpoints — upsert (PUT), list (GET /), 360° profile (GET /:id), partial update (PATCH), and soft delete (DELETE). DB queries via Drizzle ORM through `@vyloop/db`. Events published to `DOMAIN_EVENTS_QUEUE` via `@vyloop/event-bus` after schema validation. Gateway injects auth headers from JWT claims; worker strips incoming headers to prevent spoofing and reads them for RLS scoping.

## Architecture Decisions

| Decision | Option | Chosen | Rationale |
|----------|--------|--------|-----------|
| DB driver | `postgres.js` vs `@neondatabase/serverless` | `@neondatabase/serverless` | HTTP-based driver avoids connection limits on Workers edge. Supports `serverless().connect()` pattern. Migration: swap import + drizzle init call in `packages/db/src/index.ts` |
| Upsert verb | POST vs PUT | PUT | Idempotent — same `business_id` + `phone` always lands in same row. PUT body contains full customer data (idempotency key is the resource descriptor, not partial data) |
| Auth header injection | IP-restricted vs header-forward | Header-forward | Workers are only reachable via gateway service binding (no public URL). Gateway strips incoming headers, injects from JWT. Worker rejects requests missing all 3 headers |
| Event publish timing | Pre-commit vs post-DB | Post-DB (best-effort) | Queue retry (5 attempts) handles publish failure. No transactional outbox for PMV. Event is only published on initial registration (not repeat upsert) |
| Worker framework | Bare fetch vs Hono | Hono | Existing gateway pattern — Hono with typed Bindings, middleware, JSON helpers. Consistent DX |

## Data Flow

```
┌──────────┐     ┌──────────┐     ┌────────────────┐     ┌──────────┐
│  Client  │────▶│  Gateway │────▶│ Customer       │────▶│   DB     │
│(Web/PWA) │     │          │     │ Worker (Hono)  │     │(Neon/RLS)│
└──────────┘     │ - Auth   │     │                │     └──────────┘
                 │ - Strip  │     │ - Strip        │
                 │   X-*    │     │   X-* (defense)│
                 │ - Inject │     │ - Upsert/List  │     ┌──────────┐
                 │   from   │     │   /Profile/    │────▶│  Queue   │
                 │   JWT    │     │   Patch/Delete │     │(DOMAIN_  │
                 └──────────┘     │ - Validate     │     │ EVENTS)  │
                                  │   schema       │     └──────────┘
                                  │ - Publish      │
                                  │   event        │
                                  └────────────────┘
```

### Upsert flow (first-time)

1. Client `PUT /v1/customers` with `{full_name, phone, email, birth_date}`
2. Gateway strips `X-User-Id`, `X-Business-Id`, `X-User-Role` from incoming request
3. Gateway validates JWT, injects decoded claims as `X-User-Id`, `X-Business-Id`, `X-User-Role`
4. Gateway forwards to `customer` service binding
5. Customer worker strips `X-*` headers (defense-in-depth), reads `X-Business-Id` for RLS
6. Worker queries DB: `SELECT ... FROM customers WHERE business_id = ? AND phone = ?`
7. **Not found** → insert row with generated `global_id` (UUID), publish `CustomerRegistered` event
8. **Found** → update row, skip event

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `workers/customer/src/index.ts` | Rewrite | Hono app with 5 CRUD routes + event publishing |
| `workers/customer/src/index.test.ts` | Rewrite | Vitest: unit + integration for all endpoints |
| `workers/customer/src/routes.ts` | Create | Route handler functions (upsert, list, get, patch, delete) |
| `workers/customer/src/helpers.ts` | Create | Auth header extraction, RLS helpers, event creation |
| `workers/customer/wrangler.jsonc` | Modify | Add DB, DOMAIN_EVENTS_QUEUE, SCHEMA_REGISTRY bindings |
| `workers/customer/package.json` | Modify | Add `hono`, `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry` |
| `apps/gateway/src/router.ts` | Modify | Add auth header injection middleware before dispatch |
| `apps/gateway/src/middleware/auth-inject.ts` | Create | Injects X-User-Id, X-Business-Id, X-User-Role from `c.get('jwt')` |
| `packages/db/src/index.ts` | Modify | Migrate from `postgres.js` to `@neondatabase/serverless` |
| `packages/db/package.json` | Modify | Replace `postgres` with `@neondatabase/serverless` |
| `packages/event-bus/src/index.ts` | Minor | Export `CUSTOMER_REGISTERED` event type constant |
| `packages/schema-registry/src/index.ts` | Minor | Export `customerRegisteredSchema` + registration script |
| `apps/customer-web/src/app/page.tsx` | Create | Landing page (QR placeholder + start button) |
| `apps/customer-web/src/app/register/page.tsx` | Create | Registration form page |
| `apps/customer-web/src/app/confirm/page.tsx` | Create | Confirmation screen |

## Interfaces / Contracts

### Auth Headers

| Header | Source | Used By |
|--------|--------|---------|
| `X-User-Id` | JWT `sub` | Worker for audit/logging |
| `X-Business-Id` | JWT `business_id` | Worker for RLS filter |
| `X-User-Role` | JWT `role` | Worker for authorization |

### CustomerRegistered Event (payload)

```typescript
interface CustomerRegisteredEvent {
  customer_id: string;  // UUID
  full_name: string;    // minLength 1
  business_id: string;  // UUID
}
```

### API Shapes

```
PUT /v1/customers
Body: { full_name: string, phone: string, email?: string, birth_date?: string }
→ 200: { id, global_id, full_name, phone, ... }
→ 201: { id, global_id, ... }  (first-time, includes event_published: true)

GET /v1/customers?page=1&limit=20&q=ali
→ 200: { data: Customer[], total: number, page: number, limit: number }

GET /v1/customers/:id
→ 200: { ...Customer, customer_events: Event[], consents: Consent[] }

PATCH /v1/customers/:id
Body: { email?: string, full_name?: string, ... }
→ 200: { ...Customer }

DELETE /v1/customers/:id
→ 204: No Content
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Auth header extraction, RLS helpers, event creation | Pure functions, no mocks needed |
| Unit | DB driver migration (createDb) | Connection test with Neon URL |
| Integration | CRUD endpoints (upsert, list, get, patch, delete) | Miniflare test environment with mock D1/Neon via `@neondatabase/serverless` mock |
| Integration | Event publish on first registration only | Spy on Queue binding in miniflare |
| Integration | Schema validation before publish | Mock schema registry KV, assert validate() called |
| E2E | Gateway → Worker flow | Full request through gateway with JWT + service binding |

### Key edge cases

- **Spoofed headers**: Worker strips and rejects requests with pre-set `X-*` headers
- **Cross-business isolation**: RLS + `business_id` filter at query level (defense-in-depth)
- **Soft-delete GET returns 404**: Query explicitly filters `deleted_at IS NULL` for `GET /:id`
- **Empty search**: `?q=` returns first page of all customers (no filter)
- **Partial update**: `PATCH` only sets provided fields (Drizzle `set` with spread)

## Migration / Rollout

**DB driver change (`postgres.js` → `@neondatabase/serverless`)**:

1. Update `packages/db/package.json` — replace `postgres` with `@neondatabase/serverless`
2. Update `packages/db/src/index.ts` — use `neon()` http driver + `drizzle()` with ws/ws transport
3. Update consumers (if any) — currently only `@vyloop/customer` will consume `@vyloop/db`
4. No schema changes needed — Drizzle ORM layer abstracts the driver

**Deployment order**:

1. `packages/db` — migrate driver (non-breaking, Drizzle API unchanged)
2. `packages/event-bus` + `packages/schema-registry` — add event type/schema
3. `apps/gateway` — add header injection middleware (no customer worker yet, traffic unaffected)
4. `workers/customer` — deploy new CRUD worker
5. `apps/customer-web` — deploy registration PWA

## Open Questions

- [ ] Database connection string for `@neondatabase/serverless` — pooled or direct? Pooled recommended for Workers edge.
- [ ] Rate limit configuration for customer endpoints — separate from gateway defaults?
- [ ] Should `PATCH /v1/customers/:id` accept `business_id` in body? (Spec says no — field ignored or rejected?)

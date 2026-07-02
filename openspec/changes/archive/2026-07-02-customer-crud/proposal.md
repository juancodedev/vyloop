# Proposal: Customer CRUD (Fase 2A)

## Intent

Implement the Customer Domain — CRUD API, 360° profile, event-driven registration, and PWA registration form. This is the first domain after infrastructure (Fase 1) — unblocks all downstream features (growth, analytics, automation).

## Scope

### In Scope

- **Customer Worker**: Full CRUD (`POST/GET/PATCH/DELETE /v1/customers`, `GET /v1/customers/{id}` with 360° profile including `customer_events`)
- **CustomerRegistered event**: Published to `DOMAIN_EVENTS_QUEUE` on registration
- **Auth propagation**: Gateway injects `X-User-Id`, `X-Business-Id`, `X-User-Role` from JWT into forwarded requests
- **PWA registration flow**: `customer-web` app — QR scan landing → registration form → confirmation screen
- **Schema + DB**: Drizzle queries via `@vyloop/db` (RLS via `business_id`), `global_id` generated at registration
- **Schema registry**: CustomerRegistered event schema registered & validated

### Out of Scope

- Growth domain (points, tiers, wallet) — Fase 2B
- Dashboard customer views — separate change
- QR generation itself (just landing structure — QR integration deferred/external)
- Bulk import/export
- Customer segmentation (AND/OR filtering)

## Capabilities

### New Capabilities

- `customer-crud`: Customer worker API endpoints — CRUD, 360° profile, event publishing
- `customer-web`: PWA registration page — QR scan → form → confirmation

### Modified Capabilities

- `api-gateway`: Inject auth headers (`X-User-Id`, `X-Business-Id`, `X-User-Role`) before forwarding to workers
- `event-bus`: Register `CustomerRegistered` event type
- `schema-registry`: Add `CustomerRegistered` event schema

## Approach

**Direct CRUD in Customer Worker** (Approach 1 from exploration):
- Hono router in `workers/customer/` with Drizzle ORM via `@vyloop/db`
- Worker validates schemas via `@vyloop/schema-registry` before publishing
- Worker publishes to Queue via `@vyloop/event-bus` producer
- Gateway injects trust headers from JWT claims before forwarding
- `customer-web` PWA gets a registration page + form component

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `workers/customer/src/index.ts` | Rewrite | Placeholder → CRUD + event publishing |
| `workers/customer/wrangler.jsonc` | Modified | Add DB, Queue, KV bindings |
| `workers/customer/package.json` | Modified | Add `hono`, `@vyloop/db`, `@vyloop/event-bus`, `@vyloop/schema-registry` |
| `workers/customer/src/index.test.ts` | Rewrite | Full coverage: CRUD, events, 360° |
| `apps/gateway/src/index.ts` | Modified | Inject auth headers into forwarded requests |
| `apps/customer-web/` | New | PWA registration form |
| `packages/schema-registry/` | Modified | Add CustomerRegistered schema |
| `packages/event-bus/` | Minor | Register event type constant |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| **Event ordering**: DB insert + Queue publish not atomic → orphan customer if publish fails | Low | Queue retry (5 attempts) + idempotent consumers. No transactional outbox for PMV |
| **DB in Workers**: `@neondatabase/serverless` edge driver with connection pooling | Medium | Use pooled connection string; test under load |
| **Auth trust model**: Workers trust gateway-injected headers — no JWT re-validation | Low | Workers have no public URL; only reachable via gateway service binding |

## Rollback Plan

1. Gateway: revert to previous version (removes header injection) — no-downtime deploy
2. Customer Worker: deploy previous placeholder version
3. Customer-web: revert to empty scaffold
4. CustomerRegistered event: downstream consumers not yet built (no dependent rollback needed)

## Dependencies

- None — all infra is ready from Fase 1 (DB schema, gateway routing, event bus, schema registry)

## Success Criteria

- [ ] `POST /v1/customers` creates row + publishes CustomerRegistered event to Queue
- [ ] `GET /v1/customers/{id}` returns 360° profile with customer + events (RLS-scoped)
- [ ] PWA registration form accepts valid data and calls POST endpoint
- [ ] Gateway injects all 3 auth headers; worker rejects requests missing them
- [ ] All CRUD operations respect business_id isolation (RLS)

## Resolved Questions

| Question | Decision |
|----------|----------|
| Customer deletion | Soft delete (`deleted_at` field, hidden from list, data preserved) |
| Customer search | Pagination + `?q=` search by name/email/phone |
| CustomerRegistered payload | Minimal: `customer_id` + `full_name` + `business_id` |
| DB driver | `@neondatabase/serverless` — migrate from `postgres.js` |

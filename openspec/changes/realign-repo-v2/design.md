# Design: Realign monorepo to v2.0 specs + Fase 1 implementation

## Technical Approach

Three chained PRs on `feature/realign-fase1`:

- **PR 1** — Pure structural: `git mv` moves, config updates, stub creation, doc merge, dead code removal. Zero behavioral change.
- **PR 2** — Data layer: Full Drizzle schema for all 7 domains, RLS policies, indexes, Schema Registry in KV with initial event types.
- **PR 3** — Services: IAM (OIDC+JWT), Gateway (routing+auth+rate limiting), Queues, Event Ingestor, TestEvent e2e.

## Architecture Decisions

### PR 1 — Structure

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| Move strategy | `git mv` | Copy-delete | Preserves file history; all current Workers are stubs (~10 lines each) so conflict risk is minimal |
| Package renames | Update `name` in `package.json` only | Path-based resolution | pnpm resolves by path, not name; `tsconfig.json` aliases are the only consumer-impacted surface |
| `packages/types/` | Keep as `@vyloop/types` | Merge into `schema-registry` | 6 packages import it; extraction would touch every package with zero spec benefit |
| `services/*` workspace glob | Keep it (for `services/ai/`) | Remove it | Single glob covers the new FastAPI service; removing it adds config churn without value |
| Root package name | Keep `vyloop` | Rename to `vyloop-core` | `name` is npm metadata only — no import surface. Change adds noise to PR 1 diff |

### PR 2 — Data Layer

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| ORM | Drizzle (existing) | Prisma, Kysely | Already set up in `packages/database/` with postgres-js driver and drizzle-kit config |
| Migration dir | `packages/db/drizzle/` (exists) | Separate dir | Single source of truth; `drizzle.config.ts` already points `./drizzle` |
| RLS strategy | `app.current_business_id` via `set_config` | Supabase RLS, per-tenant schema | Matches 09-Database-Design.md; Gateway sets session var before Worker queries |
| Schema Registry storage | Workers KV | D1, PostgreSQL | KV matches 05-System-Design: key-value schema lookups are faster than querying D1. KV is the right fit for low-write, read-heavy schema validation |
| Event schema format | JSON Schema | Zod schemas, Protobuf | Language-agnostic; can be validated by any runtime (Python AI service, Node Workers) |

### PR 3 — Services

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| Event bus | Cloudflare Queues | Kafka, D1-based queue | Per 07-Architecture.md PMV phase; Kafka deferred to enterprise. Queues give at-least-once + DLQ natively |
| Auth model | OAuth 2.0 + OIDC | API key only, session-based | Matches 08-API-Design.md spec; scoped JWT enables granular permissions across domains |
| Rate limiting store | Workers KV + in-memory counter | D1, external Redis | KV cached at edge — fast reads, no network hop. Acceptable for PMV; migrate to D1-backed if precision needed |
| Middleware pattern | Hono middleware chain | Decorator pattern, custom router | Already in use (`services/api-gateway/src/index.ts` uses `app.get()` pattern). Chain: auth → X-Business-ID → rate limit → route |

## Data Flow

```
PR 2 (Data Layer):
  drizzle-kit generate → packages/db/drizzle/{migration}.sql
  drizzle-kit migrate  → Neon PostgreSQL (15 tables + RLS + indexes)
  wrangler kv:key put  → Schema Registry (KV) — event type schemas

PR 3 (Event Flow):
  Client → POST /v1/events/purchase
    ↓
  Event Ingestor (apps/gateway/)
    → Schema Registry (KV) — validate payload shape
    → 400 SCHEMA_INVALID if fails
    ↓
  Cloudflare Queues — at-least-once delivery
    ↓
  Worker consumer (e.g., workers/growth/)
    → start db session: SET LOCAL app.current_business_id = '...'
    → process event, write to PostgreSQL
    → ack event
```

## File Changes

### PR 1 — Structure (~400 lines)

| Action | Path | Detail |
|--------|------|--------|
| `git mv` | `services/api-gateway/` → `apps/gateway/` | Rename pkg `@vyloop/api-gateway` → `@vyloop/gateway`, wrangler name `api-gateway` → `gateway` |
| `git mv` | `services/identity/` → `workers/identity/` | Keep pkg name `@vyloop/identity` |
| `git mv` | `services/customer/` → `workers/customer/` | Same pattern |
| `git mv` | `services/growth/` → `workers/growth/` | Same pattern |
| `git mv` | `packages/schemas/` → `packages/schema-registry/` | Rename pkg `@vyloop/schemas` → `@vyloop/schema-registry` |
| `git mv` | `packages/database/` → `packages/db/` | Rename pkg `@vyloop/database` → `@vyloop/db`, update `drizzle.config.ts` path? no — it's relative |
| Delete | `packages/utils/` | `git rm -r packages/utils/`, remove from `tsconfig.json` paths |
| Create | `workers/communication/` | Stub: `package.json`, `wrangler.jsonc`, `src/index.ts` (return `{service,status}`) |
| Create | `workers/automation/` | Same stub pattern |
| Create | `workers/analytics/` | Same stub pattern |
| Create | `workers/compliance/` | Same stub pattern |
| Create | `apps/customer-web/` | Next.js PWA stub: `package.json`, `next.config.js`, `app/page.tsx` |
| Create | `services/ai/` | FastAPI stub: `pyproject.toml`, `main.py`, `requirements.txt` |
| Modify | `pnpm-workspace.yaml` | Add `workers/*`, `services/*` stays for `ai/` |
| Modify | `tsconfig.json` | Remove `@vyloop/utils`, rename `@vyloop/schemas` → `@vyloop/schema-registry`, `@vyloop/database` → `@vyloop/db` |
| Modify | Root `package.json` | None (keeping name `vyloop`) |
| Merge+Delete | `vyloop-files/` → `docs/` | Move all 12 files into `docs/` subdir, then `rm -rf vyloop-files/` |

### PR 2 — Data Layer (~500 lines)

| Action | Path | Detail |
|--------|------|--------|
| Modify | `packages/db/src/schema.ts` | Full Drizzle schema: all 15 tables from 09-Database-Design.md in Drizzle ORM syntax (`pgTable`, `uuid`, `text`, `jsonb`, `numeric`, `timestamptz`, FKs) |
| Create | `packages/db/src/rls.ts` | RLS policy definitions: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `CREATE POLICY tenant_isolation USING (business_id = current_setting('app.current_business_id')::UUID)` |
| Create | `packages/db/src/indexes.ts` | All 6 critical indexes: `idx_customers_phone`, `idx_customers_last_visit`, `idx_points_balance`, `idx_customers_metadata` (GIN), `idx_customer_events_customer`, `idx_customer_events_type` |
| Create | `packages/db/migrate.ts` | Script that runs migrations then applies RLS (since RLS are raw SQL, not Drizzle-managed) |
| Generate | `packages/db/drizzle/*.sql` | `drizzle-kit generate` output — migration SQL |
| Create | `packages/schema-registry/src/schemas/` | JSON Schema files per event type: `purchase_completed.json`, `customer_registered.json`, `points_assigned.json`, `test_event.json` |
| Modify | `packages/schema-registry/src/index.ts` | KV bindings + validation logic: `get(key)`, `validate(eventType, payload)` |
| Shell | (KV setup) | `wrangler kv:namespace create schema-registry`, seed initial schemas via `wrangler kv:key put` |

### PR 3 — Services (~600 lines)

| Action | Path | Detail |
|--------|------|--------|
| Modify | `apps/gateway/src/index.ts` | Full Gateway: Hono app with route table (`/v1/identity/*` → workers/identity, `/v1/customers/*` → workers/customer, etc.), auth middleware, X-Business-ID middleware, rate limit middleware, error format middleware |
| Create | `apps/gateway/src/middleware/auth.ts` | JWT validation via `jose` library: verify signature, extract `sub`, `business_id`, `role`, `scopes` |
| Create | `apps/gateway/src/middleware/business-id.ts` | Compare `X-Business-ID` header against JWT `business_id` claim → 403 `AUTH_BUSINESS_MISMATCH` |
| Create | `apps/gateway/src/middleware/rate-limit.ts` | Per-`business_id` counter via KV, exponential backoff, 429 + `Retry-After` |
| Create | `apps/gateway/src/router.ts` | Domain route map: prefix → Worker URL binding. Uses `SERVICE_BINDING_MAP` env var |
| Modify | `apps/gateway/wrangler.jsonc` | Add KV binding for rate-limiter, add service bindings for all domain Workers |
| Create | `workers/identity/src/auth.ts` | OAuth 2.0 + OIDC token endpoint: `POST /v1/auth/token` — validate credentials, issue JWT with scopes via `jose`, support refresh tokens |
| Create | `workers/identity/src/api-keys.ts` | API key generation, hashing, scope validation. Keys stored in PostgreSQL, hashed with SHA-256 |
| Modify | `workers/identity/src/index.ts` | Hono app with `/v1/auth/*`, `/v1/me`, DB queries for users/tenants |
| Create | `apps/gateway/src/ingestor.ts` | Event Ingestor: `POST /v1/events/{type}` — validate via Schema Registry, envelope with header, publish to Queues |
| Create | `workers/identity/src/event-handler.ts` | TestEvent consumer: subscribe to `test` queue, log + ack. E2E validation |
| Create | `packages/event-bus/src/index.ts` | Shared event bus library: `publish(queue, event)` and `consume(queue, handler)` helpers |
| Modify | Root `wrangler.jsonc` or per-package | Queue bindings: `test-events` and `domain-events` queues, DLQ config |

## Testing Strategy

| PR | Layer | What | Approach |
|----|-------|------|----------|
| 1 | Build | `pnpm install`, `pnpm -r typecheck` pass | CI assertion; local `pnpm install` generates lockfile |
| 1 | Unit | New stub Workers return expected placeholder | Vitest: `expect(response.status).toBe(200)` |
| 2 | Unit | Drizzle schema matches DDL from 09-Database-Design | Snapshot `drizzle-kit generate` output against expected SQL |
| 2 | Integration | RLS isolation | Two session test: set `app.current_business_id` to A, insert row A, set to B, verify B cannot see row A |
| 2 | Unit | Schema validation | Test valid + invalid payloads against each JSON Schema |
| 3 | Unit | JWT token lifecycle | `jose` sign → verify → decode → compare claims |
| 3 | Unit | Rate limit middleware | Mock KV counter, assert 429 after N requests |
| 3 | Integration | TestEvent e2e | POST to ingestor → validate → publish to Queues → consume and assert ack |
| 3 | Unit | X-Business-ID mismatch | Send mismatched header, assert 403 with `AUTH_BUSINESS_MISMATCH` |

## Migration / Rollout

- PR 1: Single commit. Verify `pnpm install && pnpm -r typecheck` green. `git revert <sha>` if broken.
- PR 2: Migration is additive (no destructive changes). Rollback: `pnpm db:migrate:down <version>`.
- PR 3: New services deployed alongside existing stubs. No traffic routed until Gateway is live. Rollback: revert commit, remove queue bindings.

## Open Questions

- [ ] Confirm KV namespace names: `schema-registry` and `rate-limiter`. Do we need separate KV namespaces or can they share?
- [ ] Queue naming convention: `vyloop-events-{domain}` or single `vyloop-events` with consumer filters?
- [ ] For `apps/customer-web/` stubs: does the project have a Next.js template to copy, or scaffold from scratch?
- [ ] Rate limit tiers: what are the per-plan limits (free/pro/business)? Spec says "per business_id per endpoint" but no values defined.

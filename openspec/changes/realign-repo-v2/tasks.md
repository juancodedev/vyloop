# Tasks: Realign monorepo to v2.0 specs + Fase 1

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1500+ |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Structure (~400) → PR 2: Data Layer (~500) → PR 3: Services (~600) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Structural alignment + stubs | PR 1 → `feature/realign-fase1` | `git mv`, config, dead code removal, stubs. Zero behavioral change |
| 2 | Data layer + Schema Registry | PR 2 → PR 1 branch | Drizzle schema, RLS, indexes, KV schema registry. Depends on `packages/schema-registry/` and `packages/db/` from PR 1 |
| 3 | Services + Auth + Events | PR 3 → PR 2 branch | IAM, Gateway middleware, Queues, Event Ingestor, e2e. Depends on data layer (PR 2) and runtime paths (PR 1) |

## Phase 1: Structure & Repo Config (PR 1)

- [x] 1.1 `git mv services/api-gateway/` → `apps/gateway/`, rename pkg `@vyloop/gateway`, update wrangler name
- [x] 1.2 `git mv services/{identity,customer,growth}/` → `workers/{identity,customer,growth}/`
- [x] 1.3 `git mv packages/schemas/` → `packages/schema-registry/`, rename pkg `@vyloop/schema-registry`
- [x] 1.4 `git mv packages/database/` → `packages/db/`, rename pkg `@vyloop/db`
- [x] 1.5 `git rm -rf packages/utils/` (dead code), remove from `tsconfig.json` paths
- [x] 1.6 Create stubs: `workers/{communication,automation,analytics,compliance}/` — `package.json`, `wrangler.jsonc`, `src/index.ts`
- [x] 1.7 Create `apps/customer-web/` stub (Next.js PWA: `package.json`, `next.config.js`, `app/page.tsx`)
- [x] 1.8 Create `services/ai/` stub (FastAPI Python: `pyproject.toml`, `main.py`, `requirements.txt`)
- [x] 1.9 Update `pnpm-workspace.yaml` — add `workers/*` glob
- [x] 1.10 Update `tsconfig.json` — remove `@vyloop/utils`, rename `@vyloop/schemas` → `@vyloop/schema-registry`, `@vyloop/database` → `@vyloop/db`
- [x] 1.11 Merge `vyloop-files/` content into `docs/`, then `rm -rf vyloop-files/`
- [x] 1.12 Verify: `pnpm install && pnpm -r typecheck` passes clean

## Phase 2: Data Layer & Schema Registry (PR 2)

- [ ] 2.1 Write full Drizzle schema in `packages/db/src/schema.ts` — all 15 tables (tenants, branches, users, customers, customer_events, consents, loyalty_programs, membership_tiers, points_transactions, cross_loyalty_alliances, referrals, workflows, workflow_executions, churn_predictions, localization_configs)
- [ ] 2.2 Create `packages/db/src/rls.ts` — RLS policies per `business_id` table using `app.current_business_id`
- [ ] 2.3 Create `packages/db/src/indexes.ts` — critical indexes (phone, last_visit, points_balance, JSONB GIN, event lookups)
- [ ] 2.4 Create `packages/db/migrate.ts` — migration + RLS application script
- [ ] 2.5 Run `drizzle-kit generate` → commit `packages/db/drizzle/*.sql`
- [ ] 2.6 Create JSON Schema files in `packages/schema-registry/src/schemas/` — `purchase_completed.json`, `customer_registered.json`, `points_assigned.json`, `test_event.json`
- [ ] 2.7 Implement Schema Registry CRUD in `packages/schema-registry/src/index.ts` — KV get/set + `validate(eventType, payload)` with AJV
- [ ] 2.8 Shell: `wrangler kv:namespace create schema-registry`, seed initial schemas
- [ ] 2.9 Write tests: schema snapshot, RLS isolation (two-session), JSON Schema validation (valid + invalid payloads)

## Phase 3: Services, Auth & Event Bus (PR 3)

- [ ] 3.1 Implement `workers/identity/src/auth.ts` — OIDC token endpoint, JWT issuance/validation with scopes via `jose`
- [ ] 3.2 Implement `workers/identity/src/api-keys.ts` — key generation, SHA-256 hashing, scope validation against PostgreSQL
- [ ] 3.3 Wire `workers/identity/src/index.ts` — Hono app with `/v1/auth/*`, `/v1/me`, tenant queries
- [ ] 3.4 Create `apps/gateway/src/middleware/auth.ts` — JWT validation middleware
- [ ] 3.5 Create `apps/gateway/src/middleware/business-id.ts` — X-Business-ID vs JWT claim mismatch → 403
- [ ] 3.6 Create `apps/gateway/src/middleware/rate-limit.ts` — per-business KV counter, 429 + Retry-After
- [ ] 3.7 Create `apps/gateway/src/router.ts` — domain prefix → Worker service binding map
- [ ] 3.8 Wire `apps/gateway/src/index.ts` — Hono app with full middleware chain + routing
- [ ] 3.9 Update `apps/gateway/wrangler.jsonc` — KV binding for rate-limiter, service bindings for domain Workers
- [ ] 3.10 Create `packages/event-bus/src/index.ts` — `publish(queue, event)` and `consume(queue, handler)` helpers
- [ ] 3.11 Configure Queues + DLQ in root/per-package `wrangler.jsonc`
- [ ] 3.12 Implement Event Ingestor `apps/gateway/src/ingestor.ts` — `POST /v1/events/{type}`, schema validation, envelope, queue publish
- [ ] 3.13 Create `workers/identity/src/event-handler.ts` — TestEvent consumer (log + ack)
- [ ] 3.14 Write tests: JWT lifecycle, rate limit (429 after N), X-Business-ID mismatch (403), TestEvent e2e (POST → validate → queue → consume → assert)

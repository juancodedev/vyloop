# Proposal: Realign monorepo structure to v2.0 specs + Fase 1 implementation

## Intent

The current repo layout (from init-repository scaffold) doesn't match the mandatory v2.0 spec, and Fase 1 backlog items can't ship without the correct structure and infra. This change aligns the monorepo to the canonical spec and implements the foundational Fase 1 stack.

## Scope

### In Scope

**Part A — Structural Alignment (moves + stubs + config):**
- `services/api-gateway/` → `apps/gateway/` (git mv, rename pkg to `@vyloop/gateway`)
- `services/{identity,customer,growth}/` → `workers/{identity,customer,growth}/` (git mv)
- `packages/schemas/` → `packages/schema-registry/` (git mv, rename pkg)
- `packages/database/` → `packages/db/` (git mv, rename pkg)
- Remove `packages/utils/` (dead, zero imports)
- Create 4 Worker stubs: `workers/{communication,automation,analytics,compliance}/`
- Create `apps/customer-web/` (Next.js PWA stub), `services/ai/` (FastAPI stub)
- Update `pnpm-workspace.yaml` (add `workers/*`), `tsconfig.json` (fix aliases), root `package.json`
- Merge `vyloop-files/` into `docs/`, then remove `vyloop-files/`
- Keep `tooling/`, `packages/types/`, `packages/config/`

**Part B — Fase 1 Backlog Implementation:**
1. Full PostgreSQL schema (all 7 domains) with Drizzle migrations
2. Row-Level Security (RLS) on every `business_id` table
3. Schema Registry in Workers KV with initial event schemas
4. IAM multi-tenant (OIDC, JWT with scopes, X-Business-ID validation)
5. API Gateway domain routing + rate limiting
6. Cloudflare Queues as event bus
7. Event Ingestor with schema validation
8. End-to-end `TestEvent` flow (publish + consume)

### Out of Scope
- Fase 2+ items (customer CRUD, points engine, dashboards, integrations)
- New business logic beyond the Fase 1 foundation

## Capabilities

### New Capabilities
- `multi-tenant-iam`: OIDC auth, JWT with scopes, tenant login, X-Business-ID enforcement
- `api-gateway`: Domain routing, rate limiting, auth middleware on Cloudflare Workers + Hono
- `event-bus`: Cloudflare Queues abstraction, producer/consumer patterns, retry
- `schema-registry`: Event schema definitions in Workers KV, validation API
- `event-ingestor`: HTTP endpoint for event submission, pre-bus validation
- `database`: Full PostgreSQL schema with migrations, RLS policies, Drizzle ORM

### Modified Capabilities
None — `openspec/specs/` is empty (init-repository was scaffold, not specs).

## Approach

Two-phase delivery within one SDD change, shipped as 3 chained PRs:

1. **PR 1 — Structure** (~400 lines): All moves/renames via `git mv`, config updates, stub creation, doc merge. No behavioral change.
2. **PR 2 — Data Layer** (~500 lines): PostgreSQL schema with Drizzle migrations for all domains, RLS policies, Schema Registry in KV with initial event types.
3. **PR 3 — Services** (~600 lines): IAM (OIDC + JWT), Gateway (routing, rate limiting, X-Business-ID), Queues event bus, Event Ingestor, TestEvent e2e.

Each PR targets the previous in a feature branch chain. PR #1 → `feature/realign-fase1`, PR #2 targets #1, PR #3 targets #2.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `services/*` (4 dirs) | Moved | 3 → `workers/`, 1 → `apps/gateway/` |
| `packages/schemas/` | Renamed → `packages/schema-registry/` | + pkg rename |
| `packages/database/` | Renamed → `packages/db/` | + pkg rename |
| `packages/utils/` | Removed | Dead code |
| `workers/{communication,automation,analytics,compliance}/` | New | Worker stubs x4 |
| `apps/customer-web/` | New | Next.js PWA stub |
| `services/ai/` | New | FastAPI Python stub |
| `pnpm-workspace.yaml` | Modified | Add `workers/*` |
| `tsconfig.json` | Modified | Fix path aliases |
| `vyloop-files/` | Removed | Content merged into `docs/` |
| `workers/identity/customer/growth/` | Modified | Fase 1 logic + IAM |
| `apps/gateway/` | Modified | Routing, rate limiting, auth |
| `.github/workflows/ci.yml` | Modified | Update workspace patterns |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Git history loss on moves | Low | `git mv` preserves history; verify with `git log --follow` |
| pnpm-lock.yaml churn | Med | Generate lockfile as part of PR 1; expect large diff |
| Branch conflicts with existing PRs | Med | Merge or close PR 3 from init-repository before starting |
| Worker name mismatch in wrangler.jsonc | Low | `wrangler.jsonc` name field must match new path; verified in each move |
| Docs merge omits content | Low | Audit `vyloop-files/` against `docs/` before removal |

## Rollback Plan

PR 1: `git revert <commit>` of the structurral commit. PR 2/3: `git revert` the commit, then run `pnpm db:migrate:down` to roll back the last migration. If schema change is irreversible (destructive migration), restore from Neon backup.

## Dependencies

- Cloudflare account (Workers, Queues, KV namespaces created during implementation)
- Neon/PostgreSQL 16 accessible from `DATABASE_URL`
- Node 20, pnpm 9

## Success Criteria

- [ ] `pnpm install` clean after all moves and renames
- [ ] `tsconfig.json` aliases resolve for all new paths
- [ ] `pnpm -r typecheck` passes
- [ ] Drizzle migrations generate and apply all domain tables
- [ ] RLS policies active on all `business_id` tables
- [ ] Schema Registry returns validation for a known event schema
- [ ] JWT with scopes issued and validated by Gateway
- [ ] Event published to Queues, consumed by a Worker, and asserted

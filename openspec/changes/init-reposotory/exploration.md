# Exploration: Initial Project Scaffolding — "init reposotory"

## Executive Summary

Vyloop needs a monorepo scaffold from zero code. The project has 11 architecture/PRD documents but no package manager, no TypeScript config, no CI, and no test runner. The recommended approach is **pnpm workspaces** as the monorepo base (lightweight, fast, Cloudflare-native), with a directory structure that separates `apps/` (Next.js dashboard), `services/` (7 bounded contexts as Workers), `packages/` (shared types, schemas, utilities), and `docker/` (PostgreSQL + ClickHouse for local dev). The first scaffold commit should initialize the workspace, tooling configs (TypeScript, ESLint, Prettier, Vitest), the API Gateway Worker (Hono with health endpoint), a bare Next.js app, Docker Compose, and minimal CI. Full seven contexts, ORM setup, event bus, and testing infrastructure should be deferred to subsequent changes.

## Recommended Stack

| Tool | Version | Rationale |
|------|---------|-----------|
| **pnpm** | 9.x | Workspace protocol (`workspace:*`) is standard for CF Workers monorepos. Fast, disk-efficient. |
| **Node.js** | 20 LTS (or 22) | Required by both Next.js and CF Workers. Use `.nvmrc` + `engines` in package.json. |
| **TypeScript** | 5.6+ | Strict mode. Shared base config in `tooling/typescript/`. |
| **ESLint** | 9.x (flat config) | `eslint.config.ts` — modern, composable. Per-package configs extend the root. |
| **Prettier** | 3.x | Shareable config in `tooling/prettier/`. |
| **Vitest** | 2.x | Workspace-native (`vitest.workspace.ts`). Per-package config, not the reverse. |
| **Playwright** | Latest | **Defer** until first UI pages exist. |
| **Hono** | 4.x | CF Workers-native routing for the API Gateway. |
| **Next.js** | 14 (App Router) | React 18+, App Router for the dashboard. |
| **Drizzle ORM** | 0.35+ | **Scaffold package but defer migrations.** Type-safe, CF Workers-compatible. |
| **Zod** | 3.x | Schema validation for the Schema Registry. First shared package. |
| **wrangler** | 3.x | CF Workers CLI. Root config for shared defaults. |

## Directory Structure

```
vyloop/                              # Repo root (product brand name)
├── .github/
│   └── workflows/
│       └── ci.yml                   # Lint + typecheck + vitest on push/PR
├── .vscode/
│   └── settings.json                # Format on save, TS strict mode
├── apps/
│   └── dashboard/                   # Next.js App Router (admin UI)
│       ├── src/
│       │   └── app/
│       │       └── page.tsx         # Bare landing page
│       ├── next.config.ts
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── package.json
├── services/                        # Cloudflare Workers (bounded contexts)
│   ├── api-gateway/                 # Hono + Auth (SCAFFOLD NOW)
│   │   ├── src/
│   │   │   └── index.ts            # health endpoint + router
│   │   ├── wrangler.jsonc
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── package.json
│   ├── identity/                    # Identity & Access (scaffold dir — defer logic)
│   ├── customer/                    # Customer domain (scaffold dir — defer logic)
│   ├── growth/                      # Growth domain (scaffold dir only)
│   ├── communication/               # (defer entirely)
│   ├── automation/                  # (defer entirely)
│   ├── analytics/                   # (defer entirely)
│   └── compliance/                  # (defer entirely)
├── packages/                        # Shared libraries
│   ├── types/                       # Core domain types + entities
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── schemas/                     # Zod schemas + Schema Registry core
│   │   ├── src/
│   │   │   └── index.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── config/                      # Shared env config (scaffold dir — defer body)
│   ├── event-bus/                   # CF Queues abstraction (scaffold dir — defer)
│   ├── database/                    # Drizzle schema + migrations (scaffold dir — defer)
│   └── utils/                       # Shared utilities (scaffold dir — defer)
├── docker/
│   ├── docker-compose.yml           # PostgreSQL 16 + ClickHouse 24
│   ├── postgres/
│   │   └── init.sql                 # Enable RLS, create extensions
│   ├── clickhouse/
│   │   └── init.sql                 # Create analytics DB
│   └── .env.example                 # Local dev env vars
├── tooling/                         # Shared dev tooling (publishable configs)
│   ├── typescript/
│   │   └── tsconfig.base.json       # Strict base config
│   ├── eslint/
│   │   └── eslint.config.ts         # Flat config with plugins
│   ├── prettier/
│   │   └── prettier.config.ts       # Shareable config
│   └── vitest/
│       └── vitest.workspace.ts      # Workspace file referencing all packages
├── docs/
│   ├── prd/                         # Product docs (moved from atlas-docs/)
│   ├── architecture/                # Architecture docs
│   ├── operations/                  # Onboarding, runbooks
│   └── decisions/                   # ADRs (placeholder)
├── scripts/
│   ├── bootstrap.sh                 # pnpm install + docker compose up
│   └── dev.sh                       # Start all dev services
├── .nvmrc                           # Node version pinning
├── .env.example                     # Root env vars (shared)
├── .gitignore
├── .prettierrc                      # Points to tooling/prettier
├── package.json                     # pnpm workspace root
├── pnpm-lock.yaml
├── pnpm-workspace.yaml             # Packages: ['apps/*', 'services/*', 'packages/*', 'tooling/*']
├── tsconfig.json                    # Root extends tooling/tsconfig
└── README.md                        # Project overview + getting started
```

## Dev Environment

### Docker Compose (local dev)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vyloop_dev
      POSTGRES_USER: vyloop
      POSTGRES_PASSWORD: vyloop_dev
    ports:
      - "5432:5432"
    volumes:
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
      - pgdata:/var/lib/postgresql/data

  clickhouse:
    image: clickhouse/clickhouse-server:24-alpine
    ports:
      - "8123:8123"  # HTTP
      - "9000:9000"  # Native
    volumes:
      - ./clickhouse/init.sql:/docker-entrypoint-initdb.d/init.sql
      - chdata:/var/lib/clickhouse

  mailpit:
    image: axllent/mailpit
    ports:
      - "1025:1025"  # SMTP
      - "8025:8025"  # UI
```

### wrangler

- Root `wrangler.jsonc`: compatibility_date, compatibility_flags (nodejs_compat), name_prefix
- Per-service: specific bindings (Queues, D1/R2 references)
- `pnpm dev` uses `wrangler dev` for Workers + `next dev` for dashboard

### Local dev workflow

```bash
pnpm install
docker compose up -d          # Start Postgres + ClickHouse
pnpm dev                      # Starts all services concurrently
pnpm --filter api-gateway dev # Or dev a single service
pnpm typecheck                # All packages
pnpm lint                     # All packages
pnpm test                     # All packages (Vitest workspace)
```

## Phase Plan — What to Scaffold vs Defer

### Scaffold NOW (in this change)

| Item | Description |
|------|-------------|
| pnpm workspace | Root `package.json` + `pnpm-workspace.yaml` |
| TypeScript base config | `tooling/typescript/tsconfig.base.json` + root `tsconfig.json` |
| ESLint flat config | `tooling/eslint/eslint.config.ts` + per-package extends |
| Prettier config | `tooling/prettier/prettier.config.ts` + root `.prettierrc` |
| Vitest workspace | `tooling/vitest/vitest.workspace.ts` |
| `packages/types` | Minimal domain types (TenantId, UserId, CustomerId, Event types) |
| `services/api-gateway` | Hono Worker with `GET /health` and basic router scaffold |
| `apps/dashboard` | Next.js App Router with single landing page |
| Docker Compose | PostgreSQL 16 + ClickHouse 24 + Mailpit for local dev |
| DB init scripts | PostgreSQL: enable RLS, create extensions (uuid-ossp, pgcrypto) |
| `.env.example` | Template for local env vars |
| `.gitignore` | Standard Node + Workers + Next.js ignores |
| `.nvmrc` | Pin Node version |
| CI (GitHub Actions) | `ci.yml` — `pnpm install` → `pnpm lint` → `pnpm typecheck` → `pnpm test` |
| Move atlas-docs to docs/ | `docs/prd/`, `docs/architecture/`, `docs/operations/` |

### Defer to later changes

| Item | When |
|------|------|
| Full Identity Worker logic | Next change (Phase 1, Priority 1) |
| Event bus abstraction | Next change (Phase 1, Priority 2) |
| Database schema + Drizzle migrations | Next change (Phase 1, Priority 3) |
| Auth/OIDC middleware | Next change (Phase 1, Priority 4) |
| Other 6 bounded context Workers | Phases 1-2 |
| ClickHouse table creation | Phase 2 (Analytics) |
| Playwright E2E tests | When dashboard has pages |
| Turborepo | When build times are noticeable (>5 packages) |
| Storybook | When UI components exist |
| Terraform/Pulumi infra | When deploying to production |

## Risks

1. **Monorepo name mismatch**: The Developer Onboarding doc calls it `atlas-core`, the repo is `vyloop`, and the brand is Vyloop. **Recommendation**: Keep the repo as `vyloop`, use `@atlas-core` as the npm scope (e.g., `@atlas-core/identity`, `@atlas-core/types`). This respects the internal naming convention while keeping the repo identifiable externally.

2. **Backend stack conflict**: The System Design Document (05) specifies FastAPI/Python. The Architecture document (07) specifies Cloudflare Workers + Hono. These are incompatible — you cannot have both without completely different toolchains. **Recommendation**: Confirm with the team. The Architecture doc, PRD, API Design, Backlog, and Developer Onboarding all align with Workers/Hono. Treat the SDD as an earlier draft.

3. **ClickHouse resource requirements**: ClickHouse in Docker requires ~4GB+ RAM. For developers on low-resource machines, consider deferring ClickHouse or substituting with a PostgreSQL `analytics` schema for local dev.

4. **Multi-tenant overhead**: `tenant_id` in every query, RLS policies, and cross-tenant isolation logic add upfront complexity. The types package must enforce `tenant_id` from day one or risk a painful retrofit.

5. **Schema-first enforcement**: If "every contract must be documented in the Schema Registry" is a hard rule, then `packages/schemas` must have strong foundations from the first commit. Consider Zod + a registry pattern (map of event name → schema) with validation middleware.

6. **Monorepo monoculture risk**: All 7 bounded contexts in one repo is convenient but creates coupling risk (shared config changes break services). Mitigate with strict package boundaries and `"@atlas-core/*"` dependency rules in ESLint.

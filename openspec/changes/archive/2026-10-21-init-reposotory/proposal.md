# Proposal: Init Repository

> **Naming**: The project is **Vyloop**. All internal packages use the `@vyloop/` scope. The repository name is `vyloop`.

## Intent
Scaffold Vyloop from zero to a working monorepo with shared types, health API gateway, Next.js shell, local PostgreSQL dev environment, database migration tooling, and CI pipeline.

## Scope

**In** (14 items): pnpm workspace + TS base config | ESLint + Prettier tooling | `packages/types` (domain types) | `packages/schemas/config/utils` (stubs) | `packages/database` (Drizzle ORM + drizzle-kit, connection config, migration directory) | `services/api-gateway` (Hono + GET /health) | identity/customer/growth (placeholders) | `apps/dashboard` (Next.js 14) | Docker Compose (PostgreSQL 16 + Mailpit) | DB init scripts | CI pipeline | `.gitignore` + `.nvmrc` + `.env.example` | `docs/` (migrate existing docs) | Root README.md

**Out**: Worker business logic (Identity, Customer, Growth, etc.) | Event bus (Cloudflare Queues) | Domain schema definitions & migrations | Auth middleware | ClickHouse | Playwright E2E | Turborepo

## Capabilities
**New**: None — scaffold creates infrastructure only, no product capabilities.
**Modified**: None — no existing specs.

## Approach
- **Monorepo**: pnpm workspaces, `@vyloop/` scope, workspace protocol for inter-package deps.
- **Services**: Each bounded context = standalone Workers project. api-gateway is Hono + health; identity/customer/growth are stubs.
- **Packages**: `types` first (tenant_id on every entity, schema-first). `database` has Drizzle ORM + drizzle-kit for migrations; schemas/config/utils are scaffold-only.
- **Database migrations**: Drizzle ORM via `drizzle-kit generate` + `drizzle-kit migrate`. Migration directory scaffolded but empty — domain schemas come with their respective feature changes. Drizzle is Workers-native (no native binaries), lightweight, and type-safe.
- **Tooling**: Shared tsconfig.base via tooling/typescript/. ESLint flat config + Prettier in tooling/. Vitest workspace.
- **Dev**: Docker Compose (PostgreSQL 16 + Mailpit). DB init: pgcrypto, uuid-ossp, RLS-ready config. No ClickHouse.
- **CI**: GitHub Actions — install, lint, typecheck, test on push/PR.
- **Docs**: Existing docs reorganized into docs/ (prd/, architecture/, operations/, decisions/).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| Root | New | package.json, pnpm-workspace.yaml, tsconfig.json, .gitignore, .nvmrc, .env.example, README.md |
| tooling/ | New | eslint, prettier, typescript, vitest config packages |
| packages/ | New | types, schemas, database (Drizzle), config, utils (5 workspace pkgs) |
| services/ | New | api-gateway (Hono Worker), identity/customer/growth (stubs) |
| apps/dashboard | New | Next.js 14 App Router, landing page |
| docker/ | New | docker-compose.yml, postgres init scripts |
| .github/workflows/ | New | ci.yml |
| docs/ | New | Reorganized from existing docs |
| atlas-docs/ | Removed | Content consolidated into docs/ |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Stack confusion (SDD says FastAPI, Architecture says Workers) | Med | ADR in docs/decisions; resolved to Workers + Hono |
| Over-scaffolding too many empty packages | Med | Only 1 real service + 3 stubs; defer full business logic |
| Drizzle migration config needs PostgreSQL running | Low | Migration commands documented in README; Docker Compose first |
| RLS complexity from day one | Low | pgcrypto enabled, no policies enforced yet |

## Rollback Plan
`git clean -fd` after commit resets to existing docs + openspec/. No production risk — zero deployed infrastructure.

## Dependencies
- Node.js 20+ (.nvmrc), pnpm 9+
- Docker Desktop (local PostgreSQL + Mailpit)
- Cloudflare account (deploy only, not needed for scaffold)

## Success Criteria
- [ ] `pnpm install` completes without errors
- [ ] `pnpm -r typecheck` passes (zero type errors)
- [ ] `pnpm -r lint` passes (ESLint clean)
- [ ] `drizzle-kit generate` runs without errors (empty migration, proves tooling works)
- [ ] `drizzle-kit migrate` connects to local PostgreSQL and applies empty migration
- [ ] `GET /health` on api-gateway returns `{ status: "ok" }` in dev
- [ ] `docker compose up` starts PostgreSQL 16 + Mailpit
- [ ] DB init scripts execute without errors
- [ ] `apps/dashboard` renders at localhost:3000
- [ ] CI pipeline passes on push (lint + typecheck + test)

# Tasks: Init Repository

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~750–900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Foundation + Packages → PR 2: Services + Apps → PR 3: Infra + Docs |
| Delivery strategy | ask-on-risk |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main (PR 1/3)
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Root monorepo + tooling + 5 packages | PR 1 | Foundation — all shared deps resolve |
| 2 | 4 services + dashboard app | PR 2 | Depends on PR 1 (needs `@vyloop/types`) |
| 3 | Docker Compose + CI + docs migration | PR 3 | Independent infra + cleanup |

## Phase 1: Monorepo Foundation

- [x] 1.1 Create root `package.json` (private, engines node>=20/pnpm>=9, scripts) + `pnpm-workspace.yaml` (apps/*, packages/*, services/*, tooling/*) + `.nvmrc` (20)
- [x] 1.2 Update `.gitignore` — add coverage/, dist/, .next/, .wrangler/, *.toml, .turbo, node_modules/
- [x] 1.3 Create `.env.example` with DATABASE_URL, MAILPIT_SMTP, MAILPIT_API
- [x] 1.4 Create `tooling/typescript/tsconfig.base.json` (strict, ES2022, bundler, declarations)
- [x] 1.5 Create root `tsconfig.json` extending base, references for workspace packages
- [x] 1.6 Create `tooling/eslint/eslint.config.ts` (flat config: typescript-eslint, import, prettier) + root `eslint.config.ts`
- [x] 1.7 Create `tooling/prettier/prettier.config.ts` (semi, singleQuote, trailingComma all, printWidth 100) + root `.prettierrc` pointer
- [x] 1.8 Create `tooling/vitest/vitest.workspace.ts` globbing packages/*, services/*, apps/*

## Phase 2: Shared Packages

- [x] 2.1 Create `packages/types/` — branded types TenantId, UserId, CustomerId, BaseEvent<T>, Entity + package.json, tsconfig, vitest.config
- [x] 2.2 Create `packages/schemas/` — stub with zod dep, re-exports types + package.json, tsconfig
- [x] 2.3 Create `packages/database/` — Drizzle config (postgresql), createDb(), empty schema.ts, drizzle/ dir + package.json, tsconfig, vitest.config
- [x] 2.4 Create `packages/config/` — env() reader stub + package.json, tsconfig
- [x] 2.5 Create `packages/utils/` — noop/sleep stubs + package.json, tsconfig

## Phase 3: Services

- [x] 3.1 Create `services/api-gateway/` — Hono app, GET /health → { status, timestamp }, GET /* → 404, wrangler.jsonc, package.json, tsconfig, vitest.config
- [x] 3.2 Create `services/identity/` — placeholder stub with wrangler.jsonc + package.json + tsconfig
- [x] 3.3 Create `services/customer/` — placeholder stub with wrangler.jsonc + package.json + tsconfig
- [x] 3.4 Create `services/growth/` — placeholder stub with wrangler.jsonc + package.json + tsconfig

## Phase 4: Applications

- [x] 4.1 Create `apps/dashboard/` — Next.js 14 App Router, layout.tsx (HTML shell), page.tsx (Vyloop landing), next.config.ts, package.json, tsconfig, vitest.config

## Phase 5: Infrastructure

- [x] 5.1 Create `docker/docker-compose.yml` — PostgreSQL 16 (port 5432) + Mailpit (1025 SMTP, 8025 UI), named volume pgdata
- [x] 5.2 Create `docker/postgres/init.sql` — enable pgcrypto, uuid-ossp
- [x] 5.3 Create `.github/workflows/ci.yml` — push/PR to main, Node 20 + pnpm 9, install → lint → typecheck → test

## Phase 6: Documentation & Cleanup

- [x] 6.1 Move atlas-docs/ to docs/prd/, docs/architecture/, docs/operations/, docs/decisions/ per spec R16
- [x] 6.2 Move root `analisis.md` → `docs/analisis.md`
- [x] 6.3 Remove `atlas-docs/` directory
- [x] 6.4 Update README.md with project overview, tech stack, prerequisites, getting-started commands

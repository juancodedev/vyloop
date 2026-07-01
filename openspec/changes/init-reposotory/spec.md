# Infrastructure Specification: Init Repository

## Purpose

Scaffold the Vyloop monorepo from zero to a working development environment: shared tooling, type foundation, database tooling, Docker Compose for local PostgreSQL + Mailpit, a health-check API Gateway Worker, a minimal Next.js dashboard, reorganized docs, and CI pipeline.

## Requirements

### R1: Monorepo Workspace

The root SHALL define a pnpm workspace with `apps/*`, `services/*`, `packages/*`, `tooling/*` globs. Root `package.json` MUST set `"private": true`, `engines` (node >=20, pnpm >=9), and scripts: `dev`, `build`, `lint`, `typecheck`, `test`. `.nvmrc` MUST pin Node 20. `.gitignore` MUST cover `node_modules/`, `dist/`, `.next/`, `.wrangler/`, `*.toml` (Wrangler secrets), `.env`, `.turbo`, `coverage/`. `.env.example` MUST declare `DATABASE_URL`, `MAILPIT_SMTP`, `MAILPIT_API`.

#### Scenario: Workspace installs cleanly
- GIVEN no `node_modules/` or lockfile
- WHEN `pnpm install` runs
- THEN all packages resolve via `workspace:*` protocol
- AND `pnpm-lock.yaml` is generated

### R2: TypeScript Base Config

`tooling/typescript/tsconfig.base.json` MUST set `strict: true`, `target: "ES2022"`, `module: "ESNext"`, `moduleResolution: "bundler"`, `declaration: true`, `declarationMap: true`, `sourceMap: true`. Root `tsconfig.json` MUST extend `tooling/typescript/tsconfig.base.json` via `references` pointing to workspace packages. Each package/service MUST have its own `tsconfig.json` extending the base.

#### Scenario: TypeScript compiles across workspace
- GIVEN all packages have valid TypeScript
- WHEN `pnpm -r typecheck` runs
- THEN zero type errors are reported

### R3: ESLint + Prettier Tooling

`tooling/eslint/eslint.config.ts` MUST export a flat ESLint 9 config with `@typescript-eslint`, `eslint-plugin-import`, and Prettier integration. `tooling/prettier/prettier.config.ts` MUST set `semi: true`, `singleQuote: true`, `trailingComma: "all"`, `printWidth: 100`. Root `.prettierrc` MUST point to `tooling/prettier`. Each package MAY extend ESLint config via `eslint.config.ts`.

#### Scenario: Linter passes
- GIVEN valid code across all packages
- WHEN `pnpm -r lint` runs
- THEN ESLint reports zero errors

#### Scenario: Formatter is consistent
- GIVEN any `.ts` file in the workspace
- WHEN `pnpm format` runs
- THEN output matches `tooling/prettier` rules

### R4: Vitest Workspace

`tooling/vitest/vitest.workspace.ts` MUST export a Vitest workspace config referencing all packages, services, and apps. Each package MAY have a local `vitest.config.ts` extending defaults. Root `package.json` MUST have a `test` script.

#### Scenario: Test suite runs
- GIVEN Vitest is configured
- WHEN `pnpm test` runs
- THEN all test files execute (zero failures or skipped-only is acceptable for stub packages)

### R5: packages/types — Domain Types

`@vyloop/types` MUST export:
- `TenantId` — branded string type (`Brand<"TenantId">`)
- `UserId` — branded string type (`Brand<"UserId">`)
- `CustomerId` — branded string type (`Brand<"CustomerId">`)
- `BaseEvent` — generic interface with `id: string`, `type: string`, `timestamp: Date`, `tenant_id: TenantId`, `correlation_id: string`
- `Entity` — generic base interface with `id: string`, `tenant_id: TenantId`, `created_at: Date`, `updated_at: Date`

All entity types MUST carry `tenant_id: TenantId` for multi-tenant readiness.

#### Scenario: Types are usable
- GIVEN `@vyloop/types` is imported
- WHEN assigning a plain string to `TenantId`
- THEN TypeScript reports a type error (brand enforcement)
- WHEN constructing a `BaseEvent`
- THEN `tenant_id` is required

### R6: packages/schemas — Stub

`@vyloop/schemas` SHALL export a minimal placeholder (re-export or empty module). MUST include `zod` as a dependency. `package.json` MUST reference `@vyloop/types` as a dependency.

#### Scenario: Schema package resolves
- GIVEN `@vyloop/schemas` is imported
- WHEN resolving the module
- THEN it loads without errors (may be empty exports)

### R7: packages/database — Drizzle ORM

`@vyloop/database` MUST include:
- `drizzle-orm` and `drizzle-kit` as dependencies
- `postgres` as the driver dependency
- `drizzle.config.ts` with `schema: "./src/schema.ts"`, `out: "./drizzle"`, `dialect: "postgresql"`, `dbCredentials` reading env `DATABASE_URL`
- `src/index.ts` exporting a `createDb(dbUrl: string)` function returning a Drizzle client
- `src/schema.ts` exporting an empty schema map (placeholder for domain schemas)
- Empty `drizzle/` migration directory

#### Scenario: Drizzle tooling works
- GIVEN `DATABASE_URL` is set (local Docker PostgreSQL)
- WHEN `drizzle-kit generate` runs from the package directory
- THEN it succeeds, producing an empty migration snapshot in `drizzle/`

### R8: packages/config — Stub

`@vyloop/config` SHALL export a placeholder function or object. Minimal `package.json` with `@vyloop/types` as a dep.

### R9: packages/utils — Stub

`@vyloop/utils` SHALL export a placeholder identity function or empty module. Minimal `package.json` with `@vyloop/types` as a dep.

### R10: services/api-gateway — Hono Health Worker

`services/api-gateway` MUST be a standalone Cloudflare Worker project with:
- Hono as the HTTP framework
- `src/index.ts` exporting a default Hono app
- `GET /health` returning `{ status: "ok" }` with `Content-Type: application/json`
- A wildcard route `GET /*` returning `404`
- `wrangler.jsonc` with `name: "api-gateway"`, `compatibility_date`, `main: "./src/index.ts"`
- `package.json` with `@vyloop/types` as a dependency

#### Scenario: Health check
- GIVEN the Worker is running in dev mode
- WHEN a `GET /health` request is made
- THEN response status is 200
- AND body is `{ status: "ok" }`

#### Scenario: Unknown route returns 404
- GIVEN the Worker is running
- WHEN a `GET /unknown` request is made
- THEN response status is 404

### R11: Identity, Customer, Growth — Placeholder Stubs

Each service stub (`services/identity/`, `services/customer/`, `services/growth/`) MUST contain:
- `src/index.ts` — placeholder export (empty Worker handler or re-export)
- `package.json` — with `name: "@vyloop/identity"`, `"private": true`, `@vyloop/types` dep
- `tsconfig.json` — extending base config
- `wrangler.jsonc` — minimal Worker config

#### Scenario: Stubs resolve
- GIVEN pnpm workspace is installed
- WHEN importing any stub service as a workspace dependency
- THEN it resolves without errors

### R12: apps/dashboard — Next.js 14

`apps/dashboard` MUST be a Next.js 14 App Router project with:
- `src/app/page.tsx` rendering a landing page (Vyloop branding)
- `src/app/layout.tsx` with HTML shell
- `next.config.ts` with `output: "standalone"` (or default)
- `package.json` with `next`, `react`, `react-dom` dependencies, and scripts `dev`, `build`, `start`
- `@vyloop/types` as a dependency

#### Scenario: Dashboard renders
- GIVEN Next.js dev server is running
- WHEN navigating to `http://localhost:3000`
- THEN the landing page renders without errors

### R13: Docker Compose — PostgreSQL + Mailpit

`docker/docker-compose.yml` MUST define:
- `postgres` service: image `postgres:16-alpine`, env `POSTGRES_DB=vyloop_dev`, `POSTGRES_USER=vyloop`, `POSTGRES_PASSWORD=vyloop_dev`, port `5432`, volume mount for init script + named volume `pgdata`
- `mailpit` service: image `axllent/mailpit`, ports `1025` (SMTP), `8025` (UI)
- Network connecting both services
- Named volume `pgdata`

`docker/postgres/init.sql` MUST enable `pgcrypto` and `uuid-ossp` extensions.

#### Scenario: Docker Compose starts
- GIVEN Docker is running
- WHEN `docker compose up -d` runs from `docker/`
- THEN PostgreSQL 16 accepts connections on port 5432
- AND Mailpit UI is reachable on port 8025

### R14: CI Pipeline

`.github/workflows/ci.yml` MUST trigger on `push` and `pull_request` to `main`. Jobs SHALL run on `ubuntu-latest` with Node 20, pnpm 9. Steps: `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.

#### Scenario: CI passes on clean code
- GIVEN a push to `main`
- WHEN CI workflow runs
- THEN all jobs pass (install, lint, typecheck, test)

### R15: Root Files

Root MUST include `.gitignore`, `.nvmrc`, `.env.example`, `README.md`. The README SHALL contain project overview, tech stack summary, prerequisites (Node 20, pnpm 9, Docker), and getting started commands (`pnpm install`, `docker compose up`, `pnpm dev`).

### R16: Docs Reorganization

Existing `atlas-docs/` content MUST be moved to:
- `docs/prd/` — PRD, Business Model, Market Research, Product Manifesto, Product Vision
- `docs/architecture/` — Architecture, System Design Document, Domain-Driven Design, API Design, Database Design
- `docs/operations/` — Developer Onboarding
- `docs/decisions/` — empty ADR directory
- `atlas-docs/analisis.md` MUST move to `docs/analisis.md`

The original `atlas-docs/` directory SHALL be removed. `README.md` MAY reference `docs/` for further reading.

## Out of Scope

- Full Worker business logic (Identity, Customer, Growth handlers)
- Event bus (Cloudflare Queues abstraction)
- Domain schema definitions and Drizzle migrations
- Auth middleware
- ClickHouse configuration
- Playwright E2E tests
- Turborepo cache configuration

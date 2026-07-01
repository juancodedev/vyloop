# Design: Init Repository

## Technical Approach

Scaffold a pnpm workspace monorepo with three layers — `packages/` (shared libs), `services/` (Cloudflare Workers bounded contexts), `apps/` (Next.js dashboard) — plus `tooling/` (shared configs), `docker/` (PostgreSQL 16 + Mailpit), `.github/workflows/ci.yml`, and reorganized docs. Zero business logic — pure architecture skeleton seeded with domain types.

## Architecture Decisions

| Option | Tradeoffs | Decision |
|--------|-----------|----------|
| pnpm workspaces vs Turborepo | Turborepo adds remote caching + orchestration but extra dep. At 5 packages overhead > benefit. | **pnpm workspaces** — defer Turborepo until build times warrant |
| Drizzle vs Prisma | Prisma generates native binaries incompatible with `workerd` runtime. Drizzle is pure TS, Workers-native, lighter bundle. | **Drizzle ORM + drizzle-kit** |
| Workers + Hono vs FastAPI | FastAPI (Python) = polyglot toolchain, separate CI/deploy. Workers + Hono share TS stack with dashboard and packages. | **Workers + Hono** — stack alignment per Architecture doc (07), overrides earlier SDD draft (05) |
| PostgreSQL only vs +ClickHouse (MVP) | ClickHouse adds 4GB+ RAM requirement, no analytical queries exist yet. | **PostgreSQL only** — ClickHouse deferred to Analytics phase |
| Multi-tenant types from day one | Every entity carries `tenant_id`. Retrofitting RLS later is costly schema migration. | **TenantId branded type** in `packages/types` — all entities extend `BaseEntity` with `tenantId` |

## Directory Tree

```
vyloop/
├── .github/workflows/ci.yml
├── .gitignore / .nvmrc / .env.example / .prettierrc
├── package.json / pnpm-workspace.yaml / tsconfig.json / README.md
├── tooling/
│   ├── typescript/tsconfig.base.json
│   ├── eslint/eslint.config.ts
│   ├── prettier/prettier.config.ts
│   └── vitest/vitest.workspace.ts
├── packages/
│   ├── types/src/index.ts
│   ├── schemas/src/index.ts          # stub
│   ├── database/src/index.ts         # stub + drizzle.config.ts
│   ├── config/src/index.ts           # stub
│   └── utils/src/index.ts            # stub
├── services/
│   ├── api-gateway/src/{index,routes/health}.ts
│   ├── identity/ / customer/ / growth/  # placeholders (package.json + tsconfig only)
├── apps/dashboard/src/app/{layout,page}.tsx
├── docker/{docker-compose.yml,postgres/init.sql}
└── docs/{prd/,architecture/,operations/,decisions/}
```

## Package Dependency Graph

```
types (zero deps)
schemas      → types (+ zod)
config       (zero deps — reads env)
utils        (zero deps)
database     → config (+ drizzle-orm, drizzle-kit, postgres)

api-gateway  → types, config (+ hono)
dashboard    → types (+ next, react-dom)
```

## Dev Workflow

```bash
pnpm install                     # install all workspace deps
docker compose -f docker/docker-compose.yml up -d
pnpm --filter @vyloop/api-gateway dev   # wrangler dev :8787
pnpm --filter @vyloop/dashboard dev     # next dev :3000
pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

## Tooling Configuration

- **TypeScript**: `tooling/typescript/tsconfig.base.json` — `strict: true`, `exactOptionalPropertyTypes`, `paths` for `@vyloop/*`. Root tsconfig extends it. Each package extends root + sets `outDir`, `references[]`.
- **ESLint**: `tooling/eslint/eslint.config.ts` — flat config array (typescript-eslint, import, prettier). Root `eslint.config.ts` imports it and appends project-specific overrides.
- **Vitest**: `tooling/vitest/vitest.workspace.ts` — glob `['packages/*', 'services/*', 'apps/*']`. Each package has `vitest.config.ts` extending a shared helper.

## API Gateway Structure

```
services/api-gateway/
├── src/
│   ├── index.ts          # new Hono(), register routes, export fetch handler
│   └── routes/health.ts  # GET /health → { status: "ok", timestamp }
├── wrangler.jsonc        # name, compatibility_date, nodejs_compat
├── tsconfig.json / vitest.config.ts / package.json
```

`GET /health` returns `{ status: "ok", timestamp: "<ISO>" }` with no auth. Worker entry: `export default { fetch: app.fetch }`.

## Dashboard Structure

```
apps/dashboard/
├── src/app/
│   ├── layout.tsx    # HTML shell, viewport meta, title "Vyloop"
│   └── page.tsx      # "Welcome to Vyloop" landing
├── next.config.ts / tsconfig.json / vitest.config.ts / package.json
```

## Database Migration Approach

- `packages/database/src/index.ts` exports `getDb()` — Drizzle client init with `postgres` driver via `DATABASE_URL`.
- `packages/database/drizzle.config.ts` — schema path `./src/schema.ts`, out `./drizzle/`, driver `postgres`.
- Migration dir `packages/database/drizzle/` scaffolded empty.
- Workflow: `drizzle-kit generate` → review → `drizzle-kit migrate`.
- Domain teams add their table schemas in `src/schema.ts` per-feature; `drizzle.config.ts` imports composed schema.

## CI Pipeline

```yaml
# .github/workflows/ci.yml
on: [push, pull_request]
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: node-version-file: .nvmrc, cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r lint
      - run: pnpm -r typecheck
      - run: pnpm -r test
```

## Docker Compose Services

- **PostgreSQL 16**: `postgres:16-alpine`, DB `vyloop_dev`, user `vyloop`, port 5432. Init: `pgcrypto`, `uuid-ossp`.
- **Mailpit**: `axllent/mailpit`, ports 1025 (SMTP) + 8025 (UI).

## Package Stubs

| Package | Export |
|---------|--------|
| `@vyloop/types` | `TenantId` (branded string), `UserId`, `CustomerId`, `BaseEvent<T>`, `BaseEntity` (`tenantId: TenantId`) |
| `@vyloop/schemas` | Empty Zod schema, re-exports types |
| `@vyloop/config` | `env(key: string): string` — typed `process.env` reader |
| `@vyloop/utils` | `noop()`, `sleep(ms)` |
| `@vyloop/database` | `getDb()` — throws if no `DATABASE_URL` |

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Health endpoint response shape, branded types validation | Vitest, direct function calls |
| Integration | DB client throws on missing URL, Drizzle config loads | Vitest + env mocking |

## Open Questions

None — all decisions resolved in proposal and exploration.

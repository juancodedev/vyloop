## Exploration: Realign monorepo structure to v2.0 specs

### Current State

The Vyloop monorepo was scaffolded during the "init repository" SDD change. The current structure at `/Users/juanmunoz/Documents/GitHub/vyloop` has:

```
vyloop/
├── apps/
│   └── dashboard/              # @vyloop/dashboard, Next.js 14
├── services/
│   ├── api-gateway/            # @vyloop/api-gateway, Hono + CF Workers
│   ├── identity/               # @vyloop/identity, CF Worker stub
│   ├── customer/               # @vyloop/customer, CF Worker stub
│   └── growth/                 # @vyloop/growth, CF Worker stub
├── packages/
│   ├── types/                  # @vyloop/types — imported by 6 packages
│   ├── schemas/                # @vyloop/schemas — depends on @vyloop/types
│   ├── config/                 # @vyloop/config — shared config
│   ├── utils/                  # @vyloop/utils — NOT imported anywhere (dead)
│   └── database/               # @vyloop/database, Drizzle + postgres
├── tooling/                    # NOT in spec
│   ├── typescript/             # tsconfig.base.json
│   ├── eslint/
│   ├── prettier/
│   └── vitest/
├── docker/                     # PostgreSQL 16 + Mailpit
├── docs/                       # Reorganized docs
├── .github/workflows/ci.yml
├── openspec/                   # SDD artifacts
├── vyloop-files/               # v2.0 spec files
├── .gitignore, .nvmrc, .env.example
├── package.json                 # name: "vyloop"
├── pnpm-workspace.yaml         # globs: apps/*, packages/*, services/*, tooling/*
├── tsconfig.json               # path aliases: @vyloop/types, schemas, database, config, utils
└── README.md
```

**Package scope:** All packages use `@vyloop/` scope (e.g., `@vyloop/types`, `@vyloop/schemas`, `@vyloop/dashboard`, etc.).

**Config files that define structure:**
- `pnpm-workspace.yaml` — workspace globs
- `tsconfig.json` — path aliases for all packages
- Root `package.json` — `"name": "vyloop"`

### Target Structure (from 17-Developer-Onboarding.md v2.0)

```
vyloop-core/
├── apps/
│   ├── gateway/                # API Gateway (Cloudflare Workers + Hono)
│   ├── dashboard/              # Next.js — interfaz del negocio
│   └── customer-web/           # Next.js PWA — landing del cliente final
├── workers/
│   ├── identity/               # Dominio Identity
│   ├── customer/               # Dominio Customer
│   ├── growth/                 # Dominio Growth
│   ├── communication/          # Dominio Communication
│   ├── automation/             # Dominio Automation
│   ├── analytics/              # Dominio Analytics
│   └── compliance/             # Dominio Compliance
├── services/
│   └── ai/                     # FastAPI (Python) — IA y ML
├── packages/
│   ├── schema-registry/        # Definiciones de esquemas de eventos
│   ├── db/                     # Migraciones y tipos de base de datos
│   └── config/                 # Configuración compartida
└── docs/
```

### Affected Areas

| Area | What changes | Impact |
|------|-------------|--------|
| `services/api-gateway/` | → `apps/gateway/` | Move + rename package `@vyloop/api-gateway` → `@vyloop/gateway`. Update wrangler.jsonc name. |
| `services/identity/` | → `workers/identity/` | Move dir (keep package name `@vyloop/identity`) |
| `services/customer/` | → `workers/customer/` | Move dir (keep package name `@vyloop/customer`) |
| `services/growth/` | → `workers/growth/` | Move dir (keep package name `@vyloop/growth`) |
| `packages/schemas/` | → `packages/schema-registry/` | Move + rename package `@vyloop/schemas` → `@vyloop/schema-registry` |
| `packages/database/` | → `packages/db/` | Move + rename package `@vyloop/database` → `@vyloop/db` |
| `packages/utils/` | **Remove** | Not in spec, not imported by any package. Dead code. |
| `packages/types/` | **Keep internal** | Not in spec tree but imported by 6 packages. Keep as internal dep merged into schema-registry or as hidden package. |
| `tooling/` | **Keep or flatten** | Not in spec (dev infra, not app structure). Optionally flatten to root level (tsconfig.base.json → root, eslint config → root). |
| `packages/config/` | **Keep** | Stays as `packages/config/`, `@vyloop/config`. No change. |
| NEW `apps/customer-web/` | **Create** | Next.js PWA for customer landing |
| NEW `workers/communication/` | **Create** | Communication Domain Worker (CF) |
| NEW `workers/automation/` | **Create** | Automation Domain Worker (CF) |
| NEW `workers/analytics/` | **Create** | Analytics Domain Worker (CF) |
| NEW `workers/compliance/` | **Create** | Compliance Domain Worker (CF) |
| NEW `services/ai/` | **Create** | FastAPI Python service |
| `pnpm-workspace.yaml` | Update globs | Add `workers/*`, remove `tooling/*` (or keep it), optionally remove `services/*` |
| `tsconfig.json` | Update path aliases | Remove `@vyloop/utils`, rename `@vyloop/schemas` → `@vyloop/schema-registry`, `@vyloop/database` → `@vyloop/db` |
| `root package.json` | Optional rename | `"name": "vyloop"` → `"name": "vyloop-core"` |
| CI workflow | Update workspace patterns | If tooling/* removed from workspace, CI commands need updating |
| Internal imports in source | Fix all references | Import paths and package name references across all consuming packages |
| Git history | Via `git mv` | Safe if using `git mv` (preserves history) |

### Dependency Map (what imports what)

```
@vyloop/types ─┬─ @vyloop/schemas (via package.json + code)
                ├─ @vyloop/api-gateway
                ├─ @vyloop/identity
                ├─ @vyloop/customer
                ├─ @vyloop/growth
                └─ @vyloop/dashboard

@vyloop/schemas ── no consumers (standalone schema definitions)
@vyloop/database ── no consumers (standalone DB layer)
@vyloop/config    ── no consumers (standalone config)
@vyloop/utils     ── no consumers (DEAD — safe to remove)
```

### Approaches

#### A) Full structural realignment first

Move everything to match v2.0 specs in a single coordinated change, then implement Fase 1 backlog.

- **Pros:**
  - Clean, spec-compliant structure from day one
  - One coordinated migration instead of piecemeal changes
  - New devs see the canonical structure immediately
  - No period of structural inconsistency
  - The backlog's Fase 1 item 1 literally says "Setup del monorepo `vyloop-core` con estructura de Workers por dominio"
- **Cons:**
  - Higher up-front effort (config changes, 10+ file moves, CI workflow update)
  - All existing PRs/branches would need rebasing
  - Forces a decision on `types/`, `utils/`, `tooling/` now
- **Effort:** Medium-High

#### B) Incremental — keep current, add new, rename as we go

Keep `services/` structure as-is for the 4 existing Workers. Add new dirs (`workers/communication/`, etc.) as needed when implementing those domains. Rename `schemas` → `schema-registry` and `database` → `db` when touched.

- **Pros:**
  - Lower immediate disruption
  - Git history fully preserved for existing files
  - Team can start coding Fase 1 sooner
  - Less coordination overhead
- **Cons:**
  - Period of inconsistency: `services/identity/` coexists with `workers/communication/`
  - Accumulates exceptions and mental overhead ("our 4 older services live in services/ but new ones go in workers/")
  - The backlog's first task — "Setup del monorepo vyloop-core con estructura de Workers por dominio" — remains incomplete
  - Import paths and internal refs may drift if not cleaned up promptly
- **Effort:** Low initially, but leaves deferred work

#### C) Implement Fase 1 in current structure, then restructure

Build everything (Fase 1 Identity, Gateway, Events, etc.) in the current `services/` layout. After Fase 1 delivery, do the structural realignment.

- **Pros:**
  - Fastest path to writing code
  - Delivers business value first
  - Structural change deferred to when the team knows the codebase better
- **Cons:**
  - **Highest risk of rework**: Moving 4 Workers after they've accumulated real business logic is far more dangerous than moving stubs
  - Internal imports harden during development, making later rename costlier
  - Git history becomes fragmented (file created in services/, later moved to workers/)
  - The v2.0 spec is marked "mandatory" — deferring its structural requirements creates specification debt
  - **Tradeoff analysis**: The "savings" of starting faster are an illusion — you pay the same move cost later, but with more files and more complex dependencies
- **Effort:** Low now, Very High later

### Recommendation

**Approach A — Full structural realignment first, with pragmatic adjustments for non-code infra.**

Rationale:

1. **Spec compliance is mandatory**: The v2.0 specs define this structure. Deferring it means the repo never matches the canonical documentation, which hurts onboarding and creates constant mental overhead.

2. **Current code is stubs**: The 4 existing Workers (`api-gateway`, `identity`, `customer`, `growth`) are stubs with minimal code. Moving them now costs ~nothing. Moving them after Fase 1 (when they have real logic, dependencies on queue bindings, and tests) would cost significantly more.

3. **Fase 1 starts with this exact task**: Backlog item 1 is "Setup del monorepo `vyloop-core` con estructura de Workers por dominio". This exploration IS the setup work. Not doing it means starting Fase 1 with an incomplete task.

4. **Git history is safe**: `git mv` preserves history. There's no risk of losing commit attribution.

### Practical approach specifics

- Use `git mv` for all directory moves (preserves history)
- **Keep `tooling/` as-is** — it's dev infrastructure invisible to the spec's "app structure" tree, and decoupling it adds risk without benefit
- **Keep `packages/types/` as an internal package** (`@vyloop/types`) — it's heavily imported (6 packages), and removing it would force premature consolidation into schema-registry. The spec's package tree shows what's user-facing, not every internal dependency.
- **Remove `packages/utils/`** — it's dead (no imports), not in spec. Drop it.
- **Rename `@vyloop/api-gateway` → `@vyloop/gateway`** to match `apps/gateway/`
- **Rename `@vyloop/schemas` → `@vyloop/schema-registry`**
- **Rename `@vyloop/database` → `@vyloop/db`**
- **Create missing dirs as stubs** — the 5 new Workers, customer-web, and services/ai should be empty stubs with just a `package.json` (or equivalent), aligned with the existing stub pattern
- **Update `pnpm-workspace.yaml`** — add `workers/*`, keep `services/*` for ai/, remove `tooling/*` (optional)
- **Update `tsconfig.json`** — fix path aliases to match new names
- **Root package.json name** — change from `"vyloop"` to `"vyloop-core"` to match spec (check if this affects anything downstream first)

### Risks

1. **Branch conflicts**: Any open branches targeting the current structure will need rebasing. Mitigation: do this as a single PR that gets merged quickly, coordinate with team.
2. **pnpm-lock.yaml invalidation**: After all moves, `pnpm install` will regenerate the lockfile. This is expected but creates a large diff. Mitigation: generate the new lockfile as part of the PR.
3. **`wrangler.jsonc` name fields**: Each Worker has a `name` field in wrangler.jsonc that maps to the deployed Worker name. When moving `api-gateway` to `apps/gateway/`, the wrangler name should match (`gateway`).
4. **CI workflow patterns**: The CI runs `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`. If `tooling/*` is removed from workspace, those packages won't be linted/tested (fine — they have no tests). But need to verify `tooling/*` packages don't have workspace scripts that fail.
5. **`services/` glob in workspace**: After moving domain Workers out, `services/*` will only have the new `ai/` dir. The glob still works, just fewer entries.
6. **Missing `tooling/*` workspace removal**: The root `tsconfig.json` extends `./tooling/typescript/tsconfig.base.json`. Even if `tooling/*` is removed from workspace, the tsconfig reference still works because it's a relative file path, not a workspace package resolution.

### Ready for Proposal

**Yes.** The exploration is complete and the path forward is clear.

**What to tell the orchestrator before proceeding:**
- Approach A is recommended with the pragmatic modifications above
- The proposal phase should define the exact move order and config change checklist
- The actual realignment is a mechanical task (moves + config updates + stub creation) with low technical risk
- Key decision needed: whether to rename root package from `vyloop` to `vyloop-core` (minor impact — affects only npm/pnpm metadata, not imports)

### Internal Import Rename Matrix

| Old package name | New package name | Consumers to update |
|-----------------|-----------------|-------------------|
| `@vyloop/schemas` | `@vyloop/schema-registry` | 0 (no consumers) |
| `@vyloop/database` | `@vyloop/db` | 0 (no consumers) |
| `@vyloop/api-gateway` | `@vyloop/gateway` | 0 (no consumers) |
| `@vyloop/utils` | **Removed** | 0 (dead) |
| `@vyloop/types` | **Keep** | 0 (no rename) |
| `@vyloop/config` | **Keep** | 0 (no rename) |
| `@vyloop/identity` | **Keep** | 0 (no rename) |
| `@vyloop/customer` | **Keep** | 0 (no rename) |
| `@vyloop/growth` | **Keep** | 0 (no rename) |
| `@vyloop/dashboard` | **Keep** | 0 (no rename) |

<small>Note: Internal package renames within the monorepo are handled via the `name` field in package.json and workspace resolution. No consumer code needs updating because workspace packages resolve by path, not by package name, in pnpm workspaces. The only place package names matter is the `pnpm-lock.yaml` and the `tsconfig.json` path aliases for IDE resolution.</small>

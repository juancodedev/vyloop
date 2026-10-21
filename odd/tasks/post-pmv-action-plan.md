# Post-PMV Action Plan

> Status: draft — started 2026-10-20. Living document: update it when a wave
> starts, a migration number is reserved, or a gate closes.
> Source: `docs/18-Trabajo-Pendiente.md` and the nine deferred changes in
> `openspec/changes/`.

## Rules

- One change at a time per lane. Two changes that add a migration never run in
  parallel.
- Reserve the migration number at the start of a change, here and in
  `packages/db/drizzle/meta/_journal.json`. `0019` is the last applied. A number
  is never reused, even if the change is abandoned.
- A change does not start until its decision gates are closed (table below).
- A change whose modified capability is itself unarchived does not archive first.
- Definition of done per change: every task checked, `openspec validate <change>
  --strict` green, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` green, the
  migration applied and registered with `pnpm db:drift` green (when it has one),
  the docs it names updated, and its row removed from `docs/18-Trabajo-Pendiente.md`.

## Lanes

| Lane | Changes | Why this lane |
|---|---|---|
| A. Security and CI | `supply-chain-hardening`, `api-surface-cleanup` | Removes a public unauthenticated write and closes the supply-chain gaps; shares no code with the data work. |
| B. Observability | `request-tracing` | Touches every worker and the gateway; runs after the gateway surface is settled. |
| C. Data and schema (serial) | `message-log-schema-alignment` → `branch-reward-trigger` → `campaign-delivery-idempotency` → `wallet-pass-correctness` | They share schema, the drift gate and the RLS table lists. |
| D. Isolation | `tenant-isolation-rls` | Last: it enforces what every earlier change had to classify. |
| E. Frontend infrastructure | `pages-opennext-migration` | Independent of the data work; keep it away from the dashboard files `wallet-pass-correctness` touches. |

## Order

### Wave 0 — start now

1. **`supply-chain-hardening`** (Lane A). No migration. Touches
   `.github/workflows/ci.yml`, the root `package.json` and the `sslmode` in
   `deploy.yml`.
2. **`api-surface-cleanup`, Units 1 and 4** (Lane A). Unit 1 is the automation
   health probe; Unit 4 is the `pos_terminals` index and takes the first free
   migration number. Unit 2 starts only after the 30-day `/v1/events/*` log
   check; Unit 3 only if the Meta decision of 2026-10-08 is reversed.

### Wave 1 — after Wave 0 starts; do not wait for the 30-day log check

3. **`request-tracing`** (Lane B). Apply task 2.4 only if the ingestor still
   exists when this lands; otherwise skip it, because Unit 2 of
   `api-surface-cleanup` already removed the route.
4. **`pages-opennext-migration`** (Lane E). Can run beside Wave 1: it touches
   `deploy.yml` and the two apps' build config, not the worker code. Start it
   after `supply-chain-hardening` so the two do not edit the same deploy file.

### Wave 2 — schema queue, serial

5. **`message-log-schema-alignment`** (Lane C). Reserves the first migration
   number after the index. Creates `migration-drift-gate` and baseline v2.
6. **`branch-reward-trigger`** (Lane C). Gates: Q1-Q6 answered and
   `push-transport` archived. Reserves the next number.
7. **`campaign-delivery-idempotency`** (Lane C). Gate: `push-transport`
   archived. Reserves the next number. Its `CREATE UNIQUE INDEX CONCURRENTLY`
   stays alone in its migration.
8. **`wallet-pass-correctness`** (Lane C). No migration, so it can run beside 6
   and 7 when the dashboard files stay disjoint. It must land before Lane D.

### Wave 3 — isolation

9. **`tenant-isolation-rls`** (Lane D). Runs its phases 0–4. Phase 0 now
   includes `workers/analytics` and `apps/gateway/src/`; phase 1 records the
   gateway credential decision in `docs/09` §4.

## Migration ledger

| Order | Change | Number | Status |
|---|---|---|---|
| — | last applied | `0019` | applied |
| 1 | `api-surface-cleanup` Unit 4 | `0020_pos_terminals_business` | generated; applied by hand with `CONCURRENTLY` (**pending**) |
| next | — | `0021` | unassigned |

Add a row when a change starts. The active change owns exactly one row until its
migration is applied and registered.

## Decision gates

| Gate | Change | Blocks | State |
|---|---|---|---|
| 30-day `/v1/events/*` log check and Option R/K | `api-surface-cleanup` | Unit 2 and archive | pending |
| Meta webhook decision of 2026-10-08 | `api-surface-cleanup` | Unit 3 only | pending |
| Q1-Q6 in `proposal.md` | `branch-reward-trigger` | Unit 0 and everything after | pending |
| Google revocation state (`INACTIVE` or `EXPIRED`) and the backfill invocation | `wallet-pass-correctness` | Unit 2.9 and Unit 3 | pending |
| `push-transport` archived | `campaign-delivery-idempotency`, `branch-reward-trigger` | archive | done 2026-10-20 (`openspec/specs/push-notifications/`) |
| Gateway credential for phase 1 (`vyloop_app` with the workers, or separate) | `tenant-isolation-rls` | phase 1 | pending |

## Estado al 2026-10-20

**Wave 0 (en curso, sin commit todavía).**

| Change | Unidad | Estado |
|---|---|---|
| `supply-chain-hardening` | 1 (audit gate) | hecho — `scripts/check-audit.mjs`, allowlist con #124, `deps:audit`, paso en CI |
| `supply-chain-hardening` | 2 (TLS) | hecho — `scripts/lib/database-url.mjs` en los cuatro scripts; secret y los 8 `.dev.vars` en `verify-full`; `packages/db/src/tls.ts` + guard en `createDb` |
| `supply-chain-hardening` | 3 (overrides) | hecho — 34 de 43 inertes removidos; quedan 12 (9 inertes que sí mueven una resolución + 2 pins + `jsdom>undici`). El criterio de "lockfile idéntico" no servía: el lockfile guarda la tabla de overrides. Prueba real: `packages:`/`snapshots:` sin cambios |
| `api-surface-cleanup` | 1 (automation `/health`) | hecho — `PUBLIC_PATHS` + tests; producción 200 confirmado tras el deploy de #237 |
| `api-surface-cleanup` | 4 (`pos_terminals` index) | hecho — `0020` aplicada a mano sobre producción (`indisvalid`, 0 scans) y registrada en el ledger por #236; `db:drift` en verde |

**Decisiones tomadas en esta pasada.**

- El índice de `pos_terminals` se genera, se revisa y **no** se aplica desde acá: producción requiere
  `CREATE INDEX CONCURRENTLY`, que no corre dentro de una transacción y por eso no puede ser la
  sentencia del archivo.
- `drizzle-kit generate` volvió a emitir DDL de `0017`/`0018` porque sus snapshots no existen en
  `meta/` (la cadena de snapshots salta de `0016` a `0020`). La migración se recortó a mano a la
  única sentencia propia; incluir las otras habría fallado en producción por objetos ya aplicados.
  Ese hueco de snapshots queda anotado, no arreglado.
- `packages/db/src/index.test.ts` tenía un test que afirmaba `config.indexes === []` para
  `pos_terminals`; se invirtió en la aserción positiva del índice, con columnas y orden.
- `pnpm -r test`: 12 paquetes verdes. `apps/dashboard` reporta 250 tests verdes pero **3 errores
  no manejados** de `jsdom@30` (`ReferenceError: Iterator is not defined`) porque el shell corre Node
  v20.20.2 y el repo pide >=22. Ambiental, previo, no de estos cambios.

## What this plan does not cover

- `POS_PLANS` and the premium rate-limit constant: product decisions listed in
  `docs/18-Trabajo-Pendiente.md`, one line each, not a change.
- Mercado Pago: a future project by the 2026-10-20 decision.
- The 8 legacy unarchived changes under `openspec/changes/` that predate this
  backlog. They are not part of this plan; archiving them is separate hygiene.

## Review findings this plan closes

- The RLS inventory includes `workers/analytics` and the gateway, and the
  contract test rejects the raw setters, not only the two helpers.
- The `wallet-pass-correctness` / `tenant-isolation-rls` ordering is written in
  both changes.
- The five migration producers point to one numbering rule.
- The `push-notifications` dependency is explicit in both consumers.
- `request-tracing` is conditional on the ingestor decision.
- `api-surface-cleanup` states that its Option R deltas are a draft.
- `openspec/config.yaml` declares `apply` and `verify` rules as arrays.

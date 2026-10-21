# Post-PMV Action Plan

> Status: in progress — Wave 0 archived 2026-10-21. Living document: update it when
> a wave starts, a migration number is reserved, or a gate closes.
> Source: `docs/18-Trabajo-Pendiente.md` and the deferred changes in
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

### Wave 0 — archived 2026-10-21

1. **`supply-chain-hardening`** (Lane A). DONE — PR #235, merged 2026-10-20,
   archived as `2026-10-21-supply-chain-hardening`.
2. **`api-surface-cleanup`, Units 1, 2 and 4** (Lane A). DONE — PRs #236/#237,
   merged 2026-10-20, archived as `2026-10-21-api-surface-cleanup`. Unit 2 was
   decided **Option K (keep and fix)**; the 30-day log check is moot (no
   Logpush, no `observability`). Unit 3 (Meta webhook enablement) stays deferred
   by the 2026-10-08 decision; its requirement landed as a dormant contract.

### Wave 1 — next

3. **`request-tracing`** (Lane B). The ingestor still exists (Option K), so
   apply task 2.4. Its dependency (`api-surface-cleanup`) is archived.
4. **`pages-opennext-migration`** (Lane E). Independent; can run beside 3.

### Wave 2 — schema queue, serial

5. **`message-log-schema-alignment`** (Lane C). Reserves `0022`. Creates
   `migration-drift-gate` and baseline v2.
6. ~~**`branch-reward-trigger`**~~ DONE — archived `2026-10-21-branch-reward-trigger`,
   merged #248/#249; took migration `0021`.
7. **`campaign-delivery-idempotency`** (Lane C). Reserves `0023`. Its
   `CREATE UNIQUE INDEX CONCURRENTLY` stays alone in its migration.
8. **`wallet-pass-correctness`** (Lane C). No migration. Gate: Google
   revocation state. Must land before Lane D.

### Wave 3 — isolation

9. **`tenant-isolation-rls`** (Lane D). Runs its phases 0–4. Phase 0 now
   includes `workers/analytics` and `apps/gateway/src/`; phase 1 records the
   gateway credential decision in `docs/09` §4.

## Migration ledger

| Order | Change | Number | Status |
|---|---|---|---|
| — | last applied | `0021` | applied |
| 1 | `api-surface-cleanup` Unit 4 | `0020_pos_terminals_business` | applied by hand with `CONCURRENTLY`; registered (#236) |
| 2 | `branch-reward-trigger` Unit 1 | `0021_reward_branches` | applied by hand and registered (#248) |
| next | `message-log-schema-alignment` | `0022` | unassigned — reserve at start |
| next | `campaign-delivery-idempotency` | `0023` | unassigned |

Add a row when a change starts. The active change owns exactly one row until its
migration is applied and registered.

## Decision gates

| Gate | Change | Blocks | State |
|---|---|---|---|
| ~~30-day `/v1/events/*` log check and Option R/K~~ | `api-surface-cleanup` | Unit 2 | closed 2026-10-20 — **Option K**; the log check is moot (no Logpush) |
| Meta webhook decision of 2026-10-08 | `api-surface-cleanup` | Unit 3 only | pending — requirement landed as a dormant contract |
| ~~Q1-Q6 in `proposal.md`~~ | `branch-reward-trigger` | Unit 0 | closed 2026-10-20 — change archived |
| Google revocation state (`INACTIVE` or `EXPIRED`) and the backfill invocation | `wallet-pass-correctness` | Unit 2.9 and Unit 3 | pending |
| `push-transport` archived | `campaign-delivery-idempotency`, `branch-reward-trigger` | archive | done 2026-10-20 (`openspec/specs/push-notifications/`) |
| `branch-reward-trigger` archived | `campaign-delivery-idempotency` | archive | done 2026-10-21 |
| Gateway credential for phase 1 (`vyloop_app` with the workers, or separate) | `tenant-isolation-rls` | phase 1 | pending |

## Estado al 2026-10-21

**Wave 0 — archivado en OpenSpec.**

| Change | Unidad | Estado |
|---|---|---|
| `supply-chain-hardening` | 1 (audit gate) | hecho — PR #235; archivado `2026-10-21-supply-chain-hardening` |
| `supply-chain-hardening` | 2 (TLS) | hecho — secret y los 8 `.dev.vars` en `verify-full`; guard en `createDb` |
| `supply-chain-hardening` | 3 (overrides) | hecho — 34 de 43 inertes removidos; quedan 12 |
| `api-surface-cleanup` | 1 (automation `/health`) | hecho — PR #237; archivado `2026-10-21-api-surface-cleanup` |
| `api-surface-cleanup` | 2 (ingestor, Opción K) | hecho — auth por posición, tenant del token |
| `api-surface-cleanup` | 4 (`pos_terminals` index) | hecho — `0020` aplicada y registrada (#236) |
| `branch-reward-trigger` | todas | hecho — archivado `2026-10-21-branch-reward-trigger`, mergeado #248/#249 |

**Pendiente de decisión, no de trabajo:** la Unidad 3 de `api-surface-cleanup`
(webhook de Meta) espera la decisión de producto del 2026-10-08; su requerimiento
quedó como contrato dormido en `openspec/specs/communication-whatsapp/spec.md`.

**Fuera de este plan:** `wallet-notifications` (`openspec/changes/wallet-notifications`,
28 tareas) no estaba en el plan. Su propuesta, el formulario de venues y las features de
mensajes ya están en `main` (36a2207, 54f8169), pero `tasks.md` no se marcó y Q1-Q6
siguen como *asumidas*. Se decide aparte.

**Nota de ambiente:** `pnpm -r test` corre con Node v20.20.2 mientras el repo pide
>=22; `apps/dashboard` reporta 3 errores no manejados de `jsdom@30`
(`ReferenceError: Iterator is not defined`). Ambiental, previo, no de estos cambios.

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

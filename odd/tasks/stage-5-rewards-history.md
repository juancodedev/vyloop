# Stage 5 — Rewards, redeem and history (customer web)

## Objective

Complete the customer self-service surface so a customer can see the real reward catalog, redeem a reward for themselves, and read their own points history — using only the Club Barrio visual language established in stages 0–4.

## Problem

Stage 4 shipped `/profile` with balance, program, tier ladder, real ID, QR and activity. The three surfaces a customer actually wants next — browse rewards, redeem, and review history — are still unbuilt, and the two that exist as placeholders depend on a client-held identifier that the server no longer trusts.

`apps/customer-web/app/profile/rewards/page.tsx` and `history/page.tsx` still read and write `vyloop_customer_id` in `localStorage`. #115 made the server reject a `customer_id` that disagrees with the token subject, and #115 removed the only writer of that key from `/profile`. `history/page.tsx` has **no fallback**: with the key absent it never calls the API and renders a hard error whose copy tells the user to go back to `/profile`, which no longer writes the key. The instruction is now wrong and the page is unreachable on a fresh device.

## Why now

The security work in #115/#117 made the correct client contract unambiguous: **the browser never supplies `customer_id`.** Omitting it means "me". Building Stage 5 on that contract removes the localStorage dependency entirely and retires the last of the sequencing risk. Building it the other way round would rebuild a footgun we just removed.

## Scope

In scope:
- `apps/customer-web/app/profile/rewards/page.tsx` — real catalog
- `apps/customer-web/app/profile/rewards/confirm/page.tsx` — redeem confirmation
- `apps/customer-web/app/profile/history/page.tsx` — own history
- New `reward-card.tsx` and `movement-list.tsx` components
- The `## Verification` commands below

Out of scope:
- Google Wallet (separate feature, blocked on an external Google approval)
- Wallet/top-up (`docs/10-Wallet-Experience.md`)
- Any change to a worker, the gateway, or the database
- `GET /v1/loyalty/config` gating (tracked as follow-up in #117)

## The contract these pages must honour

- `GET /v1/loyalty/rewards?active=true` — catalog. No role check, customers may read.
- `POST /v1/loyalty/rewards/redeem` — body `{ reward_id?, points, reference_id }`. **`customer_id` is optional and must be omitted.** For a customer it means "my own record".
- `GET /v1/loyalty/points/transactions` — history. No role check, customers may read. **Omitting `customer_id` means "mine".**
- Reward fields available: `name`, `description`, `pointsCost`, `category`, `stock`, `autoGrantThreshold`, `imageUrl`.
- `loyalty_programs.points_currency` is the points label. Do not hardcode "points".

## Constraints

1. **Never send `customer_id` from the browser.** Not as a query param, not in a body. Remove the `vyloop_customer_id` read/write from all three pages. If you find a residual reference anywhere under `apps/customer-web`, remove it and say so.
2. **No invented data.** No fake reward names, prices, stock levels, tiers or milestones. If an endpoint returns nothing, render an honest empty state. Do not derive a "progress" percentage from local rules.
3. **The server is the authority on balance.** Do not compute affordability client-side as the source of truth; use the server's response for the post-redeem balance. A client-side pre-check may exist as a courtesy but must not be what decides whether to attempt a redeem.
4. **Preserve the failure modes that matter**: insufficient balance, sold out (`stock === 0` or null), double-click / double-submit, and `reference_id` uniqueness (`DUPLICATE_REFERENCE`). The double-submit guard must be a real in-flight lock, not a disabled attribute alone.
5. **Accessibility**: `aria-pressed` on the redeem affordance, focus moved to the outcome after a redeem, and the empty state announced rather than colour-only.
6. **Club Barrio language only.** Match stage 4's tokens. No new colour system, no new font, no default-Tailwind look.
7. `imageUrl` is optional and may be absent. Handle absence without a broken image.

## Tasks

- [x] **T1** — Inventory every read of `vyloop_customer_id` under `apps/customer-web` and report the list before changing anything.
- [x] **T2** — Add a typed client function for the catalog and one for own history, both sending no `customer_id`.
- [x] **T3** — `reward-card.tsx`: renders one real reward. Handles absent `imageUrl`, absent `description`, `stock === 0`, `stock === null` (untracked).
- [x] **T4** — `rewards/page.tsx`: catalog grid, honest empty state, link to confirm.
- [x] **T5** — `movement-list.tsx`: renders one `points_transactions` row. `points` is signed — earned positive, spent negative. Do not render a negative balance as if it were positive, and do not label an earn as a spend.
- [x] **T6** — `history/page.tsx`: own history, no `customer_id`, no dead "go back to /profile" copy, honest empty state.
- [x] **T7** — `confirm/page.tsx`: redeem for self, in-flight lock, `reference_id` generated per attempt, surfaces insufficient-balance and out-of-stock from the server verbatim in meaning.
- [x] **T8** — Remove the `vyloop_customer_id` writes in all three pages; confirm T1's list is empty afterwards.
- [x] **T9** — Tests for each of the three pages plus both new components. Include: no request body ever contains `customer_id`; empty catalog; empty history; `stock === 0` disables redeem; out-of-stock server error surfaces; double-click issues exactly one request; `DUPLICATE_REFERENCE` surfaces; earned vs spent render distinctly.
- [x] **T10** — Verify the `## Verification` commands and report observed results.

## Acceptance criteria

- No request from these three pages contains `customer_id` anywhere.
- `localStorage` key `vyloop_customer_id` is gone from `apps/customer-web`.
- A customer on a fresh device with no prior `/profile` visit can reach all three surfaces and use them.
- Every rendered value traces to an API response or a real DB row.
- Redeem cannot be triggered twice by one gesture.
- Full monorepo suite green.

## ## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"
node -v                                   # must be v22.x
pnpm --filter @vyloop/customer-web test
pnpm --filter @vyloop/customer-web lint
pnpm --filter @vyloop/customer-web typecheck
pnpm -r test
rg -n "vyloop_customer_id" apps/customer-web   # must return nothing
```

## Route and evidence log

| Task | Route | Commit | Evidence | Review |
|------|-------|--------|----------|--------|
| T1–T10 | `GET /v1/loyalty/rewards`, `POST /v1/loyalty/rewards/redeem`, `GET /v1/loyalty/points/transactions` (consumidas, no modificadas) | #118 `7abb8a2`, merged 2026-09-26 | `app/profile/rewards/page.tsx`, `app/profile/rewards/confirm/page.tsx`, `app/profile/history/page.tsx`, `app/components/reward-card.tsx`, `app/components/movement-list.tsx`, `app/lib/api.ts` | merged |

**Confirmaciones verificables en `main`:**

- Los cinco archivos de producción del scope existen en `main`.
- `git grep vyloop_customer_id origin/main -- apps/customer-web` no devuelve nada: la clave de localStorage está eliminada, que es el criterio de aceptación de T8 y la primera línea de `## Verification`.
- Cada página y cada componente nuevo tiene su archivo `*.behavior.test.tsx` en `main`: `rewards`, `confirm`, `history`, `reward-card`, `movement-list`, más `no-customer-id.behavior.test.tsx` que cubre el contrato de "el browser nunca manda `customer_id`".
- Los tres endpoints que consume el scope son los del contrato documentado, y ninguno fue modificado por este stage: el diff de #118 no toca ningún worker, ni el gateway, ni `packages/db` — consistente con el "Out of scope" declarado arriba.

## Forecast

Authored changed lines across T1–T10: roughly 500–650 including tests. Above the ~400 advisory threshold, so if this is delivered as one PR it should be reviewed as two: catalog+browse (T1–T4, T8–T9) and redeem+history (T5–T7, T9–T10). TDD mode: not configured for this project; functional checks only.

**Cómo se entregó:** se mergeó como un solo PR (#118), no como dos. La separación en dos revisiones que anticipaba el forecast no ocurrió.

## Progress

Shipped. T1–T10 están mergeados en #118 (`7abb8a2`, 26 de septiembre de 2026). Google Wallet sigue fuera de scope, como estaba planificado: es una feature separada, bloqueada por una aprobación externa de Google.

Objective: apply the approved redesign (canvas https://claude.ai/artifact/QnYq4f2k3pP6hA3htVLJJs) to the merchant app `apps/dashboard`, from the landing page to the dashboard, one phase per PR.
Branch: feat/dashboard-redesign (one branch per phase). Delivery: one PR per phase (user: "vamos por parte"). Runner: vitest in apps/dashboard (`npx vitest run`, Node 22).

## Specs

- S1 Visual identity from the approved mockup: bottle green `#1F4D3A`, enamel white `#FAFAF7`, sign yellow `#F2C230`, ink `#15191B`, red `#C8412E` for errors only; Bricolage Grotesque for headings, Instrument Sans for text; lucide icons only. Scope: `apps/dashboard` only. `packages/design-system` tokens are shared with `apps/customer-web`, so the dashboard overrides them in its own CSS instead of changing the package (assumption: the customer app keeps its current look).
- S2 One token system in the dashboard: `globals.css` stops defining a second blue/slate palette; its names resolve to the S1 tokens.
- S3 Landing rebuilt as in the mockup: no dead links (`#pricing`, `#demo`), no invented figures ("+500 negocios en Latinoamérica"), copy about Google Wallet and points by purchase amount.
- S4 Login restyled as in the mockup. The test account hint stays visible (user: "esto "demo@cafecentral.com / demo123", dejalo así, es mi cuenta de pruebas y por ahora, da lo mismo que este visible o accesible").
- S5 Sidebar regrouped (Hoy, Clientes; Programa; Tu local) with "Abrir caja" first; Inicio, Programa and Analytics merge into one "Hoy" page; every nav target is a real route.
- S6 POS works by purchase amount as in the mockup: no hardcoded `MENU`, no USD formatting; amounts in CLP.
- S7 Dead code removed: `lib/mock-data.ts` (never imported).

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2, S7 (foundation: tokens, fonts, globals, dead code, page titles) | inline | done: 287 tests, tsc, eslint, next build green; no visual check (no browser here) | 2775ad8 (#298, merged) |
| T2 | S3, S4 (landing + login) | inline | done: RED 4/4 on the old landing, then 293 tests, tsc, eslint, next build green; no visual check | c83a0fd |
| T3 | S5 (sidebar + Resumen) | inline | done: RED 7/7, then 303 tests, tsc, eslint, next build green; no visual check | see L3 |
| T4 | S6 (POS) | inline | pending | |

## Log

- L1 (2026-10-28) User: "revisemos un re diseño del sitio, desde el landing page hasta el dashboard, creo que no esta muy esteticamente atractivo, algunos elementos que estan ahi no se usan o no funcionan" → mockup → "me gusta la propuesta, implementemosla / vamos por parte eso si".
- L2 Uncommitted wallet demo-mode files (workers/wallet/wrangler.jsonc, its contract test, docs/18) belong to another change; never stage them here.
- L3 T3: the API has no per-day figures and no inactive-customer list, so the mockup's "Hoy" (sales today, "hace rato que no vienen") became "Resumen" with totals since the program started, labelled as such. /dashboard/analytics and /dashboard/loyalty redirect to /dashboard. loyalty/customers joins the sidebar as "Saldos".

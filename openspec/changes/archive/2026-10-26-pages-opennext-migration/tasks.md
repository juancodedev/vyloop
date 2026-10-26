# Tasks: Pages to OpenNext Migration

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| Estimated changed lines | ~500 (additions + deletions), excluding `pnpm-lock.yaml`                      |
| 400-line budget risk    | Medium                                                                        |
| Chained PRs recommended | Yes                                                                           |
| Suggested split         | Unit 1 (dashboard) → Unit 2 (customer-web) → Unit 3 (hostnames) → Unit 4 (cleanup) |
| Delivery strategy       | ask-on-risk                                                                   |

Decision needed before apply: Yes — the target hostname for each Worker (`workers.dev` subdomain or a custom route).
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

### Suggested Work Units

| Unit | Goal                                                       | Likely PR | Lines | Notes                                              |
| ---- | ---------------------------------------------------------- | --------- | ----- | -------------------------------------------------- |
| 1    | Dashboard builds and deploys as a Worker                   | PR #1     | ~150  | Lowest risk; no printed URL.                       |
| 2    | Customer web builds and deploys as a Worker                | PR #2     | ~150  | Needs Unit 1's deploy-job shape.                   |
| 3    | Hostname cut-over: redirectors and new defaults            | PR #3     | ~120  | Needs Units 1 and 2 verified in production.        |
| 4    | Remove the old adapter and its stale references            | PR #4     | ~80   | Last; proves `braces` leaves the lockfile.         |

### Prerequisites, measured 2026-10-21

`@opennextjs/cloudflare@1.20.13` declares `next: ">=15.5.28 <16 || >=16.4.1"` and
`wrangler: "^4.148.0"`. The repository had Next `16.3.8` — inside neither branch of
the Next range — and wrangler `4.107.0`. Neither Unit 1 nor Unit 2 can install the
adapter until both are satisfied, so the bumps come first and are not part of the
migration's line budget:

- wrangler `4.107.0` → `^4.151.3` (this branch). Verified with
  `wrangler deploy --dry-run` on `apps/gateway` and `workers/wallet` under Node 22,
  which the repository already requires (`.nvmrc`). Wrangler 4.148+ refuses Node 20,
  so a workstation on Node 20 cannot run the dry run at all.
- Next `16.3.8` → `16.4.2` (Dependabot #257). A Next upgrade is normally out of scope
  here; this one is a precondition, not an upgrade.

The peer range excludes 16.4.0 and earlier 16.0–16.3 on purpose, so `^16.3.8` resolving
to `16.4.x` tomorrow does not make the migration installable today: the lockfile pins
what is installed.

Items marked **(verify)** depend on OpenNext or Cloudflare behaviour that MUST be checked against the documentation current at implementation time.

## Unit 1: Dashboard on OpenNext

- [x] 1.1 `apps/dashboard/package.json` — add `@opennextjs/cloudflare` as a devDependency; replace `"pages:build": "next-on-pages"` with an OpenNext build script (e.g. `"cf:build"`) and add a local preview script **(verify the CLI command names)**
- [x] 1.2 `apps/dashboard/open-next.config.ts` — minimal configuration, no incremental cache **(verify the required shape)**
- [x] 1.3 `apps/dashboard/wrangler.jsonc` — Worker `vyloop-dashboard`, `main` and `assets` as emitted by the build, `compatibility_flags: ["nodejs_compat"]`, `compatibility_date` no older than OpenNext requires **(verify)**
- [x] 1.4 `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx:3` — remove `export const runtime = 'edge'`
- [x] 1.5 `.gitignore` and `tooling/eslint/eslint.config.ts:69` — ignore the OpenNext output directory (`.open-next/` **(verify)**) the way `.vercel` is ignored today
- [x] 1.6 `apps/dashboard/src/__tests__/` — a contract test that reads `package.json` and asserts no `next-on-pages` dependency and no `runtime = 'edge'` under `src/app`
- [x] 1.7 `.github/workflows/deploy.yml` (`deploy-dashboard`, lines 489-521) — build with the OpenNext script, keep `NEXT_PUBLIC_API_URL` on the build step, deploy with `wrangler deploy` from `apps/dashboard`; keep the Pages project untouched
- [x] 1.8 Verify locally: the preview serves `/login`, `/dashboard`, `/dashboard/customers/<id>`; check the reported bundle size against the plan limit **(verify the limit)**
- [x] 1.9 Confirm `CLOUDFLARE_API_TOKEN` has Workers Scripts edit permission before merging — verified by the real thing rather than by inspecting the token: `deploy-dashboard` ran `wrangler deploy` on `main` after #268 and succeeded in 59s (Deploy run 39714809767). A token without Workers Scripts: Edit fails at that step, not after it

## Unit 2: Customer web on OpenNext

- [x] 2.1 `apps/customer-web/package.json` — same dependency and script change as 1.1
- [x] 2.2 `apps/customer-web/open-next.config.ts` and `apps/customer-web/wrangler.jsonc` — Worker `vyloop-customer-web`, as in 1.2-1.3
- [x] 2.3 `apps/customer-web/next.config.mjs` — keep the `/program` rewrite and both production guards; rewrite the comment at lines 6-15 so it explains the Workers-with-assets routing instead of Pages advanced mode
- [x] 2.4 `apps/customer-web/app/program-route.contract.test.ts` — keep the assertions (rewrite present, destination exists, no `public/_redirects`); rewrite the header comment (lines 11-23) for the new runtime
- [x] 2.5 Served-request proof of `/program`: run the preview, request `/program`, record status 200 and the page title in the PR description **(verify assets-vs-Worker routing order)** — measured: the directory form `public/program/index.html` made the assets layer answer `/program` with a `307` to `/program/` before the app saw the request, and the Next rewrite to `/program/index.html` returned Next's own `404` because a public file is served by the assets binding, not by a rewrite. Renaming the page to `public/program.html` serves `/program` with `200` directly, so the rewrite was removed rather than re-proved: the reason it existed was a Pages-era limitation that Workers static assets do not have
- [x] 2.6 `.github/workflows/deploy.yml` (`deploy-customer-web`, lines 523-571) — build with the OpenNext script, keep `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the build step, deploy with `wrangler deploy`
- [x] 2.7 Verify on the Worker hostname: `/`, `/register?biz=<slug>`, `/login`, `/profile`, `/program`, the service worker `/sw.js` and `/manifest.webmanifest` (push transport depends on both) — measured: all `200`, as do `/`, `/login`, `/profile` and `/register?biz=<slug>`

## Unit 3: Hostname cut-over

- [x] 3.1 A redirector source for each Pages project (`tooling/pages-redirect/customer-web/_redirects` and `tooling/pages-redirect/dashboard/_redirects`) with a single `/* https://<worker-host>/:splat 301` rule; query strings preserved — **verified**: preview deployment at `https://a2eed702.vyloop-customer-web.pages.dev/register?biz=cafe-central` → 301 → `https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=cafe-central` with `?biz=` intact. The rule has no `_worker.js` on purpose: a Pages project without advanced mode respects `_redirects`, unlike the old `next-on-pages` bug
- [x] 3.2 Deploy each redirector — commands and results recorded:
```
wrangler pages deploy tooling/pages-redirect/customer-web --project-name=vyloop-customer-web --branch=main
# Deployment complete! Take a peek over at https://c59bddbb.vyloop-customer-web.pages.dev
wrangler pages deploy tooling/pages-redirect/dashboard --project-name=vyloop-dashboard --branch=main
# Deployment complete! Take a peek over at https://657efce4.vyloop-dashboard.pages.dev
```
Production verified: `vyloop-customer-web.pages.dev/register?biz=cafe-central` → 301 → Worker with query string; `vyloop-dashboard.pages.dev/dashboard?x=1` → 301 → Worker with query string
- [x] 3.3 `DEFAULT_CUSTOMER_WEB_BASE_URL` and tests updated to `vyloop-customer-web.cl-jmunoz.workers.dev` — 4 files changed, tests green
- [x] 3.4 `DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL`, both `wrangler.jsonc` bindings, and all dependent tests updated to `vyloop-customer-web.cl-jmunoz.workers.dev` — 11 files changed, wallet suite 789 tests green
- [x] 3.5 `scripts/verify-guards.mjs` mutation fixtures updated — 4 occurrences replaced
- [x] 3.6 `README.md` customer web links updated — 5 occurrences replaced
- [x] 3.7 Verified end-to-end: `https://vyloop-customer-web.pages.dev/register?biz=cafe-central` → HTTP/2 301 → `https://vyloop-customer-web.cl-jmunoz.workers.dev/register?biz=cafe-central` → HTTP/2 200 with the real page, query string intact. The zombi build that was serving on the old hostname is replaced by the redirector

## Unit 4: Remove the old adapter

- [x] 4.1 Remove `@cloudflare/next-on-pages` from both `package.json` files and refresh `pnpm-lock.yaml`; confirm `braces` and `chokidar@3.6.0` no longer appear, and close Dependabot #124 with that evidence — the dependency was gone from both manifests since Units 1 and 2, but `pnpm install` kept an **unreachable snapshot** of `next-on-pages` in the lock (0 importers, nothing installed), and `pnpm audit` reads the lock, so `braces` stayed alive and the allowlist entry kept covering it. `pnpm dedupe` pruned 638 lines: `next-on-pages`, `braces` and `chokidar@3.6.0` are gone, and the now-stale allowlist entry was removed, leaving the file empty. Side effect, disclosed: dedupe re-resolved four pins within their declared ranges (three patches, plus `lucide-react` 1.23.0 → 1.59.0); all checked green below. There is no open Dependabot alert for `braces` to close — `GET /dependabot/alerts?state=all` returns `[]` — and #124 is a merged wallet PR, not an alert, so the task's reference does not resolve
- [x] 4.2 `README.md:428-429` — the deploy job descriptions: now "OpenNext build + Worker deploy"
- [x] 4.3 Reword "`next-on-pages` static export" in `workers/wallet/src/helpers.ts:200`, `apps/gateway/src/merchant-page.ts:9`, `apps/gateway/src/merchant-route.test.ts:97`, `workers/wallet/src/provision.test.ts:558`, `scripts/check-wallet-readiness.mjs:39`
- [x] 4.4 `docs/18-Trabajo-Pendiente.md:20` — **not marked done**, because it is not: Units 1, 2 and 4 are, and Unit 3 is still blocked on the hostname decision. The row stays, rewritten to say exactly that. Marking it done would have made the backlog lie about a cut-over that has not happened
- [x] 4.5 Run `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test` — all green, plus `pnpm install --frozen-lockfile` (what CI runs) and `pnpm deps:audit` → PASS with no stale allowlist note

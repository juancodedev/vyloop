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

Items marked **(verify)** depend on OpenNext or Cloudflare behaviour that MUST be checked against the documentation current at implementation time.

## Unit 1: Dashboard on OpenNext

- [ ] 1.1 `apps/dashboard/package.json` — add `@opennextjs/cloudflare` as a devDependency; replace `"pages:build": "next-on-pages"` with an OpenNext build script (e.g. `"cf:build"`) and add a local preview script **(verify the CLI command names)**
- [ ] 1.2 `apps/dashboard/open-next.config.ts` — minimal configuration, no incremental cache **(verify the required shape)**
- [ ] 1.3 `apps/dashboard/wrangler.jsonc` — Worker `vyloop-dashboard`, `main` and `assets` as emitted by the build, `compatibility_flags: ["nodejs_compat"]`, `compatibility_date` no older than OpenNext requires **(verify)**
- [ ] 1.4 `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx:3` — remove `export const runtime = 'edge'`
- [ ] 1.5 `.gitignore` and `tooling/eslint/eslint.config.ts:69` — ignore the OpenNext output directory (`.open-next/` **(verify)**) the way `.vercel` is ignored today
- [ ] 1.6 `apps/dashboard/src/__tests__/` — a contract test that reads `package.json` and asserts no `next-on-pages` dependency and no `runtime = 'edge'` under `src/app`
- [ ] 1.7 `.github/workflows/deploy.yml` (`deploy-dashboard`, lines 489-521) — build with the OpenNext script, keep `NEXT_PUBLIC_API_URL` on the build step, deploy with `wrangler deploy` from `apps/dashboard`; keep the Pages project untouched
- [ ] 1.8 Verify locally: the preview serves `/login`, `/dashboard`, `/dashboard/customers/<id>`; check the reported bundle size against the plan limit **(verify the limit)**
- [ ] 1.9 Confirm `CLOUDFLARE_API_TOKEN` has Workers Scripts edit permission before merging

## Unit 2: Customer web on OpenNext

- [ ] 2.1 `apps/customer-web/package.json` — same dependency and script change as 1.1
- [ ] 2.2 `apps/customer-web/open-next.config.ts` and `apps/customer-web/wrangler.jsonc` — Worker `vyloop-customer-web`, as in 1.2-1.3
- [ ] 2.3 `apps/customer-web/next.config.mjs` — keep the `/program` rewrite and both production guards; rewrite the comment at lines 6-15 so it explains the Workers-with-assets routing instead of Pages advanced mode
- [ ] 2.4 `apps/customer-web/app/program-route.contract.test.ts` — keep the assertions (rewrite present, destination exists, no `public/_redirects`); rewrite the header comment (lines 11-23) for the new runtime
- [ ] 2.5 Served-request proof of `/program`: run the preview, request `/program`, record status 200 and the page title in the PR description **(verify assets-vs-Worker routing order)**
- [ ] 2.6 `.github/workflows/deploy.yml` (`deploy-customer-web`, lines 523-571) — build with the OpenNext script, keep `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the build step, deploy with `wrangler deploy`
- [ ] 2.7 Verify on the Worker hostname: `/`, `/register?biz=<slug>`, `/login`, `/profile`, `/program`, the service worker `/sw.js` and `/manifest.webmanifest` (push transport depends on both)

## Unit 3: Hostname cut-over

- [ ] 3.1 A redirector source for each Pages project (for example `tooling/pages-redirect/customer-web/_redirects` and `…/dashboard/_redirects`) with a single `/* https://<worker-host>/:splat 301` rule; confirm query strings are preserved **(verify `_redirects` semantics)**
- [ ] 3.2 Deploy each redirector once with `wrangler pages deploy <dir> --project-name=vyloop-customer-web` / `vyloop-dashboard`; record the commands and results in the PR
- [ ] 3.3 `apps/dashboard/src/lib/merchant-qr.ts:50` (`DEFAULT_CUSTOMER_WEB_BASE_URL`) and its tests `merchant-qr.test.ts`, `src/__tests__/qr-tenant.contract.test.ts` — new hostname
- [ ] 3.4 `workers/wallet/src/helpers.ts:164` (`DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL`), `workers/wallet/wrangler.jsonc:73`, `apps/gateway/wrangler.jsonc:46`, and the tests that pin them (`workers/wallet/src/wrangler-config.contract.test.ts`, `helpers.test.ts`, `class.test.ts`, `provision.test.ts`, `sweep.test.ts`) — new hostname
- [ ] 3.5 `scripts/verify-guards.mjs:303-322` — the mutation fixtures that spell the old hostname
- [ ] 3.6 `README.md:102,111,124` — the customer web links
- [ ] 3.7 Verify: a pre-migration URL (`https://vyloop-customer-web.pages.dev/register?biz=cafe-central`) answers 301 to the new host with the query string intact

## Unit 4: Remove the old adapter

- [ ] 4.1 Remove `@cloudflare/next-on-pages` from both `package.json` files and refresh `pnpm-lock.yaml`; confirm `braces` and `chokidar@3.6.0` no longer appear, and close Dependabot #124 with that evidence
- [ ] 4.2 `README.md:428-429` — the deploy job descriptions
- [ ] 4.3 Reword "`next-on-pages` static export" in `workers/wallet/src/helpers.ts:200`, `apps/gateway/src/merchant-page.ts:9`, `apps/gateway/src/merchant-route.test.ts:97`, `workers/wallet/src/provision.test.ts:558`, `scripts/check-wallet-readiness.mjs:39`
- [ ] 4.4 `docs/18-Trabajo-Pendiente.md:20` — mark `pages-opennext-migration` done
- [ ] 4.5 Run `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`

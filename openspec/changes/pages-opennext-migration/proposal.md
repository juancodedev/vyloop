# Proposal: Pages to OpenNext Migration

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Move the two Next.js applications, `apps/customer-web` and `apps/dashboard`, off
`@cloudflare/next-on-pages` and onto the OpenNext Cloudflare adapter
(`@opennextjs/cloudflare`), which deploys a Next.js application as a Cloudflare
Worker with static assets instead of as a Cloudflare Pages project.

`next-on-pages` is deprecated, and Cloudflare's recommended path for Next.js is
the OpenNext adapter. Nothing is broken today: both applications build and
deploy. The cost of waiting is that every Next.js upgrade is taken on an adapter
that no longer follows Next.js, and that the only dependency path that pulls
`braces` into the lockfile (`@cloudflare/next-on-pages@1.13.16` → `chokidar@3.6.0`
→ `braces@3.0.3`, `pnpm-lock.yaml:3840,3862,4984-4987`, Dependabot #124,
dismissed as tolerable risk) stays in the tree.

This is not a PMV concern. It is recorded so the migration can be scheduled
deliberately rather than forced by a Next.js release the old adapter cannot
build.

## Scope

### In Scope

1. Replace `@cloudflare/next-on-pages` with `@opennextjs/cloudflare` as a
   devDependency in `apps/customer-web/package.json` and
   `apps/dashboard/package.json`, and replace the `"pages:build": "next-on-pages"`
   script with an OpenNext build script (and a preview script for local runs).
2. Add a Worker configuration per application (`apps/customer-web/wrangler.jsonc`,
   `apps/dashboard/wrangler.jsonc`) and an `open-next.config.ts` per application.
   Neither application has a `wrangler` file today.
3. Rewrite the two deploy jobs in `.github/workflows/deploy.yml`
   (`deploy-dashboard`, lines 489-521; `deploy-customer-web`, lines 523-571):
   the build step stops producing `.vercel/output/static`, and
   `wrangler pages deploy … --project-name=…` becomes a Worker deploy.
4. Remove the one edge-runtime declaration the old adapter required:
   `export const runtime = 'edge'` in
   `apps/dashboard/src/app/dashboard/customers/[id]/page.tsx:3`. It is the only
   one in either application.
5. Re-prove the `/program` rewrite (`apps/customer-web/next.config.mjs`,
   `rewrites()`), whose comment and contract test
   (`apps/customer-web/app/program-route.contract.test.ts`) are written in terms of
   the `next-on-pages` advanced-mode `_worker.js`.
6. Keep the public hostnames working: `vyloop-customer-web.pages.dev` is printed
   in merchant QR codes (`apps/dashboard/src/lib/merchant-qr.ts:50`,
   `DEFAULT_CUSTOMER_WEB_BASE_URL`) and embedded in issued Google Wallet passes
   (`workers/wallet/src/helpers.ts:164`, `DEFAULT_WALLET_CUSTOMER_WEB_BASE_URL`;
   `workers/wallet/wrangler.jsonc:73` and `apps/gateway/wrangler.jsonc:46`,
   `WALLET_CUSTOMER_WEB_BASE_URL`). Those URLs cannot be recalled.
7. Update the stale references to the old adapter: `README.md:428-429`,
   the comments in `apps/customer-web/next.config.mjs:10`,
   `apps/customer-web/app/program-route.contract.test.ts:13-22`, and the
   "`next-on-pages` static export" wording in `workers/wallet/src/helpers.ts:200`,
   `apps/gateway/src/merchant-page.ts:9`, `apps/gateway/src/merchant-route.test.ts:97`,
   `workers/wallet/src/provision.test.ts:558` and
   `scripts/check-wallet-readiness.mjs:39`.

### Out of Scope

- Upgrading Next.js, React or any other dependency beyond what the adapter
  requires.
- Introducing a custom domain for either application. The migration keeps the
  current hostnames reachable; moving to a custom domain is a separate product
  decision.
- Server-side features the new runtime would allow (ISR, caching layers, R2 /
  KV incremental cache). The applications are migrated as they are.
- Any change to `apps/gateway` or `workers/*` routing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `customer-web`: how the application is built, deployed and reached.
- `growth-dashboard`: how the dashboard application that hosts these views is
  built, deployed and reached.

## Approach

**One application at a time, dashboard first.** The dashboard is the lower-risk
of the two: its only users are merchants, it holds no printed URL, and it has
exactly one route with a runtime declaration. The customer web goes second,
because its hostname is printed in QR codes and embedded in passes.

**Per-application Worker configuration.** Each application gets a
`wrangler.jsonc` naming the Worker (`vyloop-dashboard`, `vyloop-customer-web`),
its `main` entry and its `assets` binding as produced by the OpenNext build, and
the `nodejs_compat` compatibility flag. The exact entry path, assets directory
and minimum `compatibility_date` MUST be taken from the OpenNext documentation
current at implementation time; they are not asserted here. The repo convention
for Workers (`apps/gateway/wrangler.jsonc:4-5`: `compatibility_date` plus
`["nodejs_compat"]`) is the starting point.

**Build-time variables stay build-time.** Every value the applications read is a
`NEXT_PUBLIC_*` variable inlined by `next build`: `NEXT_PUBLIC_API_URL` (both),
`NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
(customer-web). The deploy jobs keep passing them as environment variables of
the build step, exactly as `deploy.yml:510-511` and `:557-562` do today. The
production guards in `apps/customer-web/next.config.mjs` (refusing an empty or
`localhost` gateway URL and an empty VAPID key) keep working unchanged because
they run inside `next build`, which the OpenNext build invokes.

**Edge runtime declaration removed.** OpenNext runs the Node.js runtime on
Workers and does not support `export const runtime = 'edge'` in the same way the
old adapter required it. The single declaration is removed; the page is a
client component (`'use client'`) and the declaration has no behavioural
effect there. Verify against the OpenNext documentation at implementation time
whether a leftover `runtime = 'edge'` is an error or a warning; either way the
target state has none.

**The `/program` rewrite has to be proven again, not assumed.** The current
reasoning — "advanced mode ignores `_redirects`, so the rewrite must live in the
Worker" — is specific to Pages. Under Workers with static assets, `public/`
files are served by the assets layer and the Next rewrite is evaluated by the
OpenNext Worker. Whether a request for `/program` reaches the Worker before the
assets layer answers 404 depends on the assets routing configuration and MUST
be verified with a real build and a served request (`opennextjs-cloudflare
preview` or a deployed preview), as the existing test comment already demands.
The contract test keeps asserting that the rewrite exists and that no
`_redirects` file claims the job; its prose is rewritten for the new runtime.

**The `pages.dev` hostname is kept alive as a redirector.** The Workers deploy
gets its own hostname (a `workers.dev` subdomain or a custom route). The
`vyloop-customer-web` Pages project is NOT deleted: after the Worker is
verified, the Pages project is redeployed one last time with a minimal static
site whose `_redirects` (valid again, because that deployment is no longer an
advanced-mode `_worker.js`) sends every path to the same path on the new
hostname with a 301, preserving the query string. Printed QR codes and issued
passes keep working. The defaults in `merchant-qr.ts`, `helpers.ts` and the two
`wrangler.jsonc` files move to the new hostname in the same change, so new QR
codes and new passes stop depending on the redirector. The dashboard Pages
project gets the same treatment, with lower stakes.

**The cut-over is the hostname, not the deploy.** Both deploy targets can exist
at once. The deploy jobs publish to the Worker; the Pages project keeps serving
the last `next-on-pages` build until the redirector replaces it.

## Risks

- **A route that builds and 404s.** The `/program` incident is the precedent: a
  build that looks correct on disk can 404 in production. Mitigated by the
  served-request check in the tasks, not by a unit test.
- **Printed URLs.** Deleting the Pages project, or redeploying it without the
  redirector, breaks every QR code already printed and every pass link already
  issued, with no way to reach the holders. The Pages project stays.
- **Bundle size limit.** A Worker has a compressed size limit that a Pages
  `_worker.js` was also subject to, but the OpenNext output is shaped
  differently. The build reports the size; it MUST be checked against the
  account's plan limit before the first deploy (verify current limits at
  implementation time).
- **Middleware and images.** Neither application has a `middleware.ts` nor uses
  `next/image` today (grep over `apps/*/app` and `apps/dashboard/src`, no
  results), so neither OpenNext's middleware handling nor its image
  optimisation configuration is exercised. If either is added before this
  change is implemented, it has to be added to the scope.
- **CI credentials.** `CLOUDFLARE_API_TOKEN` currently needs Pages edit rights;
  a Workers deploy needs Workers Scripts edit rights. The token's permissions
  MUST be checked before the first deploy, or the job fails at publish.

## Rollback Plan

Until the redirector is deployed, rollback is a revert of the deploy-job change:
the Pages projects still hold the last `next-on-pages` build and keep serving
it, and nothing points users at the Worker hostname yet.

After the redirector is deployed, rollback is redeploying the last good
`next-on-pages` build to the Pages project (`wrangler pages deploy
.vercel/output/static --project-name=…`, built from the pre-migration commit)
and reverting the default-hostname commits. The Worker can be left running
unreferenced or deleted.

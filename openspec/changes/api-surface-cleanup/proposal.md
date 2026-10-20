# Proposal: API Surface Cleanup

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Intent

Four small pieces of the public API surface say one thing and do another. None
of them blocks the PMV, and each is a trap for the next person who reads the
code or the docs and believes them:

1. `/v1/automation` is routed by the gateway to a worker that serves nothing under
   it, and the worker's one route, `/health`, is unreachable.
2. `POST /v1/events/{type}` is mounted on the gateway, called by nothing in the
   product, documented with event names that do not exist in the registry, and
   answers before the gateway's authentication.
3. The WhatsApp Meta webhook `/webhook` on the communication worker answers 403
   to Meta. It is dormant by product decision (2026-10-08), and what enabling it
   requires is written down only in prose.
4. `pos_terminals` has no index for the merchant listing that now exists, and the
   schema comment saying nobody issues that query is stale.

## Scope

### In Scope

1. **`/v1/automation`**: keep the gateway prefix; make the automation worker's
   `/health` reachable without gateway headers.
2. **Event ingestor**: an explicit decision between *retire* (recommended) and
   *keep and fix*, and the work for the recommended option.
3. **Meta webhook**: the specification of what enabling it requires, so the
   dormant state is a documented contract rather than a hidden 403.
4. **`pos_terminals`**: the index `idx_pos_terminals_business` and the
   registrations the repository convention requires.

### Out of Scope

- **Workflow CRUD.** `openspec/specs/automation-engine/spec.md` ("Workflow CRUD")
  specifies `GET/POST/PUT/DELETE /v1/automation/workflows`, and the dashboard page
  `apps/dashboard/src/app/dashboard/communication/workflows/page.tsx:79,95,128`
  already calls `/v1/automation/workflows` and `/v1/automation/workflows/{id}/toggle`.
  `workers/automation/src/routes.ts` implements none of them, so the "Flujos"
  page (`apps/dashboard/src/lib/navigation.ts:54`) receives the automation
  worker's own 404. Implementing the CRUD is a feature, not a cleanup; it is the
  reason this change keeps the prefix, and it SHOULD get its own change.
- Turning the Meta webhook on. The decision of 2026-10-08 stands; this change
  only specifies what turning it on means.
- Changes to `matchRoute` or `EXACT_PUBLIC_PATHS` in the gateway.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-gateway`: the `/v1/automation` namespace and the automation worker's
  health probe; the removal of `/v1/events` from the route map.
- `event-ingestor`: retired (recommended option).
- `communication-whatsapp`: the Meta webhook's real path, its public-path
  exemption, its verify token and its signature check.
- `database`: the `pos_terminals` listing index.

## Approach

### 1. `/v1/automation`: keep the prefix, make `/health` reachable

Evidence: `ROUTE_MAP` maps `/v1/automation` to `automation`
(`apps/gateway/src/router.ts:35`); the worker registers only `GET /health`
(`workers/automation/src/routes.ts:21`); and `workers/automation/src/index.ts:23`
runs `extractAuthHeaders` on `app.use('*')`, so a direct request to `/health`
without gateway headers is refused (`docs/18-Trabajo-Pendiente.md:911-916`).

**Option A — drop the prefix from `ROUTE_MAP`.** Rejected. The automation-engine
spec reserves `/v1/automation/workflows`, the dashboard already calls it, and
removing the prefix would turn the worker's 404 into the gateway's 404 —
the failure this repository has hit three times and documents in
`router.ts:26-34` and `docs/18-Trabajo-Pendiente.md:840-860`. The Workflow CRUD
change would then have to re-add it.

**Option B — keep the prefix and make `/health` reachable.** Chosen. Add an exact
`PUBLIC_PATHS` set to `workers/automation/src/index.ts` with `/health`, checked on
the raw pathname before `extractAuthHeaders`, the same shape `workers/wallet`
(`index.ts:121,130`) and `workers/growth` (`index.ts:60,67`) already use. The
worker's `/health` stays in `ROUTES_OUTSIDE_GATEWAY_NAMESPACE`
(`apps/gateway/src/wrangler-route-reachability.contract.test.ts:172-185`), and
that entry's claim becomes true. The comment at `:70-74` that calls `/v1/automation`
"guarded but … no route behind it" is updated to point at the Workflow CRUD gap.

Whether the automation worker is reachable on its own `workers.dev` hostname
(no `workers_dev` or `routes` key is set in `workers/automation/wrangler.jsonc`)
MUST be verified against the deployed worker; if it is not, `/health` is only
reachable through tests and the exemption is still correct but unused.

### 2. Event ingestor: decision point, recommendation *retire*

Evidence:
- `apps/gateway/src/ingestor.ts:58` mounts `POST /v1/events/:type`, and
  `apps/gateway/src/index.ts:51` mounts the ingestor **before** the `/v1/*`
  auth middleware (`index.ts:289-381`). `apps/gateway/src/index.test.ts:578-600`
  gets 202 with no `Authorization` header. (`apps/gateway/src/error-log.test.ts:339`
  states the opposite in a comment; the executable test is the evidence.)
- The envelope's `business_id` is taken from the request body
  (`ingestor.ts:126`), defaulting to `'unknown'`.
- Accepted events go to `DOMAIN_EVENTS_QUEUE` (`ingestor.ts:140`), whose consumer
  is the growth worker.
- The registry keys are PascalCase (`CustomerRegistered`, `PointsAssigned`,
  `RewardRedeemed`, … in `packages/schema-registry/scripts/register-schemas.ts:32-57`),
  while `docs/08-API-Design.md:135-136` and `openspec/specs/event-ingestor`
  describe `/v1/events/purchase` and `/v1/events/custom`
  (`docs/14-Backlog.md:41-44`).
- Nothing in `apps/` or `workers/` calls `/v1/events`.

**Option R — retire (recommended).** Remove the route, its mount, the
`/v1/events` entry from `ROUTE_MAP`, the gateway's queue producer bindings that
exist only for it (`EVENT_QUEUE`, `DOMAIN_EVENTS_QUEUE` in
`apps/gateway/wrangler.jsonc` and `GatewayEnv`, `router.ts:172-174`), and the
docs. Rationale: no caller; a public endpoint that lets an unauthenticated caller
put a schema-valid domain event for any `business_id` onto the queue the growth
worker consumes is a liability with no product behind it. The `SCHEMA_REGISTRY`
binding stays on the gateway config, because the `register-schemas` deploy job
addresses the namespace through `--config apps/gateway/wrangler.jsonc`
(`.github/workflows/deploy.yml:271-273`); `wrangler-config.contract.test.ts`
pins it.

**Option K — keep and fix.** Only if a concrete integration (a POS or an external
system posting purchases) is scheduled. It would require: the route behind the
`/v1/*` auth with `business_id` taken from the verified token, never from the
body; a defined list of externally ingestible event types (a purchase event such
as the existing `purchase_completed.json` schema in
`packages/schema-registry/src/schemas/`, registered under the name the URL uses);
validation of the payload rather than the whole body (`ingestor.ts:96` passes
`body`); rate limiting; and an idempotency key. That is a feature, not a cleanup.

The decision MUST be recorded before implementation. The deltas in this change
specify Option R.

### 3. Meta webhook: what enabling it requires

Evidence: the handlers are `GET /webhook` and `POST /webhook` on the
communication worker (`workers/communication/src/routes.ts:334,370`), not the
`/v1/communication/whatsapp/webhook` the current spec names. The worker's global
middleware (`workers/communication/src/index.ts:26-41`) calls
`extractAuthHeaders` on every path, so Meta's request gets 403.
`WHATSAPP_VERIFY_TOKEN` is read (`helpers.ts:34`, `routes.ts:339`) but not
declared in `workers/communication/wrangler.jsonc` (only `WHATSAPP_API_VERSION`).
The POST handler does not verify Meta's payload signature. The test harness
sends `X-User-Role` and the other gateway headers on every request
(`workers/communication/src/routes.test.ts:119`), so the webhook tests pass with
credentials Meta never sends (`docs/18-Trabajo-Pendiente.md:917-922`).

The delta MODIFIES "Meta Webhook Handler" to: the real path; an exact
`PUBLIC_PATHS` exemption for `/webhook`; `WHATSAPP_VERIFY_TOKEN` and the app
secret delivered as worker secrets; signature verification on POST; tests that
send no gateway headers. The gateway's `WEBHOOK_PREFIX`
(`apps/gateway/src/index.ts:58`, `/v1/communication/webhook`) is a different
namespace and is not touched. Meta's exact signature header and algorithm
(`X-Hub-Signature-256`, HMAC-SHA256 over the raw body with the app secret) MUST
be confirmed against Meta's documentation at implementation time.

### 4. `pos_terminals` index

Evidence: `GET /v1/loyalty/terminals` (`workers/growth/src/routes.ts:2665`) runs
`where business_id = $1 order by created_at desc`, and `pos_terminals`
(`packages/db/src/schema.ts:663-689`) declares only its foreign key. The comment
at `schema.ts:651-662` says the listing query does not exist yet.

The index is `idx_pos_terminals_business` on `(business_id, created_at desc)`,
which serves both the filter and the order. Repository convention, all in one
commit:

- `schema.ts`: the index in the table's extra-config callback (a module-level
  `index()` is dropped by drizzle-kit, `schema.ts:680-683`), and the stale
  comment rewritten.
- `packages/db/src/indexes.ts`: `posTerminals` in `INDEXED_TABLES` (`:39-52`),
  `idxPosTerminalsBusiness` in `INDEX_NAMES` (`:66`), and a named export via
  `indexByName`.
- `packages/db/src/index.ts`: the re-export (the `from './indexes'` block, `:182`).
- `packages/db/src/index.test.ts`: the binding → name pair, beside
  `idxPushSubscriptionsBusiness: 'idx_push_subscriptions_business'` (`:107-110`).
- A generated migration in `packages/db/drizzle/` with the next free number,
  reviewed. Production migrations are hand-applied, so the applied migration is
  registered in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with
  `{ "kind": "index", "name": "idx_pos_terminals_business" }` as evidence.

## Risks

- **Retiring a route someone uses.** Nothing in the repository calls it; a
  production request log for `/v1/events/*` over 30 days MUST be checked before
  removal. Any hit means Option K, or a deprecation period.
- **A public `/health` on the automation worker.** It returns a constant and reads
  nothing, so exposure is nil; the exemption is exact, never a prefix.
- **The index on a live table.** One row per till; the build is instant. Use
  `CREATE INDEX CONCURRENTLY` when applying by hand regardless.

## Rollback Plan

- Automation: remove the `PUBLIC_PATHS` check; nothing depends on it.
- Ingestor: revert the commit; the route, bindings and `ROUTE_MAP` entry come
  back unchanged, and the registry is untouched.
- Meta webhook: nothing ships enabled; no rollback needed until it is turned on.
- Index: `DROP INDEX CONCURRENTLY idx_pos_terminals_business;` and revert the
  registration commit, including its entry in `_applied-outside-drizzle.json`.

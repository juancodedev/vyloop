# Tasks: API Surface Cleanup

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Estimated changed lines | ~450 (additions + deletions), Unit 3 only when the webhook is enabled     |
| 400-line budget risk    | Low per unit                                                              |
| Chained PRs recommended | No — four independent PRs                                                 |
| Suggested split         | Unit 1, Unit 2, Unit 4 independent; Unit 3 waits for the product decision |
| Delivery strategy       | ask-on-risk                                                               |

Decision needed before apply: Yes — Option R (retire) or Option K (keep and fix) for the event ingestor; a 30-day production log check for `/v1/events/*` precedes it.
Chained PRs recommended: No
Chain strategy: none
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal                                         | Likely PR | Lines | Notes                                          |
| ---- | -------------------------------------------- | --------- | ----- | ---------------------------------------------- |
| 1    | Automation `/health` reachable               | PR #1     | ~60   | Independent.                                   |
| 2    | Retire the event ingestor (Option R)         | PR #2     | ~200  | Needs the decision and the log check.          |
| 3    | Meta webhook enablement                      | PR #3     | ~150  | Only when the 2026-10-08 decision is reversed. |
| 4    | `pos_terminals` listing index                | PR #4     | ~60   | Independent. Touches a persisted schema.       |

## Unit 1: Automation health probe

- [x] 1.1 `workers/automation/src/index.ts:23` — add an exact `PUBLIC_PATHS` set (`'/health'`) checked on `new URL(c.req.url).pathname` before `extractAuthHeaders`, the shape of `workers/wallet/src/index.ts:121,130`
- [x] 1.2 `workers/automation/src/index.test.ts` (new; the worker has no app-level test today) — `GET /health` with no gateway headers answers 200 `{ status: 'ok', service: 'automation' }`; `GET /health/extra` without headers is still refused
- [x] 1.3 `apps/gateway/src/wrangler-route-reachability.contract.test.ts:70-74` — reword the `/v1/automation` note to name the unimplemented Workflow CRUD and the dashboard page that calls it; keep the `ROUTES_OUTSIDE_GATEWAY_NAMESPACE` entry (`:172-185`)
- [x] 1.4 Verify whether `workers/automation` is reachable on its `workers.dev` hostname in production; record the answer in `docs/18-Trabajo-Pendiente.md` (~line 911)

## Unit 2: Retire the event ingestor

- [ ] 2.1 Decision gate: check 30 days of production gateway logs for `/v1/events/*`; record Option R or K in this file and in `docs/14-Backlog.md:41-58`
- [ ] 2.2 `apps/gateway/src/ingestor.ts` — delete; `apps/gateway/src/index.ts:6,50-51` — remove the import and the mount
- [ ] 2.3 `apps/gateway/src/router.ts:24,172-174` — remove the `/v1/events` entry and `EVENT_QUEUE` / `DOMAIN_EVENTS_QUEUE` from `GatewayEnv`; keep `SCHEMA_REGISTRY`
- [ ] 2.4 `apps/gateway/wrangler.jsonc:156-170` — remove the two queue producer bindings; keep the `SCHEMA_REGISTRY` KV binding, which `deploy.yml:271-273` uses to address the namespace
- [ ] 2.5 `apps/gateway/src/index.test.ts:578-660` — replace the "Event Ingestor" block with: `POST /v1/events/PointsAssigned` answers 404 with and without a token, and publishes nothing
- [ ] 2.6 `apps/gateway/src/error-log.test.ts:249,342` — move the two cases that use `/v1/events/customer.created` to another routed path that produces the same status
- [ ] 2.7 `apps/gateway/src/wrangler-config.contract.test.ts` — keep the `SCHEMA_REGISTRY` pin; it holds no queue assertions today, so add one that the gateway declares no queue producers
- [ ] 2.8 `docs/08-API-Design.md:131-136` (Events section), `docs/07-Architecture.md:86`, and `openspec/specs/api-gateway/spec.md` via archive of this change
- [ ] 2.9 Run `pnpm --filter @vyloop/gateway test` and `typecheck`

## Unit 3: Meta webhook enablement (only when the product decision changes)

- [ ] 3.1 `workers/communication/src/index.ts:26` — an exact `PUBLIC_PATHS` set with `'/webhook'`, checked before `extractAuthHeaders`
- [ ] 3.2 `workers/communication/wrangler.jsonc` — document `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` as secrets (set with `wrangler secret put`, never in `vars`); `helpers.ts:34` — add `WHATSAPP_APP_SECRET` to `Bindings`
- [ ] 3.3 `workers/communication/src/routes.ts:334` — refuse verification when `WHATSAPP_VERIFY_TOKEN` is missing or empty
- [ ] 3.4 `workers/communication/src/routes.ts:370` — verify the payload signature over the raw body before parsing (HMAC-SHA256 with the app secret, constant-time compare; confirm the header name and format against Meta's documentation); 401 when missing or invalid
- [ ] 3.5 `workers/communication/src/routes.test.ts:119,362-436` — the webhook tests send no `X-User-Id`, `X-Business-Id` or `X-User-Role`; add cases for an unsigned and a wrongly signed POST, and for a missing verify token
- [ ] 3.6 Configure the URL in Meta's app dashboard as the worker's own hostname plus `/webhook`, and record it in `docs/18-Trabajo-Pendiente.md` (~line 923)

## Unit 4: `pos_terminals` listing index

- [x] 4.1 `packages/db/src/schema.ts:679-689` — add `index('idx_pos_terminals_business').on(table.businessId, table.createdAt.desc())` to the extra-config callback; rewrite the stale comment at `:651-662` to cite `GET /v1/loyalty/terminals` (`workers/growth/src/routes.ts:2665`)
- [x] 4.2 `packages/db/src/indexes.ts` — add `posTerminals` to `INDEXED_TABLES` (`:39-52`), `idxPosTerminalsBusiness: 'idx_pos_terminals_business'` to `INDEX_NAMES` (`:66`), and `export const idxPosTerminalsBusiness = indexByName(INDEX_NAMES.idxPosTerminalsBusiness);`
- [x] 4.3 `packages/db/src/index.ts` — re-export `idxPosTerminalsBusiness` in the `from './indexes'` block (`:182`)
- [x] 4.4 `packages/db/src/index.test.ts` — add the `idxPosTerminalsBusiness: 'idx_pos_terminals_business'` pair beside the push-subscription ones (`:107-110`)
- [x] 4.5 Generate the migration with `pnpm --filter @vyloop/db exec drizzle-kit generate` (next free number in `packages/db/drizzle/`, reserved per `docs/18-Trabajo-Pendiente.md`), review it, and confirm `migration-sql.test.ts` passes
- [ ] 4.6 **(pending — production only)** Apply in production by hand with `CREATE INDEX CONCURRENTLY`, then register the migration in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `{ "kind": "index", "name": "idx_pos_terminals_business" }` as evidence, so the `migration-drift` deploy gate accepts it
- [x] 4.7 Run `pnpm --filter @vyloop/db test` and the full `pnpm -r test`

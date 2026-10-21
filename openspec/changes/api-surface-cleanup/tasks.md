# Tasks: API Surface Cleanup

> Status: Units 1, 2 and 4 done (2026-10-20). Unit 3 deferred: the Meta webhook
> stays dormant until the product decision of 2026-10-08 is reversed.

## Review Workload Forecast

| Field                   | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Estimated changed lines | ~450 (additions + deletions), Unit 3 only when the webhook is enabled     |
| 400-line budget risk    | Low per unit                                                              |
| Chained PRs recommended | No — four independent PRs                                                 |
| Suggested split         | Unit 1, Unit 2, Unit 4 independent; Unit 3 waits for the product decision |
| Delivery strategy       | ask-on-risk                                                               |

Decision needed before apply: No — Unit 2 decided **Option K (keep and fix)** on 2026-10-20. Unit 3 still waits on the product decision.
Chained PRs recommended: No
Chain strategy: none
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal                                         | Likely PR | Lines | Notes                                          |
| ---- | -------------------------------------------- | --------- | ----- | ---------------------------------------------- |
| 1    | Automation `/health` reachable               | PR #1     | ~60   | Independent.                                   |
| 2    | Keep and fix the event ingestor (Option K)   | PR #2     | ~200  | Done. Auth by position, tenant from token.     |
| 3    | Meta webhook enablement                      | PR #3     | ~150  | Only when the 2026-10-08 decision is reversed. |
| 4    | `pos_terminals` listing index                | PR #4     | ~60   | Independent. Touches a persisted schema.       |

## Unit 1: Automation health probe

- [x] 1.1 `workers/automation/src/index.ts:23` — add an exact `PUBLIC_PATHS` set (`'/health'`) checked on `new URL(c.req.url).pathname` before `extractAuthHeaders`, the shape of `workers/wallet/src/index.ts:121,130`
- [x] 1.2 `workers/automation/src/index.test.ts` (new; the worker has no app-level test today) — `GET /health` with no gateway headers answers 200 `{ status: 'ok', service: 'automation' }`; `GET /health/extra` without headers is still refused
- [x] 1.3 `apps/gateway/src/wrangler-route-reachability.contract.test.ts:70-74` — reword the `/v1/automation` note to name the unimplemented Workflow CRUD and the dashboard page that calls it; keep the `ROUTES_OUTSIDE_GATEWAY_NAMESPACE` entry (`:172-185`)
- [x] 1.4 Verify whether `workers/automation` is reachable on its `workers.dev` hostname in production; record the answer in `docs/18-Trabajo-Pendiente.md` (~line 911)

## Unit 2: Keep and fix the event ingestor (Option K)

- [x] 2.1 Decision gate. **Option K (keep and fix)**, recorded 2026-10-20 here and in `docs/14-Backlog.md:41-58`. The 30-day log check was the gate for *retiring* the route and cannot be run either way: no `wrangler.jsonc` in the repository sets `observability`, there is no Logpush job, and Workers Logs would not have retained 30 days. The evidence used instead is behavioural and stronger for this decision: nothing under `apps/` or `workers/` calls the route; the documented names 404 in production (`POST /v1/events/purchase` → 404 on 2026-10-20); `GET /v1/events/health` answered 200 from a public hostname; and the route was mounted above the auth chain.
- [x] 2.2 `apps/gateway/src/index.ts` — remove the pre-middleware `app.route('/', ingestor)` mount and mount `app.route('/v1/events', ingestor)` **below** the five `/v1/*` middlewares, next to `POST /v1/support`. Registration order is the authentication; the comment says so.
- [x] 2.3 `apps/gateway/src/ingestor.ts` — routes become `/:type` and `/health`; a `jwt.business_id` check answers 401 `AUTH_TOKEN_INVALID` when no claim is on the context; the envelope's `business_id` is the token's; a body whose `header.business_id` names another business answers 403 `EVENT_BUSINESS_MISMATCH`; a body with no `payload` key is treated as the payload (the `CustomerRegistered` schema shape) instead of publishing `undefined`.
- [x] 2.4 `apps/gateway/src/router.ts` — keep the `/v1/events` `gateway` entry and both queue bindings: `routerMiddleware` calls `next()` for a gateway-owned prefix, so the entry is what makes the route reachable, and the ingestor still produces.
- [x] 2.5 `apps/gateway/src/index.test.ts` — the "Event Ingestor" block now drives the real chain: 202 with a token; 401 without one; 403 when the body names another business; a client-supplied `X-Business-ID` is replaced by the claim; the published envelope carries the token's `business_id`; the bare-payload shape reaches the queue with its body as `payload`; 400/404 unchanged.
- [x] 2.6 `apps/gateway/src/error-log.test.ts` — the real-500 case now sends a valid token, because the fake bearer it used to send is refused with 401 before the KV throw it needs; the token-leak assertion stays on `triggerReal500`, which carries `AUTH_TOKEN_VALUE` on `/brand/*`.
- [x] 2.7 `docs/08-API-Design.md` (Events section), `docs/07-Architecture.md:86`, `docs/14-Backlog.md`, `openspec/specs/event-ingestor/spec.md` — the registry keys, the auth requirement, and the two error codes.
- [x] 2.8 Run `pnpm --filter @vyloop/gateway test`, `typecheck`, `lint` and `openspec validate` — all green on 2026-10-20.
- [x] 2.9 The independent verifier caught what the mocked registry could not: `register-schemas.ts` publishes eight **PascalCase** keys, and the first correction had renamed the docs to `points_assigned` / `purchase_completed`, which are different KV keys and 404 just like `purchase` did. `test_event` is not registered at all, so the dev-queue branch is dormant. Fixed in `docs/07`, `docs/08`, `docs/14`, `proposal.md`, the spec and both deltas; `apps/gateway/src/event-ingestor.registry.contract.test.ts` now reads the `eventType:` array and the `docs/08` table and fails when they disagree.

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
- [x] 4.6 Apply in production by hand with `CREATE INDEX CONCURRENTLY`, then register the migration in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `{ "kind": "index", "name": "idx_pos_terminals_business" }` as evidence, so the `migration-drift` deploy gate accepts it. Done 2026-10-20: index created on `br-delicate-paper-aitqyq9y` (`indisvalid = true`), ledger entry merged in #236, `migration-drift` green on the deploy.
- [x] 4.7 Run `pnpm --filter @vyloop/db test` and the full `pnpm -r test`

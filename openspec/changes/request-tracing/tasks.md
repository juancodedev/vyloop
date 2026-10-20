# Tasks: Request Tracing

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                             |
| ----------------------- | --------------------------------------------------------------------------------- |
| Estimated changed lines | ~750 (additions + deletions)                                                      |
| 400-line budget risk    | High                                                                              |
| Chained PRs recommended | Yes                                                                               |
| Suggested split         | Unit 1 (package) → Unit 2 (gateway) → Unit 3 (workers) → Unit 4 (events + docs)   |
| Delivery strategy       | ask-on-risk                                                                       |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

High-risk item: (3) contracts others consume — the shared envelope header
schema and the worker error body. Unit 4's schema change gets its own commit.

### Suggested Work Units

| Unit | Goal                                                 | Likely PR | Lines | Notes                                   |
| ---- | ---------------------------------------------------- | --------- | ----- | --------------------------------------- |
| 1    | `@vyloop/request-context` package                    | PR #1     | ~150  | Must land first.                        |
| 2    | Gateway establishes, forwards and echoes the id      | PR #2     | ~200  | Needs Unit 1.                           |
| 3    | Eight workers: middleware, `onError`, error envelope | PR #3     | ~250  | Needs Unit 1. Parallel with Unit 2.     |
| 4    | Envelope header, schema, `consume`, producers, docs  | PR #4     | ~150  | Needs Units 2 and 3 for end-to-end ids. |

## Unit 1: Shared package

- [ ] 1.1 `packages/request-context/package.json`, `tsconfig.json`, `vitest.config.ts` — following `packages/types`; `hono` as a peer dependency
- [ ] 1.2 `packages/request-context/src/index.ts` — `REQUEST_ID_HEADER = 'X-Request-Id'`, `REQUEST_ID_PATTERN`, `isValidRequestId`, `resolveRequestId(value)`, `requestIdMiddleware()` (sets `c.set('requestId')`, rewrites the forwarded request header, sets the response header after `next()`), `logPrefix(service, requestId)`
- [ ] 1.3 `packages/request-context/src/index.test.ts` — valid ids kept; empty, too long, space, newline and `=` refused; generated id is a UUID; response header set on success and after a thrown error; prefix format

## Unit 2: Gateway

- [ ] 2.1 `apps/gateway/package.json` — depend on `@vyloop/request-context`
- [ ] 2.2 `apps/gateway/src/index.ts` — register `requestIdMiddleware()` as the first `app.use('*', …)` (before `cors()` at line 31); `onError` (line 482) and `notFound` (line 428) read `c.get('requestId')` instead of `crypto.randomUUID()`
- [ ] 2.3 `apps/gateway/src/router.ts` — the three error bodies (lines 201, 225, 244) use the context id; the `console.error` at line 238 gains the prefix
- [ ] 2.4 `apps/gateway/src/ingestor.ts` — error bodies (lines 70, 86, 105, 118) use the context id; the published envelope's `header.request_id` is overwritten with it
- [ ] 2.5 `apps/gateway/src/support.ts` — the request id at line 475 is read from the context (keep `deps.newId` only as the fallback the tests inject), so the support log and the body agree with the response header
- [ ] 2.6 `apps/gateway/src/index.test.ts`, `router.test.ts`, `error-log.test.ts` — generated id forwarded and echoed; well-formed client id kept; malformed replaced; `404`, `502` and `500` bodies equal the response header; the error log contains the same id

## Unit 3: Workers

- [ ] 3.1 `workers/{analytics,automation,communication,compliance,customer,growth,identity,wallet}/package.json` — depend on `@vyloop/request-context`
- [ ] 3.2 Each `workers/*/src/index.ts` — register `requestIdMiddleware()` first; `onError` logs `logPrefix(service, id)` with method, path and the error object, and answers `{ error: { code, message, request_id } }` (analytics :216, automation :59, communication :67, customer :66, growth :109, identity :1279, wallet :172)
- [ ] 3.3 `workers/compliance/src/index.ts` — add the missing `onError`
- [ ] 3.4 Each worker's `index.test.ts` (or a new one where missing) — a throwing route answers with the incoming id, logs it, and logs no `Authorization` value
- [ ] 3.5 A contract test in `packages/request-context` that reads each `workers/*/src/index.ts` and fails if one does not register the middleware or has no `onError`

## Unit 4: Events and documentation

- [ ] 4.1 `packages/event-bus/src/index.ts` — `request_id?: string` in `EventEnvelope['header']`; `createEnvelope` copies it; `consume` logs `request_id=<id> event=<id>` on failure; tests in `packages/event-bus`
- [ ] 4.2 `packages/schema-registry/src/index.ts` — `request_id` in `envelopeHeaderSchema` (line 184) with the pattern; tests: with, without, malformed
- [ ] 4.3 Producers that run inside a request pass `request_id: c.get('requestId')` in the header: `workers/growth/src/routes.ts`, `workers/customer/src/routes.ts`, `workers/communication/src/campaign-routes.ts`, and the request-path builders in `workers/*/src/helpers.ts`; cron producers (`workers/automation/src/cron-handler.ts`) are left without one
- [ ] 4.4 Queue handlers in `workers/{growth,communication,automation}/src/event-handler.ts` — error and warning lines use the prefix when `event.header.request_id` is present
- [ ] 4.5 `docs/18-Verificacion-y-Seguridad-Operativa.md` — how to trace a request: `wrangler tail <worker> --search <request id>` across the gateway and the worker; what is never logged
- [ ] 4.6 `docs/14-Backlog.md` — mark "El hueco de `request_id` en todos los workers" resolved

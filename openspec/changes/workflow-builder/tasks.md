# Tasks: Workflow Builder

> Status: deferred. Documented 2026-10-28; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Estimated changed lines | ~1,300 (additions + deletions)                                                        |
| 400-line budget risk    | High                                                                                  |
| Chained PRs recommended | Yes                                                                                   |
| Suggested split         | Unit 1 (schema) → Unit 2 (CRUD API) → Unit 3 (engine fixes) → Unit 4 (dashboard form) |
| Delivery strategy       | ask-on-risk                                                                           |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

High-risk items: (1) persisted format change on `workflows`; (2) new
business-scoped write routes. Units 1 and 2 each get their own commit and an
independent verification.

## 1. Schema

- [ ] 1.1 Migration adding `workflows.config jsonb` (nullable) and
      `workflows.updated_at` if missing; register it with the drift gate.
- [ ] 1.2 Drizzle schema and types in `packages/db`.

## 2. CRUD API (workers/automation)

- [ ] 2.1 `GET`, `POST`, `PATCH /{id}`, `DELETE /{id}` under
      `/v1/automation/workflows`, using `extractAuthHeaders` and `withRls`.
- [ ] 2.2 Validation as listed in the spec, including the approved-template
      check against `whatsapp_templates` of the same business.
- [ ] 2.3 Tests: each scenario in the automation-engine delta, plus a
      cross-business `404` for every id route.
- [ ] 2.4 Update `wrangler-route-reachability.contract.test.ts` and
      `docs/08-API-Design.md`; drop the `toggle` route the old page called.

## 3. Engine fixes (workers/automation)

- [ ] 3.1 Read `config.points` and `config.inactivity_days`, with the one-release
      fallback; bind the days as a parameter.
- [ ] 3.2 Milestone fires only when the balance crosses the threshold (needs the
      previous balance: `balanceAfter - points` from the `PointsAssigned`
      payload).
- [ ] 3.3 Parameter substitution from the fixed customer-field set.
- [ ] 3.4 Occasion in the cron idempotency keys.
- [ ] 3.5 Log every skipped unknown action type, on all five triggers.
- [ ] 3.6 Tests for `points_milestone` and `reward_redeemed`, which have none.

## 4. Dashboard (apps/dashboard)

- [ ] 4.1 `lib/api.ts` methods for the four routes.
- [ ] 4.2 Flujos list and guided form per the growth-dashboard delta; delete via
      `useConfirm`.
- [ ] 4.3 Remove `comingSoon` from the Flujos nav item and the coming-soon
      test, replacing it with the form's behaviour tests.

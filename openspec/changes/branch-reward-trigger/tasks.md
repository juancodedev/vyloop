# Tasks: Branch Reward Trigger

> Status: in progress. Decisions answered 2026-10-20 (Unit 0).

## Review Workload Forecast

| Field                   | Value                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Estimated changed lines | ~800 (additions + deletions)                                                       |
| 400-line budget risk    | High                                                                               |
| Chained PRs recommended | Yes                                                                                |
| Suggested split         | Unit 0 (decisions) → Unit 1 (storage) → Unit 2 (reward API + UI) → Unit 3 (event) → Unit 4 (producer + delivery) |
| Delivery strategy       | ask-on-risk                                                                        |

Decision needed before apply: No (Q1-Q6 answered 2026-10-20)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                         | Likely PR | Lines | Notes                                         |
| ---- | -------------------------------------------- | --------- | ----- | --------------------------------------------- |
| 0    | Product decisions recorded                   | —         | ~20   | Blocks everything else.                       |
| 1    | `reward_branches` table and migration        | PR #1     | ~150  | Applied in production before Unit 2.          |
| 2    | Reward API `branch_ids` and dashboard form   | PR #2     | ~250  | Needs Unit 1.                                 |
| 3    | Event constant and schema                    | PR #3     | ~120  | Parallel with Units 1 and 2.                  |
| 4    | Producer in auto-grant and delivery handler  | PR #4     | ~260  | Needs Units 1 and 3.                          |

## Unit 0: Decisions

- [x] 0.1 Answer Q1-Q6 in `proposal.md`; update the assumptions marked in `specs/growth-engine/spec.md` and `specs/push-notifications/spec.md` to the answers

## Unit 1: Storage

- [x] 1.1 `packages/db/src/schema.ts` — `rewardBranches` table (`reward_id`, `branch_id`, `business_id`, `created_at`), primary key `(reward_id, branch_id)`, index `idx_reward_branches_branch` on `(business_id, branch_id)`, all FKs `ON DELETE CASCADE`; export from `packages/db/src/index.ts`
- [x] 1.2 `packages/db/src/indexes.ts` — register the index
- [x] 1.3 `packages/db/src/rls.ts` — add `reward_branches` to `BUSINESS_ID_TABLES`; extend `packages/db/src/rls.test.ts`
- [x] 1.4 `packages/db/drizzle/00NN_reward_branches.sql` (next free number, reserved per `docs/18-Trabajo-Pendiente.md`) — generated and reviewed; header says it is applied by hand and inserts no rows
- [x] 1.5 `packages/db/drizzle/meta/_applied-outside-drizzle.json` — entry with evidence `table reward_branches`, `index idx_reward_branches_branch` and the two FK constraint names; `node scripts/check-migration-drift.mjs` passes

## Unit 2: Reward API and dashboard

- [ ] 2.1 `workers/growth/src/routes.ts` — `POST /v1/loyalty/rewards` (line 1151) and `PUT /v1/loyalty/rewards/:id` (line 1322) accept `branch_ids`; validate every id against `branches` of the business; replace the set on update; `422 VALIDATION_ERROR` before any write
- [ ] 2.2 `workers/growth/src/routes.ts` — `GET /v1/loyalty/rewards` (line 1229) and `GET /v1/loyalty/rewards/:id` (line 1293) return `branch_ids` (one grouped read, not one query per reward)
- [ ] 2.3 `workers/growth/src/routes.test.ts` — scoped create, foreign venue refused, update without the field keeps the scope, list returns `[]` for unscoped rewards
- [ ] 2.4 `apps/dashboard/src/lib/api.ts` and `apps/dashboard/src/app/dashboard/loyalty/rewards/page.tsx` — the `branch_ids` field and a venue multi-select ("Todos los locales" when empty)

## Unit 3: Event and schema

- [x] 3.1 `packages/event-bus/src/index.ts` — `REWARD_AVAILABLE_AT_BRANCH = 'RewardAvailableAtBranch'` with a comment naming its queue and consumer
- [x] 3.2 `packages/schema-registry/src/index.ts` — `rewardAvailableAtBranchSchema` v1.0.0 using `envelopeHeaderSchema`
- [x] 3.3 `packages/schema-registry/scripts/register-schemas.ts` — register it; `packages/schema-registry/scripts/register-schemas.test.ts` and `build-registry-payload.test.ts` — add it to the expected set and to the mocks
- [x] 3.4 Schema tests — valid payload passes; empty `branch_ids` fails; extra property fails

## Unit 4: Producer and delivery

- [x] 4.1 `workers/growth/src/event-handler.ts` — select `globalId` with the customer (line ~230); after the `reward_grants` insert (line ~330), read the reward's `reward_branches`; when non-empty, publish `RewardAvailableAtBranch` to `env.DELIVERY_QUEUE` (log and skip, as the check-in route does, when the binding is absent)
- [x] 4.2 `workers/growth/src/helpers.ts` — `buildRewardAvailableAtBranchEvent` next to `buildRewardAutoGrantedEvent`
- [x] 4.3 `workers/growth/src/event-handler.test.ts` (new; the worker has no handler test today) — scoped grant publishes once to the delivery queue; unscoped grant does not; an existing grant does not; `RewardAutoGranted` is still published
- [x] 4.4 `workers/communication/src/reward-notifications.ts` — `handleRewardAvailableAtBranch`: frequency cap read on `message_log`, Spanish title/body naming the reward and the venue name when scoped to exactly one venue or the venue count otherwise (Q5), then `deliverPushNotification` with `reference_id` `reward-grant:<grant_id>`
- [x] 4.5 `workers/communication/src/event-handler.ts` — dispatch `REWARD_AVAILABLE_AT_BRANCH`
- [x] 4.6 `workers/communication/src/reward-notifications.test.ts` and `event-handler.test.ts` — delivered with consent; not delivered without; redelivery sends once; frequency cap acks without sending; the body carries no balance
- [x] 4.7 `docs/19-Geolocalizacion-Notificaciones.md` — §7.4 marks `RewardAvailableAtBranch` as implemented, with the decisions from Unit 0

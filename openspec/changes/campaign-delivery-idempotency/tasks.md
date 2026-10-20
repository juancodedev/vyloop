# Tasks: Campaign Delivery Idempotency

> Status: deferred — post-PMV. Documented 2026-10-20; not scheduled.

## Review Workload Forecast

| Field                   | Value                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| Estimated changed lines | ~900 (additions + deletions)                                              |
| 400-line budget risk    | High                                                                      |
| Chained PRs recommended | Yes                                                                       |
| Suggested split         | Unit 1 (schema + migration) → Unit 2 (claimed delivery) → Unit 3 (campaign gate) → Unit 4 (dashboard + docs) |
| Delivery strategy       | ask-on-risk                                                               |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

High-risk items: (1) persisted format change and a production migration on
`message_log`; (4) concurrency. Units 1 and 2 each get their own commit and an
independent verification.

### Suggested Work Units

| Unit | Goal                                              | Likely PR | Lines | Notes                                                    |
| ---- | ------------------------------------------------- | --------- | ----- | -------------------------------------------------------- |
| 1    | Columns, index, `push_campaigns`, migration       | PR #1     | ~250  | Must land and be applied in production first.            |
| 2    | Claim-then-send delivery, lease, `Topic`, timeout | PR #2     | ~350  | Needs Unit 1 applied.                                    |
| 3    | Campaign reference gate on `push_campaigns`       | PR #3     | ~200  | Needs Unit 1 applied. Parallel with Unit 2.              |
| 4    | Dashboard semantics and documentation             | PR #4     | ~100  | Needs Unit 2.                                            |

## Unit 1: Schema and migration

- [ ] 1.1 `packages/db/src/schema.ts` — add `deliveryKey: text('delivery_key')` and `claimedUntil: timestamp('claimed_until', { withTimezone: true })` to `messageLog`, and the partial unique index `uq_message_log_delivery_key` on `(business_id, delivery_key) WHERE delivery_key IS NOT NULL` in its extra-config callback
- [ ] 1.2 `packages/db/src/schema.ts` — the `pushCampaigns` table (`id`, `business_id` FK to `tenants` with cascade, `reference_id`, `title`, `body`, `url`, `target jsonb`, `status text default 'requested'`, `created_at`) with `unique('uq_push_campaigns_business_reference')`; export it from `packages/db/src/index.ts`
- [ ] 1.3 `packages/db/src/indexes.ts` — register the new index the way the other derived indexes are registered
- [ ] 1.4 `packages/db/src/rls.ts` — add `push_campaigns` to `BUSINESS_ID_TABLES`; extend `packages/db/src/rls.test.ts`
- [ ] 1.5 `packages/db/drizzle/00NN_delivery_idempotency.sql` (next free number) — generated, then edited by hand: `ADD COLUMN` statements, `CREATE TABLE push_campaigns`, and `CREATE UNIQUE INDEX CONCURRENTLY "uq_message_log_delivery_key"` as its own statement outside a transaction; header comment states it is applied by hand and why the index is concurrent
- [ ] 1.6 `packages/db/drizzle/meta/_applied-outside-drizzle.json` — the entry with `tag`, `when`, `hash` and evidence: `column message_log.delivery_key`, `column message_log.claimed_until`, `table push_campaigns`, `index uq_message_log_delivery_key`, `constraint uq_push_campaigns_business_reference`; `node scripts/check-migration-drift.mjs` passes locally against a database where the SQL was applied
- [ ] 1.7 `packages/db/src/migration-sql.test.ts` — the migration file declares the index concurrently and does not rewrite existing rows

## Unit 2: Claimed delivery

- [ ] 2.1 `workers/communication/src/push-delivery.ts` — `claimDelivery(db, { businessId, customerId, deliveryKey, … })`: `INSERT … ON CONFLICT (business_id, delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING RETURNING id`, then the reclaim `UPDATE … WHERE status = 'queued' AND (claimed_until IS NULL OR claimed_until < now()) RETURNING id` incrementing `metadata.attempts`; returns the row id or `null`
- [ ] 2.2 `workers/communication/src/push-delivery.ts` — replace the read at lines 216-230 and the insert at 234-250 with `claimDelivery` when `payload.reference_id` is present; keep the unreferenced path inserting a row with `delivery_key = NULL`; keep writing `content.reference_id`
- [ ] 2.3 `workers/communication/src/push-delivery.ts` — release the lease (`claimed_until = NULL`, status stays `queued`) before the `429` throw and in the `catch` around encryption/send; clear it on `sent` and `failed`
- [ ] 2.4 `workers/communication/src/push-delivery.ts` — `DELIVERY_LEASE_MS` (proposed 60 000) and `PUSH_REQUEST_TIMEOUT_MS` (proposed 15 000); `attemptDelivery` passes `signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS)`
- [ ] 2.5 `workers/communication/src/push-delivery.ts` — `Topic` header: base64url of the first 24 bytes of SHA-256(delivery key), 32 characters
- [ ] 2.6 `workers/communication/src/push-delivery.test.ts` — two concurrent deliveries of one key send once; a decided row is skipped; `429` then `201` leaves one row with `attempts = 2`; an expired lease is reclaimed; a fresh lease is skipped without throwing; unreferenced messages are not deduplicated; the timeout is shorter than the lease; the `Topic` is stable and ≤ 32 characters
- [ ] 2.7 `workers/communication/src/push-campaigns.test.ts` — a campaign redelivered after a `429` on its tenth subscriber does not resend to the first nine and does not add rows for them

## Unit 3: Campaign reference gate

- [ ] 3.1 `workers/communication/src/campaign-routes.ts` — insert into `push_campaigns` with `ON CONFLICT DO NOTHING RETURNING id` before publishing; no row → `409 DUPLICATE_MESSAGE` (same code and message as today)
- [ ] 3.2 `workers/communication/src/campaign-routes.ts` — on a publish failure, delete the row and rethrow
- [ ] 3.3 `workers/communication/src/campaign-routes.ts` — keep the `starts_with` probe (lines 263-285) as a secondary check, with a comment naming the follow-up that removes it
- [ ] 3.4 `workers/communication/src/campaign-routes.test.ts` — concurrent POSTs with one reference: one `202`, one `409`, one publish; same reference in another business accepted; publish failure leaves no row; a legacy reference found only in `message_log` is refused

## Unit 4: Dashboard and documentation

- [ ] 4.1 `workers/communication/src/delivery-stats.ts` — doc comment on `STATUS_QUEUED` and the counts: one row per referenced delivery; a `queued` row older than the lease plus the retry horizon is an exhausted delivery
- [ ] 4.2 `workers/communication/src/delivery-stats.test.ts` — a delivery retried twice and then sent counts once as `sent`
- [ ] 4.3 `docs/19-Geolocalizacion-Notificaciones.md` — the delivery guarantee (at-most-once per browser per reference, except a crash between send and record) and the `Topic` mitigation
- [ ] 4.4 `docs/14-Backlog.md` — record the change as done and the follow-ups it leaves: dead-letter queue plus a sweep that marks exhausted deliveries `failed`, and removal of the legacy prefix probe

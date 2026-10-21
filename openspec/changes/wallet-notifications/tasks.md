# Tasks: Wallet Notifications

> Status: proposed. Decisions pending (Unit 0).

## Review Workload Forecast

| Field                   | Value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Estimated changed lines | ~1,100 (additions + deletions)                                |
| 400-line budget risk    | High                                                          |
| Chained PRs recommended | Yes                                                           |
| Suggested split         | Unit 0 → Unit 1 → Unit 2 → Unit 3 → Unit 4                    |
| Delivery strategy       | ask-on-risk                                                   |

Decision needed before apply: Yes (Q1–Q5)
Chained PRs recommended: Yes
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                                  | Likely PR | Lines | Notes                                  |
| ---- | ----------------------------------------------------- | --------- | ----- | -------------------------------------- |
| 0    | Product decisions recorded                            | —         | ~20   | Blocks everything else.                |
| 1    | `merchantLocations` on consenting objects + sync      | PR #1     | ~300  | Needs only Unit 0.                     |
| 2    | Message storage, budget ledger, consent type          | PR #2     | ~250  | Migration applied before Unit 3.       |
| 3    | `POST/GET /v1/wallet/messages` + queue delivery       | PR #3     | ~300  | Needs Unit 2.                          |
| 4    | Dashboard Wallet section + venue status               | PR #4     | ~250  | Needs Unit 3 (and Unit 1 for status).  |

## Unit 0: Decisions

- [ ] 0.1 Q1 — With more than 10 located venues, which 10 go on a pass? Assumed: the customer's most recently visited, completed by the most recently located.
- [ ] 0.2 Q2 — Which consent allows manual wallet messages? Assumed: a new `wallet_messages` type in `CONSENT_TYPES`, off by default (`docs/10` §11). Alternative: reuse `nearby_notifications`.
- [ ] 0.3 Q3 — Daily limit per business. Assumed: 1 message per business per day.
- [ ] 0.4 Q4 — `header`/`body` lengths. Assumed: 40 / 300 characters.
- [ ] 0.5 Q5 — Which hosts may `link` point to? Assumed: the program page plus hosts the business registers in settings.

## Unit 1: Venue Locations

- [ ] 1.1 Add `merchantLocations` to `LoyaltyObject` / `LoyaltyObjectPatch` in `google-client.ts`; keep the class builder free of it (`class.test.ts` whitelist stays as is).
- [ ] 1.2 Pure selector: venues → at most 10 `MerchantLocation`, filtered by active and located (Q1 order).
- [ ] 1.3 Build objects with locations only for consenting customers (`object.ts`, `issuance.ts`).
- [ ] 1.4 Sync on consent grant/withdraw and on venue register/update/deactivate; no `notifyPreference`.
- [ ] 1.5 Tests per scenario in `specs/google-wallet` "Venue Locations on the Pass" and "Keep Locations in Step".

## Unit 2: Storage

- [ ] 2.1 Migration: `wallet_messages` (id, business_id, header, body, link, created_by, created_at) and `wallet_message_deliveries` (message_id, object_id, mode `notify|text`, status, delivered_at), PK `(message_id, object_id)`; both in `BUSINESS_ID_TABLES`.
- [ ] 2.2 Add the consent type decided in Q2 to `CONSENT_TYPES` and the customer-web consent list.
- [ ] 2.3 Budget query: notifying deliveries per object in the last 24h.

## Unit 3: API and Delivery

- [ ] 3.1 `addObjectMessage` on the Google client (loyalty object `addmessage`).
- [ ] 3.2 `POST /v1/wallet/messages`: operator gate, validation, link allowlist, daily limit, `202` with `eligible`.
- [ ] 3.3 Queue fan-out, one idempotent job per object; budget decides `TEXT_AND_NOTIFY` vs `TEXT`; `QuotaExceededException` → `TEXT`, no retry.
- [ ] 3.4 `GET /v1/wallet/messages` with counts, tenant-scoped.
- [ ] 3.5 Gateway route, `docs/08` entry.

## Unit 4: Dashboard

- [ ] 4.1 `dashboard/communication/wallet` page: form, preview, eligible count, budget notice, error codes.
- [ ] 4.2 History list with counts.
- [ ] 4.3 Venues view: nearby-notification status per venue.
- [ ] 4.4 `docs/19` records the Google Wallet channel.

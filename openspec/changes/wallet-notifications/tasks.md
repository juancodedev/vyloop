# Tasks: Wallet Notifications

> Status: proposed. Q1-Q6 decided 2026-10-21.

## Review Workload Forecast

| Field                   | Value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| Estimated changed lines | ~1,400 (additions + deletions)                                |
| 400-line budget risk    | High                                                          |
| Chained PRs recommended | Yes                                                           |
| Suggested split         | Unit 0 → Unit 1 → Unit 2 → Unit 3 → Unit 4 → Unit 5           |
| Delivery strategy       | ask-on-risk                                                   |

Decision needed before apply: Yes (Q1–Q6)
Chained PRs recommended: Yes
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                                  | Likely PR | Lines | Notes                                       |
| ---- | ----------------------------------------------------- | --------- | ----- | ------------------------------------------- |
| 0    | Product decisions recorded                            | —         | ~20   | Blocks everything else.                     |
| 1    | Dashboard Venues section with map pin                 | PR #1     | ~300  | Step 1. Existing routes; no backend change. |
| 2    | `merchantLocations` on consenting objects + sync      | PR #2     | ~300  | Needs located venues (Unit 1).              |
| 3    | Message storage, budget ledger, consent type          | PR #3     | ~250  | Migration applied before Unit 4.            |
| 4    | `POST/GET /v1/wallet/messages` + queue delivery       | PR #4     | ~300  | Needs Unit 3.                               |
| 5    | Dashboard Wallet section + nearby status per venue    | PR #5     | ~250  | Needs Units 2 and 4.                        |

## Unit 0: Decisions

- [x] 0.1 Q1 — Which 10 of more than 10 located venues go on a pass? **Decided: the 10 active venues with coordinates, most recently updated.** No per-customer order: Google evaluates proximity on the device, so past visits say nothing about where the holder is, and the order would cost a join per customer on every object build.
- [x] 0.2 Q2 — Which consent allows manual wallet messages? **Decided: a new `promotions` type in `CONSENT_TYPES`, off by default.** `promotions` is the purpose `docs/10` §15 already names for offers, and it forbids grouping promotions with nearby notifications. Not `wallet_messages`: the purpose is the promotion, the channel is not part of it. Separately: `push-campaigns.ts` requires `nearby_notifications` for marketing campaigns, which contradicts §15; out of scope here.
- [x] 0.3 Q3 — Daily limit per business. **Decided: 1 per business per day, as a constant in code, not a column.** A constant is reviewable in a PR; a column is a setting that changes without one.
- [x] 0.4 Q4 — `header`/`body` lengths. **Decided: 40 / 300 as product limits**, declared once in `WALLET_MESSAGE_LIMITS` in `@vyloop/types` so the form and the route cannot disagree. `POST` refuses with `WALLET_MESSAGE_TOO_LONG` before anything is queued. Google documents no message-length cap, so a provider 400 for length is recorded `rejected` per object, never retried, and the fan-out continues. Unit 3 measures the real behaviour with one over-long message to a test issuer.
- [x] 0.5 Q5 — Which hosts may `link` point to? **Decided: only the origin of `WALLET_CUSTOMER_WEB_BASE_URL`.** An operator-typed host is the exact vector Google's Acceptable Use Policy forbids, and a typo is indistinguishable from abuse. A business domain is added later with ownership verification.
- [x] 0.6 Q6 — Map for the venue form. **Decided: no map in v1.** Two numeric fields plus a "use my location" button. The operator registers a venue while standing in it, so the browser's position is better data than a dragged pin, and a map would force a tile-provider decision for one pair of numbers. Address search stays deferred. If a map is ever wanted, Leaflet with a configurable tile URL.

## Unit 1: Venues Section (step 1)

- [ ] 1.1 API client in `apps/dashboard/src/lib/api.ts`: create, update and deactivate venues; extend the venue record with `latitude`, `longitude` and `isActive`.
- [ ] 1.2 `dashboard/settings/venues` page: list with located / not located and active / inactive.
- [ ] 1.3 Venue form with two coordinate fields and a "use my location" button (Q6 = no map); sends both coordinates or neither.
- [ ] 1.4 Readable messages for `BRANCH_LOCATION_INCOMPLETE`, `BRANCH_LOCATION_INVALID`, `BRANCH_LOCATION_OUT_OF_RANGE`.
- [ ] 1.5 Tests per scenario in `specs/growth-dashboard` "Venue Management".

## Unit 2: Venue Locations on the Pass

- [ ] 2.1 Add `merchantLocations` to `LoyaltyObject` / `LoyaltyObjectPatch` in `google-client.ts`; keep the class builder free of it (`class.test.ts` whitelist stays as is).
- [ ] 2.2 Pure selector: venues → at most 10 `MerchantLocation`, filtered by active and located (Q1 order).
- [ ] 2.3 Build objects with locations only for consenting customers (`object.ts`, `issuance.ts`).
- [ ] 2.4 Sync on consent grant/withdraw and on venue register/update/deactivate; no `notifyPreference`.
- [ ] 2.5 Tests per scenario in `specs/google-wallet` "Venue Locations on the Pass" and "Keep Locations in Step".

## Unit 3: Storage

- [ ] 3.1 Migration: `wallet_messages` (id, business_id, header, body, link, created_by, created_at) and `wallet_message_deliveries` (message_id, object_id, mode `notify|text`, status, delivered_at), PK `(message_id, object_id)`; both in `BUSINESS_ID_TABLES`.
- [ ] 3.2 Add the consent type decided in Q2 to `CONSENT_TYPES` and the customer-web consent list.
- [ ] 3.3 Budget query: notifying deliveries per object in the last 24h.

## Unit 4: API and Delivery

- [ ] 4.1 `addObjectMessage` on the Google client (loyalty object `addmessage`).
- [ ] 4.2 `POST /v1/wallet/messages`: operator gate, validation, link allowlist, daily limit, `202` with `eligible`.
- [ ] 4.3 Queue fan-out, one idempotent job per object; budget decides `TEXT_AND_NOTIFY` vs `TEXT`; `QuotaExceededException` → `TEXT`, no retry.
- [ ] 4.4 `GET /v1/wallet/messages` with counts, tenant-scoped.
- [ ] 4.5 Gateway route, `docs/08` entry.

## Unit 5: Wallet Section

- [ ] 5.1 `dashboard/communication/wallet` page: form, preview, eligible count, budget notice, error codes.
- [ ] 5.2 History list with counts.
- [ ] 5.3 Venues section: nearby-notification status per venue.
- [ ] 5.4 `docs/19` records the Google Wallet channel.

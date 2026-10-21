# Tasks: Wallet Notifications

> Status: proposed. Decisions pending (Unit 0).

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

- [ ] 0.1 Q1 — With more than 10 located venues, which 10 go on a pass? Assumed: the customer's most recently visited, completed by the most recently located.
- [ ] 0.2 Q2 — Which consent allows manual wallet messages? Assumed: a new `wallet_messages` type in `CONSENT_TYPES`, off by default (`docs/10` §11). Alternative: reuse `nearby_notifications`.
- [ ] 0.3 Q3 — Daily limit per business. Assumed: 1 message per business per day.
- [ ] 0.4 Q4 — `header`/`body` lengths. Assumed: 40 / 300 characters.
- [ ] 0.5 Q5 — Which hosts may `link` point to? Assumed: the program page plus hosts the business registers in settings.
- [ ] 0.6 Q6 — Map and geocoding provider for the venue form. Assumed: an open map tile source for the pin, address search deferred until a geocoding provider is chosen.

## Unit 1: Venues Section (step 1)

- [ ] 1.1 API client in `apps/dashboard/src/lib/api.ts`: create, update and deactivate venues; extend the venue record with `latitude`, `longitude` and `isActive`.
- [ ] 1.2 `dashboard/settings/venues` page: list with located / not located and active / inactive.
- [ ] 1.3 Venue form with map pin (Q6); sends both coordinates or neither.
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

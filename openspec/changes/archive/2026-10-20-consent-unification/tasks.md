# Tasks: Consent Unification

## Review Workload Forecast

| Field                   | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| Estimated changed lines | ~520 (additions + deletions)                                    |
| 400-line budget risk    | High                                                            |
| Chained PRs recommended | Yes                                                             |
| Suggested split         | Unit 1 (storage) → Unit 2 (writer) → Unit 3 (gates), sequential |
| Delivery strategy       | ask-on-risk                                                     |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                         | Likely PR | Lines | Notes                                                                    |
| ---- | -------------------------------------------- | --------- | ----- | ------------------------------------------------------------------------ |
| 1    | Storage (vocabulary, helpers, constraint)    | PR #1     | ~180  | Must land first: everything else imports the vocabulary and the helpers. |
| 2    | Write path (registration persists consents)  | PR #2     | ~150  | Needs Unit 1 merged.                                                     |
| 3    | Read path (communication + automation gates) | PR #3     | ~190  | Needs Unit 1 merged. Parallel with Unit 2.                               |

Units 2 and 3 touch disjoint files and can be reviewed in any order once Unit 1 is merged.

## Unit 1: Storage

- [x] 1.1 `packages/types/src/index.ts` — Add `CONSENT_TYPES` (`whatsapp`, `nearby_notifications`), the `ConsentType` type, and `isConsentType()`
- [x] 1.2 `packages/db/src/consents.ts` — Add `readConsentMap(db, { businessId, customerId })` returning a map of type → granted, and `upsertConsent(db, { businessId, customerId, consentType, granted, ipAddress })` that writes `granted_at` on grant and `revoked_at` on revocation
- [x] 1.3 `packages/db/src/schema.ts` — Add the unique index on `consents` in the table's extra-config callback
- [x] 1.4 `packages/db/src/indexes.ts` — Register `branches`-style: add `consents` to `INDEXED_TABLES` and the named index export
- [x] 1.5 `packages/db/src/consents.test.ts` — Grant twice keeps the original `granted_at`; revoke sets `revoked_at` and keeps the row; a second row for the same triple is rejected; a consent of another tenant is invisible
- [x] 1.6 `packages/db/drizzle/` — Generate migration `0015`, review it, and register it in `_applied-outside-drizzle.json` with the evidence the drift gate derives

## Unit 2: Write Path

- [x] 2.1 `workers/customer/src/routes.ts` — `PUT /v1/customers` accepts `consents`, validates every key against the vocabulary, and persists the ones present
- [x] 2.2 `workers/customer/src/routes.ts` — An unknown consent type is a `422`, not a silent skip
- [x] 2.3 `workers/customer/src/index.test.ts` — Consents are recorded on registration; an absent consent is left alone; a revocation is recorded; an unknown type is rejected

## Unit 3: Read Path

- [x] 3.1 `workers/communication/src/routes.ts` — The send gate reads the `consents` table instead of `customer.metadata.consent`
- [x] 3.2 `workers/communication/src/routes.test.ts` — A granted consent allows the send; a revoked one is refused; a customer with no row is refused
- [x] 3.3 `workers/automation/src/event-handler.ts` — The implicit consent filter reads the table
- [x] 3.4 `workers/automation/src/cron-handler.ts` — Same for the birthday and inactivity crons
- [x] 3.5 `workers/automation/src/helpers.ts` — The condition-evaluation context exposes `consent.<type>` assembled from the table
- [x] 3.6 `workers/automation/src/index.test.ts` — The filter refuses a revoked consent; a `consent.whatsapp` condition matches a granted consent

## Unit 4: Specifications

- [x] 4.1 `openspec/specs/database/spec.md` — Apply the delta: one row per consent, and the audit trail
- [x] 4.2 `openspec/specs/customer-crud/spec.md` — Apply the delta: registration accepts and persists consents
- [x] 4.3 `openspec/specs/communication-whatsapp/spec.md` — Apply the delta: the gate reads the table, and a revoked consent is not a granted one
- [x] 4.4 `openspec/specs/automation-engine/spec.md` — Apply the delta: the filter and the context read the table
- [x] 4.5 `openspec/specs/communication-whatsapp/spec.md` — Correct the error-shape table, which contradicts `api-gateway` and the code
- [x] 4.6 `openspec/config.yaml` — Replace the `testing` block, which still describes a project with no test runner
- [x] 4.7 `openspec/specs/api-gateway/spec.md` — Correct the routing requirement: `/v1/identity/*` does not exist and seven real prefixes are missing
- [x] 4.8 `openspec/specs/database/spec.md` — Correct the table count and the index list

## Status

Every unit is done. The spec deltas are applied to the living specs, and the
change is archived with the rest of the completed ones.

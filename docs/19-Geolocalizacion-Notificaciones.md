# 19 — Venue Geolocation and Push Notifications

> **Status:** Phase **F1** is implemented and open as [PR #221](https://github.com/juancodedev/vyloop/pull/221). Phases F2–F4 are not started.
> **Scope:** Let venues (_locales_) register their geographic position, and let notifications — including push — be driven by that position.
> **Baseline:** `8ef0af7` (working tree clean at the time of writing).

## What F1 changed

- `branches` gained `latitude`, `longitude`, `geohash`, `geohash_precision` and `located_at`, with two check constraints, in migration `0014`.
- `workers/identity` replaced the venues stub with four authenticated, tenant-scoped routes: list, register, update and deactivate.
- The subject-kind predicates (`isCustomerRole`, `isCounterSubject`, `requireOperatorRole`) moved to `@vyloop/types`, so the growth, gateway and identity workers answer "is this an operator?" from one definition.

Migration `0014` has **not** been applied to production by hand. The drift gate reports it as pending until someone applies it, which is the gate doing its job.

---

## 1. Purpose

Two capabilities, in this order:

1. **Venue geolocation.** A business registers the coordinates of each of its branches. The system stores them, indexes them, and exposes them.
2. **Push notifications driven by that position.** Customers receive timely messages tied to a place — "your branch is nearby", "points expire", "a reward is waiting at this location".

These are separate deliverables. Phase 1 (venue geolocation) is independently useful and independently shippable. Phase 2 (push) depends on Phase 1 only for the _proximity_ trigger family; the other trigger families do not need coordinates at all.

**The user-facing promise this document deliberately does not make:** "I walk into the mall and the notification arrives by itself." See §3 — that promise requires a native application and is out of scope for the web stack in this repository.

---

## 2. Current state (verified)

Everything below was read in the repository at `8ef0af7`.

| Area                 | Finding                                                                                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geolocation          | **None.** No `latitude`, `longitude`, `geohash`, or coordinates anywhere in `apps/`, `packages/`, `workers/`, `services/`, `api/`.                                                                                                                                                 |
| Push                 | **None.** No VAPID keys, no `push_subscriptions` table, no service worker, no push library in any `package.json`.                                                                                                                                                                  |
| Venue model          | `packages/db/src/schema.ts:81-91` — `branches` has `id`, `businessId`, `name`, `address`, `city`, `country`, `timezone`, `isActive`, `createdAt`. No coordinates, **no `updatedAt`**.                                                                                              |
| Venue routes         | `workers/identity/src/index.ts:880-890` — `GET /v1/businesses/:id/branches` is a **PMV stub** returning `{ branches: [], total: 0, business_id }`. No venue CRUD exists. `workers/identity/src/index.test.ts:294-303` tests the stub.                                              |
| Consent              | `packages/db/src/schema.ts:209+` — `consents` with `businessId`, `customerId`, `consentType`, `granted`, `grantedAt`, `revokedAt`, `ipAddress`. Channel-agnostic, reusable.                                                                                                        |
| Messaging            | `packages/db/src/schema.ts:644` — `messageLog`, `channel` defaults to `'whatsapp'`.                                                                                                                                                                                                |
| Event bus            | `packages/event-bus/src/index.ts` — 7 event constants, `EventEnvelope` with `header.business_id` and `header.localization`, `publish` / `publishBatch` / `consume` / `createEnvelope`.                                                                                             |
| Communication worker | `workers/communication/wrangler.jsonc` — KV `SCHEMA_REGISTRY`, **producer** for `vyloop-domain-events`. **No consumer, no cron.**                                                                                                                                                  |
| Event handler        | `workers/communication/src/event-handler.ts` — handles exactly one event: `WhatsAppOutboundRequested`.                                                                                                                                                                             |
| Send route           | `workers/communication/src/routes.ts:28` — `POST /v1/communication/send`, RLS-scoped, WhatsApp consent check, idempotency via `reference_id`, inserts `message_log` (`status='queued'`), publishes `WhatsAppOutboundRequested`.                                                    |
| Customer app         | `apps/customer-web` — Next.js 16, App Router. Routes: `home`, `register`, `confirm`, `profile`, `profile/rewards`, `profile/history`. Has `app/components/consent-list.tsx`. `public/` holds only `brand/*.jpg`, `program.html` and the service worker/manifest — **no web manifest, no service worker**. |
| Migrations           | `packages/db/drizzle/` at `0013_sour_apocalypse`; next is `0014`. Manual migrations must be registered in `packages/db/drizzle/meta/_applied-outside-drizzle.json`.                                                                                                                |
| Index registry       | `packages/db/src/indexes.ts` — `INDEXED_TABLES` does **not** include `branches`. Index builders live in each table's extra-config callback in `schema.ts`; `indexes.ts` is a derived _read_ of those configs.                                                                      |
| API contract         | `api/docs/openapi.yaml` — OpenAPI 3.1.0, exactly 3 documented endpoints. The documented surface is derived **only** from `requireCounterSubject(` / `counterSubject(` guards; operator-role routes are excluded by design.                                                         |
| Reachability guard   | `apps/gateway/src/wrangler-route-reachability.contract.test.ts` exists because a route can be registered, green in tests, and still unreachable (7 historical instances).                                                                                                          |

### The recurring defect class this plan must design around

Seven times in this codebase a route was registered and passing tests yet was **unreachable in production** because an earlier layer rejected it — auth middleware, router mount, or wrangler route binding. Every route proposed in §7 therefore carries an explicit reachability gate, and §8 states the ordering that keeps it honest.

---

## 3. The hard constraint: web push cannot geofence in the background

This is the single most important technical fact in this document, and it is the one most likely to be designed around by mistake.

**A Progressive Web App has no reliable background location.** The browser grants location only while the page is open and the user has granted permission. When the tab is closed or the app is backgrounded, the PWA is suspended — it does not run, it does not poll, and it cannot evaluate "is the customer near branch X?".

**Safari on iOS is stricter still.** It has never supported Web Push for home-screen web apps. Web Push on iOS 16.4+ requires the user to install the site to the home screen **and** add it to the _Added to Home Screen_ list, and the app must be launched from that icon at least once. A user who has never installed the PWA cannot receive push at all.

**Consequence.** The set of triggers that can actually work on this stack is:

| Trigger family                                                     | Works on web/PWA? | Notes                                                                                               |
| ------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------- |
| Server-side campaign for a specific venue                          | ✅ Yes            | Coordinates resolved server-side; no client location needed.                                        |
| Customer explicitly opts in _while on site_                        | ✅ Yes            | Foreground permission prompt; the venue is known at that moment.                                    |
| Check-in / POS event at a branch                                   | ✅ Yes            | `customer_events.branch_id` already exists. The venue is known from the event, not from the device. |
| Passive "you are near branch X" while the app is open              | ⚠️ Partial        | Requires foreground permission and an active session. Opt-in only.                                  |
| Passive "you just entered the mall, notify me" with the app closed | ❌ No             | Requires a native app with background geofencing.                                                   |

The honest product statement is: **push notifications are driven by the venue's position and by customer actions at a venue, not by the device silently watching the customer walk around.** The first row and the third row cover the overwhelming majority of real business value (a chain promoting a branch, "check in and earn") and both work today on the web stack.

If background geofencing is a hard product requirement, that is a separate native-app project, not a phase of this one.

---

## 4. Decisions

| ID      | Decision                                                                                                                                                                                                                                             | Rationale                                                                                                                                                                                                                                                             | Rejected alternative                                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | Store coordinates **only for venues** (`branches`). Never store a customer's device coordinates.                                                                                                                                                     | Venue location is business data the business already owns. Storing customer device location creates a tracking surface with legal and trust cost, and buys nothing that §3 shows is needed.                                                                           | Storing a coarse customer geohash (precision 5, ≈4.9 km) with opt-in and deletion on revoke. Rejected: it enables a proximity use case that background web push cannot deliver anyway, so it would pay a large privacy cost for no reachable feature. |
| **D2**  | Add `latitude`, `longitude`, `geohash`, `geohash_precision`, `located_at` to `branches`. Use `located_at` rather than `updatedAt` because `branches` has no `updatedAt` column and adding one changes the semantics of every future row.             | Explicit "when was this location asserted" beats inferring it from a row timestamp.                                                                                                                                                                                   | Adding `updatedAt` to `branches` to mirror `tenants`. Rejected: it implies a row-level lifecycle the table does not have.                                                                                                                             |
| **D3**  | Use **Web Push** with VAPID as the transport. No third-party push broker.                                                                                                                                                                            | It is the only push transport that works in a Cloudflare Worker with no external dependency, no per-message fee, and no vendor lock-in. The endpoint + keys model maps directly to a Postgres row.                                                                    | FCM/APNs directly — requires a server SDK per platform and native entitlements; not available from a Worker. A broker (OneSignal, Braze) — adds cost, data egress, and a vendor contract for a capability the platform provides natively.             |
| **D4**  | Push subscriptions are stored **per endpoint**, keyed unique on `endpoint`. A customer may hold several (phone + laptop); a device may hold several (multiple tenants in one browser).                                                               | The `endpoint` URL is the browser's stable identity for that subscription. Keying on it makes re-registration idempotent and makes "this device unsubscribed" a single row delete.                                                                                    | One subscription per customer — breaks multi-device, which is the normal case.                                                                                                                                                                        |
| **D5**  | Reuse the existing `consents` table with `consent_type = 'push'`. Do not create a parallel consent model.                                                                                                                                            | `consents` already has `granted`, `grantedAt`, `revokedAt`, `ipAddress` — exactly the lifecycle a push opt-in needs, and it is already the object the WhatsApp send path checks. A second model would mean two consent systems that can disagree.                     | A `push_consents` table — duplicates an existing, tested consent concept.                                                                                                                                                                             |
| **D6**  | Venue CRUD lives in the **identity worker** (it already owns `/v1/businesses/:id/branches`). Push subscription and dispatch live in the **communication worker** (it already owns messaging and `message_log`).                                      | Ownership follows existing boundaries. The identity worker owns venues; the communication worker owns channels. No new worker is created.                                                                                                                             | A new `workers/location` — a new deploy target, new auth surface, and a duplicate of the venue route that identity already stubs.                                                                                                                     |
| **D7**  | Push delivery is **server-side and address-based**. The VAPID subscriber key is registered server-side at subscription time; the payload is an encrypted payload encrypted to that subscriber key. The browser's own push service performs delivery. | The worker cannot read the subscriber's mailboxes; the push service does. The worker only needs to encrypt per-subscription.                                                                                                                                          | The `no-crypto` push-via-`DataView` browser trick — deprecated and Chrome-only.                                                                                                                                                                       |
| **D8**  | Manual migration `0014`, registered in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `kind`/`name` evidence entries.                                                                                                                 | `drizzle-kit migrate` is forbidden in this repository (ledger drift). `packages/db/src/migration-sql.test.ts` fails on an unregistered `.sql`. The registry entry is what makes the manual migration survive the drift gate.                                          | `drizzle-kit generate` + `migrate` — explicitly forbidden; it desynchronizes the ledger.                                                                                                                                                              |
| **D9**  | `branches` geohash index is declared in the `branches` table callback in `schema.ts` **and** `branches` is added to `INDEXED_TABLES` in `packages/db/src/indexes.ts` with a named export.                                                            | `indexes.ts` is a derived read of table configs, not a declaration site. An index in the callback that is not in `INDEXED_TABLES` is silently absent from the registry; a table in `INDEXED_TABLES` without a callback index throws loudly. Both halves are required. | Manual `CREATE INDEX` only — it would drift from the schema and the registry would not know about it.                                                                                                                                                 |
| **D10** | The push dispatch trigger is an **event**, not a cron sweep over all subscriptions.                                                                                                                                                                  | The trigger families that work (§3) all originate as a domain event: a campaign targeting a venue, a check-in, a POS sale. Sweeping every subscription on a timer is expensive and would send notifications the customer never asked for at that moment.              | A cron that geofences every subscription — requires client location, which D1 forbids and §3 shows the platform cannot deliver.                                                                                                                       |

---

## 5. Data model

### 5.1 `branches` — venue position

```sql
ALTER TABLE branches
  ADD COLUMN latitude           numeric(9,6),
  ADD COLUMN longitude          numeric(9,6),
  ADD COLUMN geohash            text,
  ADD COLUMN geohash_precision  smallint,
  ADD COLUMN located_at         timestamptz;
```

- `numeric(9,6)` — ±180° needs 3 integer digits and 6 decimals gives ≈0.11 m. `double precision` would carry binary rounding noise into a value a human reads off a map.
- `geohash` — denormalised server-computed cache of the position, for prefix queries ("all branches inside this cell").
- `geohash_precision` — stored because the usable radius depends on the precision that was used, and a geohash string alone does not say which.
- `located_at` — when the venue asserted this position. `NULL` means "no position registered", which is a distinct and meaningful state from "position is 0,0".

Constraint (migration `0014`, same file):

```sql
ALTER TABLE branches
  ADD CONSTRAINT branches_coordinates_pair_chk
  CHECK ((latitude IS NULL AND longitude IS NULL) OR
         (latitude IS NOT NULL AND longitude IS NOT NULL));

ALTER TABLE branches
  ADD CONSTRAINT branches_coordinates_range_chk
  CHECK (latitude  BETWEEN -90  AND 90  AND
         longitude BETWEEN -180 AND 180);
```

Half-a-coordinate is never a real venue. The pair constraint makes it unrepresentable instead of recoverable.

### 5.2 Geohash precision choice

| Precision | Cell             | Typical use                                                                                                                                        |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6         | ~1.2 km × 0.6 km | **Default for venue search** — good enough for "branches near this point", coarse enough that a geohash is not a precise tracker of a small venue. |
| 7         | ~150 m × 150 m   | Only if a branch legitimately serves a 150 m radius (a mall kiosk).                                                                                |

Precision 6 is the default. Storing precision 7 is allowed but the business must opt in, because a precise venue geohash combined with customer-side data is more identifying.

### 5.3 `push_subscriptions`

```sql
CREATE TABLE push_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  endpoint       text NOT NULL,
  p256dh         text NOT NULL,
  auth           text NOT NULL,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  CONSTRAINT push_subscriptions_endpoint_uq UNIQUE (endpoint)
);

CREATE INDEX idx_push_subscriptions_business ON push_subscriptions (business_id);
CREATE INDEX idx_push_subscriptions_customer ON push_subscriptions (customer_id);
```

Notes:

- `business_id` is denormalised alongside `customer_id` so a tenant-scoped query never needs a join to prove ownership — the RLS predicate in the communication worker filters directly on it.
- `endpoint` is a long URL; `text` is correct, `varchar` would truncate.
- `p256dh` and `auth` are the browser's public key and auth secret. `auth` is a per-subscription secret used to sign payloads. **It is not a user credential** — it cannot authenticate anything on its own — but it is still subscription-scoped key material and must never appear in logs or `message_log` payloads.
- `UNIQUE (endpoint)` is what makes re-registration idempotent: the browser can rotate `p256dh`/`auth` for the same endpoint, and `ON CONFLICT (endpoint) DO UPDATE` handles it.

### 5.4 `message_log` extension

`message_log.channel` currently defaults to `'whatsapp'` and is free text. Push is added as a channel value:

```sql
ALTER TABLE message_log
  ADD COLUMN push_endpoint_hash text;
```

A **hash**, not the endpoint. The endpoint contains a secret capability token; `message_log` is the table most likely to be surfaced in dashboards, exports, and logs. Storing a hash preserves joinability for debugging ("which deliveries went to this subscription?") without persisting the capability.

`push_endpoint_hash` is `sha256(endpoint)` — a plain digest, since the endpoint must be looked up by exact match and the digest is not used as a credential.

---

## 6. Venue geolocation — API and behaviour

### 6.1 Routes

Owned by `workers/identity` (D6). The existing stub at `index.ts:880-890` is replaced by real CRUD.

| Method   | Path                                    | Guard    | Purpose                                                                       |
| -------- | --------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `GET`    | `/v1/businesses/:id/branches`           | operator | List branches, **including** coordinates and `located_at`. Replaces the stub. |
| `POST`   | `/v1/businesses/:id/branches`           | operator | Create a branch, optionally with coordinates.                                 |
| `PATCH`  | `/v1/businesses/:id/branches/:branchId` | operator | Update name/address and/or set, change, or clear coordinates.                 |
| `DELETE` | `/v1/businesses/:id/branches/:branchId` | operator | Deactivate/remove a branch.                                                   |

Every route resolves `businessId` from the authenticated operator, never from the path alone — the path `:id` must be checked against the caller's tenant or the route is a cross-tenant write.

### 6.2 Coordinate input

The client may submit either:

- **`latitude` + `longitude`** as decimal degrees, or
- **`geohash`** (the client-side geocoder resolved it and knows the precision it used).

The server normalises to decimal degrees, computes `geohash` and `geohash_precision` server-side, and **never trusts a client-supplied geohash precision**. If the client sends both, the server prefers decimal degrees and recomputes the geohash.

`located_at` is set to `now()` whenever coordinates change and set to `NULL` when coordinates are cleared.

### 6.3 Reverse geocoding

Out of scope for this plan. `address`, `city`, `country`, `timezone` are already separate fields on `branches`; the client supplies them. A map provider's reverse-geocode API would add a third-party dependency, a quota, and a data-egress question for no capability the business actually needs — the business knows its own street address.

### 6.4 Validation

| Rule                                          | Failure                                       |
| --------------------------------------------- | --------------------------------------------- |
| Latitude ∈ [-90, 90], longitude ∈ [-180, 180] | `422 VALIDATION_ERROR`                        |
| Both or neither of lat/lng                    | `422 VALIDATION_ERROR`                        |
| Branch belongs to the caller's tenant         | `404` (not `403` — do not disclose existence) |
| Coordinates present but `located_at` unset    | Server sets it; client cannot set it.         |

---

## 7. Push notifications — subscription, consent, dispatch

### 7.1 Subscription lifecycle

Owned by `workers/communication` (D6).

| Method | Path                                   | Guard    | Purpose                                                                                                  |
| ------ | -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/communication/push/subscribe`     | customer | Register a browser subscription for the authenticated customer.                                          |
| `POST` | `/v1/communication/push/unsubscribe`   | customer | Remove a subscription (customer-initiated).                                                              |
| `GET`  | `/v1/communication/push/subscriptions` | customer | List the caller's own subscriptions (endpoint hash + created_at only, never `p256dh`/`auth`/`endpoint`). |

**`POST /v1/communication/push/subscribe`** body:

```jsonc
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": { "p256dh": "…", "auth": "…" },
  },
}
```

Server behaviour:

1. Resolve the customer from the auth token.
2. `INSERT … ON CONFLICT (endpoint) DO UPDATE SET p256dh, auth, last_seen_at = now(), customer_id, business_id`.
3. Insert a `consents` row with `consent_type = 'push'`, `granted = true`, `granted_at = now()`, `ipAddress` from the request (D5 — the existing table already carries it).
4. Return `201` with the subscription id and `created_at`. **Never echo `p256dh` or `auth`.**

The ordering matters: the subscription row is written before the consent row so that a failure between them leaves a subscription with no consent — which the send path blocks — rather than a consent with no subscription, which would imply a channel the customer never actually enabled.

**`POST /v1/communication/push/unsubscribe`** body: `{ "endpoint": "…" }`. Deletes the subscription row and inserts a `consents` row with `consent_type = 'push'`, `granted = false`, `revoked_at = now()`. Consent revocation and subscription removal are separate records on purpose — the consent log is the audit trail, the subscription row is the delivery target.

### 7.2 Consent gate on send

The WhatsApp path in `workers/communication/src/routes.ts` already performs a consent check before sending. The push path must apply the **same** gate against `consent_type = 'push'`:

```
sendable(subscription) =
    subscription exists
  AND exists a consents row where
        consent_type = 'push'
    AND customer_id = subscription.customer_id
    AND granted = true
    AND revoked_at IS NULL
```

A revoked consent blocks delivery **even if the subscription row survives**. This is the invariant that makes revocation meaningful: deleting the row is the cleanup, the consent is the authority.

### 7.3 Dispatch

`workers/communication` gains a `push` event handler alongside the existing `WhatsAppOutboundRequested` handler. The `event-handler.ts` pattern is already established: default ack-and-skip for unknown events, retry on transient failure, terminal failure on permanent rejection.

**Delivery algorithm (per event):**

1. Resolve the target set of subscriptions:
   - _Venue-targeted event_ → subscriptions of customers with an event tied to that venue (`customer_events.branch_id`).
   - _Customer-targeted event_ → that customer's subscriptions.
2. For each subscription, check the consent gate (§7.2). Skip and log if not sendable.
3. Encrypt the payload to the subscription's `p256dh`/`auth` (D7).
4. POST to the endpoint with the VAPID `Authorization` header.
5. Interpret the response:
   - `201` → delivered. Update `message_log` status `sent`.
   - `404` or `410` → the subscription is dead. **Delete the subscription row** and mark `message_log` `failed`. This is the standard signal that a browser revoked the subscription.
   - `429` → rate limited. Retry later, mirroring the existing WhatsApp behaviour (`isRetryableError`).
   - `400`/`401`/`403` → terminal. Mark `failed`. Do not retry — a `401` from a push service usually means a VAPID key mismatch, which retrying cannot fix.
6. Every attempt writes a `message_log` row with `channel = 'push'`, `reference_id` = the subscription id, and `push_endpoint_hash`.

`reference_id` as the idempotency key matches the existing WhatsApp path, so the same "don't double-send" guarantee applies to push without new machinery.

### 7.4 Trigger sources

Each of these is a domain event on `DOMAIN_EVENTS_QUEUE`, following the existing `EventEnvelope` shape (`packages/event-bus/src/index.ts`).

| Event                     | Meaning                                                                             | Proximity needed?                   |
| ------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| `PushCampaignRequested`   | A business targets a branch or a radius around it.                                  | Server-side only                    |
| `CustomerCheckedIn`       | A customer checked in at a branch (`customer_events.branch_id` already carries it). | No — the venue comes from the event |
| `RewardAvailableAtBranch` | A reward is redeemable at a specific venue. **Implemented** — see §7.4.1.           | No                                  |
| `PointsExpiringSoon`      | Balance decays at a date.                                                           | No                                  |
| `BranchLocationChanged`   | A venue moved or opened.                                                            | Coordinates used server-side        |

New event constants are added to `packages/event-bus/src/index.ts` alongside the existing seven, and the payload carries `business_id` in `header.business_id` exactly as every other event does.

#### 7.4.1 `RewardAvailableAtBranch`, as implemented

Published by the growth worker when an auto-granted reward is scoped to venues (`reward_branches`), consumed by the communication worker, which pushes to the customer who received it. The decisions from 2026-10-20, in the order they constrain the code:

| # | Decision | Where it lives |
| - | -------- | -------------- |
| Q1 | Only the customer who was granted the reward is told. A broadcast is a campaign, and campaigns are `PushCampaignRequested`. | `workers/growth/src/event-handler.ts` publishes with one `customer_id`; nothing fans out. |
| Q2 | The push uses the existing `nearby_notifications` consent. The customer-facing consent copy must say **rewards**, not only proximity. | `workers/communication/src/push-delivery.ts` re-checks the consent at delivery. |
| Q3 | At most one reward push per customer per business per 24 h. Further grants are acked without a delivery. | `REWARD_PUSH_WINDOW_MS` and `wasRewardAnnouncedToday` in `workers/communication/src/reward-notifications.ts`, read on `message_log`. |
| Q4 | Redemption is **not** restricted to the reward's venues. The scope says where it is offered, not where it may be used. | No check on the redeem path; the event is informational. |
| Q5 | The body names the venue only when the reward is scoped to exactly one; otherwise it states the count. | `describeRewardVenues` in the same module. |
| Q6 | Quiet hours are out of scope here; they belong to the transport. | — |

The event is published to `DELIVERY_QUEUE`, not `DOMAIN_EVENTS_QUEUE`: it is a message to deliver, not a fact other workers project. A missing `DELIVERY_QUEUE` binding logs and skips, as the check-in route does — the `reward_grants` row is the record.

**The `PushCampaignRequested` payload** carries a target: either an explicit `branch_id`, or a `center` + `radius_m`. For a radius target, the worker resolves candidate branches server-side by geohash prefix (precision 6 gives the coarse cell; the exact haversine distance filters within it), then sends to customers who have a consent, a subscription, and a recent interaction with that branch. "Recent" means within the last **180 days** (`INTERACTION_WINDOW_DAYS` in `workers/communication/src/push-campaigns.ts`), a product decision of 2026-10-20.

---

## 8. Worker topology and reachability

This is where the recurring defect class (§2) gets addressed. Six rules, each of which exists because something in this repository has broken that way before.

1. **The `communication` worker must become a queue consumer.** `workers/communication/wrangler.jsonc` currently declares `DOMAIN_EVENTS_QUEUE` as a **producer only**. Add a `consumers` block for the same queue and a `queue` export on the worker that calls `consume(batch, handleEvent)` from `@vyloop/event-bus`. **Without this, the push handler never runs** — the route exists, the tests pass, and nothing is delivered. This is the single most likely failure mode of the whole feature.

2. **The `customer` worker publishes to `DOMAIN_EVENTS_QUEUE`;** the `communication` worker consumes from it. Both must name the **same queue string** `vyloop-domain-events`. A typo in the queue name produces a producer and a consumer on different queues, and the symptom is total silence.

3. **A worker cannot consume from a queue it only produces to unless the consumer binding is declared.** Verify the deployed `wrangler.jsonc`, not just the file.

4. **The `gateway` must route to both workers' new paths.** Check `apps/gateway/src/wrangler-route-reachability.contract.test.ts` covers every new route. A route present in the worker but absent from the gateway is unreachable from outside — the exact defect that has occurred seven times.

5. **The documented OpenAPI surface comes only from counter-subject guards** (`requireCounterSubject(` / `counterSubject(`). The new customer-facing push routes are customer-scoped, not counter-scoped, so they will **not** appear in `api/docs/openapi.yaml` unless the guard scheme is extended. Decide explicitly whether they belong in the public contract; do not assume the contract test will pick them up.

6. **Customer-facing routes need a customer auth path in `workers/communication`.** The worker currently has `withRls` and `extractAuthHeaders` (`workers/communication/src/helpers.ts`) for its counter-scoped send route. The new customer routes must resolve the customer from the same identity system `workers/customer` uses — otherwise the subscription would be written against a different notion of "who is this customer" than `consents.customer_id` and `customers.id`.

**Route registration note:** routes are not discoverable by grepping `app.(get|post|patch|…)` over `workers/**/routes.ts`, because the helpers call `router.post(…)` rather than `app.post(…)`. Reachability is therefore a _runtime_ property and must be proven by the reachability contract test, not by reading the file.

---

## 9. Client: PWA and subscription UX

`apps/customer-web` must become installable and push-capable. Minimum work:

| Item                          | Detail                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/manifest.webmanifest` | `display: standalone`, `name`, `short_name`, `icons` (192 + 512, maskable), `start_url`. No manifest exists today; `public/` currently holds only `brand/*.jpg` and `program.html`. |
| Service worker                | `public/sw.js` — minimal. `push` event handler that parses the payload and calls `showNotification`; `notificationclick` handler that focuses an existing client or opens the target URL. |
| Subscription request          | Must be triggered from a **user gesture** (a button). Browsers reject programmatic `PushManager.subscribe()` without one.                                                                 |
| Permission UX                 | Explain before the prompt. A bare "allow notifications?" browser chrome prompt has poor acceptance; a button labelled with the benefit is materially better.                              |
| iOS handling                  | Detect iOS Safari and explain that the site must be added to the Home Screen. Without this, iOS users hit an unexplained failure.                                                         |
| Local dev                     | VAPID keys and the subscription flow require a secure context (`https://` or `localhost`).                                                                                                |
| Consent surface               | `app/components/consent-list.tsx` already exists and is where the push toggle belongs, next to the existing consent entries.                                                              |

**Server-side VAPID key handling.** The public key is public and may be served to the client. The private key is a secret: it lives as a Worker secret (`wrangler secret put VAPID_PRIVATE_KEY`) and must never appear in `wrangler.jsonc` vars, in a `NEXT_PUBLIC_` variable, or in any client bundle.

---

## 10. Security, privacy, and abuse controls

| Control                                                        | Reason                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VAPID private key as a Worker secret                           | It is the identity of the push sender. Leaking it lets anyone send to your subscribers.                                                                                                                                                       |
| Never log `p256dh`, `auth`, or the raw endpoint                | `auth` is subscription key material; the endpoint embeds a capability token. Both leak through logs, error trackers, and `message_log` exports.                                                                                               |
| `push_endpoint_hash` in `message_log` instead of the endpoint  | `message_log` is the table most likely to be exported or displayed.                                                                                                                                                                           |
| Tenancy check on every venue route                             | A cross-tenant write of a branch's coordinates is a data-integrity incident. Resolve `businessId` from the operator, not the path.                                                                                                            |
| Consent gate on every send                                     | A revoked consent must block delivery even if the subscription row still exists (§7.2).                                                                                                                                                       |
| Payload carries no PII beyond what the channel already permits | A push payload is visible in the notification tray and, on Android, readable by other apps in some configurations. Send a deep link, not customer data.                                                                                       |
| Rate limiting on subscribe/unsubscribe                         | Subscription endpoints are attacker-controlled input; unbounded registration is a storage-abuse vector.                                                                                                                                       |
| `endpoint` length cap                                          | `text` is unbounded; a 10 MB endpoint string must be rejected before it reaches the database.                                                                                                                                                 |
| Retention                                                      | Push subscriptions are personal data tied to a customer. Deleting the customer cascades (§5.3); an explicit retention job for stale rows (`last_seen_at` older than N days, subscription 404/410) keeps the table from growing without bound. |

---

## 11. Delivery phases

Each phase is independently shippable and independently verifiable.

### F1 — Venue geolocation (no push)

- Migration `0014`: the four columns and the two checks on `branches`.
- `schema.ts`: the `branches` extra-config callback gains the geohash index; `indexes.ts` gains `branches` in `INDEXED_TABLES` and the named index export (D9).
- `workers/identity`: replace the branches stub with real list/create/patch/delete, with coordinate validation.
- Registration of the migration in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with `kind`/`name` evidence (D8).
- Tests: coordinate validation, pair constraint, tenancy isolation, list returns coordinates.

**Gate:** `pnpm --filter @vyloop/db test` (including `migration-sql.test.ts`), the drift check `pnpm db:drift`, `pnpm typecheck`, `pnpm lint`, and the identity worker's own suite.

### F2 — Push transport plumbing (no user-facing trigger yet)

- `packages/event-bus`: new event constants.
- `workers/communication`: `push_subscriptions` table (migration `0015`), subscribe/unsubscribe/list routes, consent gate helper.
- `workers/communication`: `wrangler.jsonc` gains the `consumers` block; the worker gains the `queue` export (rule 1 of §8).
- `workers/communication`: push dispatch handler and the VAPID signing/encryption.
- `apps/customer-web`: manifest, service worker, subscribe button, permission UX.
- Tests: subscribe → persist → consent; revoke consent → send blocked; `404` → subscription deleted; `429` → retried; `401` → terminal.

**Gate:** end-to-end test — a real browser subscription in a test harness, one event published, one delivery observed. Plus every gate from F1.

### F3 — Proximity trigger

- `PushCampaignRequested` with branch and radius targeting.
- Server-side geohash prefix resolution and exact distance filter.
- Radius query over `branches` using the F1 index.
- `CustomerCheckedIn` and `RewardAvailableAtBranch` triggers.
- Dashboard UI for the business to compose a campaign (this is a separate, larger piece of work — the API lands in F3, the UI may follow).

**Gate:** targeting correctness — a campaign for branch A never reaches a subscriber of branch B; a radius campaign includes the intended branches and excludes the adjacent ones.

### F4 — Hardening and lifecycle

- `last_seen_at` maintenance and stale-subscription pruning.
- Dead-endpoint reaping on `404`/`410` at scale.
- Delivery dashboards over `message_log` (channel `push`).
- Rate limits and abuse monitoring on the subscribe route.
- Retention policy and the customer-deletion path verified end to end.

---

## 12. Verification strategy

### 12.1 Per-change checks

- **RED before GREEN.** Each rule gets a failing test first. One test per requested rule, plus one test per existing behaviour that shares the changed code.
- **Differential check.** For every existing command sharing changed code (the WhatsApp send path in particular), run it against the base commit and against the change, comparing stdout, stderr, and exit code. Any difference nobody asked for is a regression to fix and pin.
- **Contract tests are the truth for reachability.** `apps/gateway/src/api-openapi.contract.test.ts` and `apps/gateway/src/wrangler-route-reachability.contract.test.ts` must both pass with the new routes present.

### 12.2 Test layers

| Layer                | What it proves                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                 | Coordinate validation, geohash computation, consent gate, VAPID header construction, radius filtering.                                   |
| Contract             | New routes are reachable from the gateway; documented surface matches intent.                                                            |
| Migration            | `migration-sql.test.ts` finds no orphan `.sql`; `pnpm db:drift` is clean; the applied-outside registry entry matches the migration file. |
| Integration (Worker) | Subscribe → event → delivery → `message_log` row, against a real queue and a mocked push service.                                        |
| Browser              | Manifest installs, service worker registers, permission granted on gesture, notification displayed on a real push event.                 |

### 12.3 The one test that matters most

**A notification actually arrives.** Everything up to it can be green while the feature is broken — §8 rule 1 is exactly this failure. The F2 gate must include a real delivery observed end to end, not a mocked handler call.

### 12.4 Known environment notes

- `Node 20` vs `jsdom@30` in `customer-web`/`dashboard` produces `ReferenceError: Iterator is not defined`. This is a **pre-existing** condition unrelated to this work. Do not change `engines`, and do not let it be read as a regression from F2.
- `rg` is not installed in this environment; use `grep -rn` / `sed -n`.

---

## 13. Open decisions

These need an answer from the business before the phase that depends on them.

| #   | Question                                                                                         | Blocks           | Default if unanswered                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| Q1  | Is **background** geofencing ("arrives when I walk in") a hard requirement?                      | F3 scope         | No — proceed with the web/PWA trigger families in §3. A native app is a separate project.        |
| Q2  | Does the business want a customer-facing **radius** campaign, or only branch-targeted campaigns? | F3               | Branch-targeted only. Radius targeting is a privacy-sensitive feature and needs explicit intent. |
| Q3  | Should the new customer-facing push routes appear in the published OpenAPI contract?             | F2               | No — consistent with the current counter-subject-only convention.                                |
| Q4  | What is the retention window for a push subscription that has not been seen in months?           | F4               | 180 days since `last_seen_at`, then prune.                                                       |
| Q5  | Is WhatsApp-to-push channel preference in scope (prefer push, fall back to WhatsApp)?            | Beyond this plan | No. Push is an additional channel; the existing WhatsApp path is untouched.                      |

---

## Appendix A — Files this plan will touch

**Read (context only, no change):**
`packages/db/src/schema.ts` · `packages/db/src/indexes.ts` · `packages/event-bus/src/index.ts` · `workers/identity/src/index.ts` · `workers/communication/src/routes.ts` · `workers/communication/src/event-handler.ts` · `workers/communication/src/helpers.ts` · `workers/communication/wrangler.jsonc` · `apps/customer-web/app/components/consent-list.tsx` · `api/docs/openapi.yaml`

**Change (per phase):**
`packages/db/src/schema.ts` · `packages/db/src/indexes.ts` · `packages/db/drizzle/0014_*.sql` · `packages/db/drizzle/meta/_applied-outside-drizzle.json` · `packages/event-bus/src/index.ts` · `workers/identity/src/index.ts` · `workers/communication/src/routes.ts` · `workers/communication/src/event-handler.ts` · `workers/communication/src/push.ts` · `workers/communication/wrangler.jsonc` · `apps/customer-web/public/manifest.webmanifest` · `apps/customer-web/public/sw.js` · `apps/customer-web/app/components/consent-list.tsx` · `apps/customer-web/app/notifications/*`

> `workers/identity` has no `routes.ts` — its business routes are registered directly on the app in `index.ts` (`app.get('/v1/businesses/:id/branches', …)` at `index.ts:880`). Feature modules in that worker are separate files (`business-signup.ts`, `wallet-provision.ts`) that export a registration function, so a new branch-crud module follows that pattern rather than introducing a `routes.ts`.

## Appendix B — Glossary

| Term           | Meaning here                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Venue / local  | A physical business location. Table `branches`.                                                                       |
| Geohash        | Base-32 encoding of a coordinate pair into a string that sorts by proximity; a prefix query yields a bounding box.    |
| Precision      | Geohash character count. 6 ≈ 1.2 km cell; 7 ≈ 150 m cell.                                                             |
| VAPID          | Voluntary Application Server Identification — the key pair a push service uses to authenticate a sender.              |
| Subscription   | The browser's `{endpoint, keys}` triple. One per browser profile per origin.                                          |
| Push service   | The browser vendor's delivery service (Mozilla/Apple/Google). Holds the subscription and forwards encrypted payloads. |
| Service worker | The script that runs when a push arrives, even with the page closed.                                                  |
| PWA            | Progressive Web App — installable web application.                                                                    |
| Envelope       | The `{id, type, source, specversion, time, header, payload}` message shape from `@vyloop/event-bus`.                  |

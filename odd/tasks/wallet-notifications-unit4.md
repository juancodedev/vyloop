# Wallet Notifications — Unit 4: API and delivery

Objective: operator route to send a manual message to eligible pass holders, with
validation, daily limit, link allowlist, and asynchronous per-object delivery that
honours the notifying budget. Branch `feat/wallet-message-storage` (stacked on #285).

## Specs

S1. `POST /v1/wallet/messages` accepts `{ header, body, link? }` from an operator and sends
    to every eligible pass through `addMessage`. Eligible = object active + customer granted
    `promotions`. (openspec/changes/wallet-notifications/specs/google-wallet/spec.md)

S2. `header` 1-40, `body` 1-300, declared in `WALLET_MESSAGE_LIMITS`. `link`, when present,
    must point to the origin of `WALLET_CUSTOMER_WEB_BASE_URL`. Otherwise `422 LINK_NOT_ALLOWED`.

S3. Route answers `202` with message id and `eligible` count; delivers asynchronously, one job
    per object, idempotent on `(message_id, object_id)`.

S4. One message per business per day (constant). Over the limit → `429 WALLET_MESSAGE_LIMIT`.

S5. Non-operator caller → `403`. Customer without consent → object receives nothing.

S6. Retried job: object holds the message once.

S7. `GET /v1/wallet/messages` with counts, tenant-scoped.

S8. `QuotaExceededException` → send as `TEXT`, no retry.

## Tasks

- [x] T1. Generalise `listConsentingPasses` to take a `consentType`.
- [x] T2. `POST /v1/wallet/messages` route (validation, limit, eligibility, insert message).
- [x] T3. Fan-out (in-process via waitUntil, concurrency-bounded, idempotent via deliveries table,
      budget decides notify vs text).
- [x] T4. `GET /v1/wallet/messages` route with counts.
- [ ] T5. Gateway route registration + docs/08 entry.
- [ ] T6. Tests.
- [x] T7. OpenSpec bookkeeping + PR.

## Log

L1 (verbatim): "Unidad 4 , si procede"

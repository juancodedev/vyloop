Objective: add "Revocar QR" on the dashboard customer card — rotate the customer's `globalId` so the printed QR (`/c/<globalId>`) stops working at the POS and a new one is generated on the next customer-web load.
Branch: feat/revocar-qr. Delivery: single-pr (user approves PR per phase). Runner: vitest per package (`npx vitest run`, Node 22).
Risk: item 1 (irreversible stored-data change), item 3 (contract others consume: POS resolves `/c/<globalId>`), item 6 (no test would catch a regression in QR resolution).

## Specs

- S1 `POST /v1/customers/:id/rotate-qr` requires operator role; customer and counter tokens refused with 403 `OPERATOR_ROLE_REQUIRED`.
- S2 Rotating generates a new uuid v4 `globalId`, stores it on `customers.global_id`, and the old value no longer resolves via `GET /v1/customers/by-global-id/:oldGlobalId`.
- S3 Rotation is scoped to the operator's business: `WHERE id = :id AND business_id = :businessId AND deleted_at IS NULL`; another business's customer cannot be rotated.
- S4 Returns the new `globalId` in the response body so the dashboard can confirm the rotation.
- S5 Rotating an already-rotated customer works again (new new globalId); rotating a non-existent customer answers 404.
- S6 Dashboard customer card shows a "Revocar QR" button with an in-page confirm step naming the customer; on success the card is refreshed from the server.
- S7 `CustomerDetail` exposes `globalId` so the dashboard can display/reference it.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1-S5 | backend: `POST /v1/customers/:id/rotate-qr` + worker tests | done | (171 tests pass) |
| T2 | S4, S7 | dashboard API: `api.rotateCustomerQr` + `globalId` on `CustomerDetail` | done | |
| T3 | S6 | dashboard UI: "Revocar QR" button + confirm dialog + card refresh | done | |
| T4 | all | independent verifier (Risk items 1, 3, 6) | dropped | superseded by L2 |
| T5 | L2 | revert T1-T3; customer card uses the existing `RevokeQr` (card token rotation) | done | fix/dashboard-detail-layout |

## Log

- L1 User: "rel rebocar qr, crea un qr nuevo para este apartado, mas informacion en la misma sesion de claude f74b4ef1-479c-4c94-8b0b-92f4066922ed" — session context recovered from `/private/tmp/claude-501/.../f74b4ef1-.../scratchpad/pr327.md` and images 1-2.
- L2 2026-11-04: T1-T3 shipped in #334 rotated `customers.global_id`. That breaks the customer: the Google Wallet object id is `objectIdFor(issuer, globalId)` and the card token HMAC includes `global_id` while `card_token_hash` is not updated, so the saved pass is orphaned and `/v1/wallet/card` answers 500. The QR is the card token since #328; revoking it is `rotateCardToken`, already exposed as `RevokeQr` in the POS. User: "si corrigelo". Reverted the route and API, and the customer card now renders `RevokeQr`. Read-only production check before the fix: 0 passes with a mismatched `global_id`, 0 customers updated in the last day, so no customer had been rotated.

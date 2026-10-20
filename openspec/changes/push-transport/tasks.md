# Tasks: Push Transport

## Review Workload Forecast

| Field                   | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Estimated changed lines | ~1450 (additions + deletions)                                         |
| 400-line budget risk    | High                                                                  |
| Chained PRs recommended | Yes                                                                   |
| Suggested split         | Unit 1 (storage) → Unit 2 (API) → Unit 3 (delivery) → Unit 4 (client) |
| Delivery strategy       | ask-on-risk                                                           |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal                                    | Likely PR | Lines | Notes                               |
| ---- | --------------------------------------- | --------- | ----- | ----------------------------------- |
| 1    | Storage (table, digest, migration)      | PR #1     | ~250  | Must land first.                    |
| 2    | The API that registers a browser        | PR #2     | ~300  | Needs Unit 1.                       |
| 3    | The delivery (encryption, VAPID, event) | PR #3     | ~600  | Needs Unit 1. Parallel with Unit 2. |
| 4    | The client (manifest, worker, helper)   | PR #4     | ~300  | Parallel with Units 2 and 3.        |

## Unit 1: Storage

- [x] 1.1 `packages/db/src/schema.ts` — `push_subscriptions` table, the unique index on the endpoint, the two lookup indexes, and `message_log.push_endpoint_hash`
- [x] 1.2 `packages/db/src/indexes.ts` — register the three new indexes
- [x] 1.3 `packages/db/src/push-subscriptions.ts` — the read and write helpers, and the endpoint digest
- [x] 1.4 `packages/db/src/push-subscriptions.test.ts` — a grant is recorded, the digest is not the endpoint, a removal is scoped to the business
- [x] 1.5 `packages/db/drizzle/0016_push_subscriptions.sql` — generated, reviewed, registered in the baseline with the evidence the drift gate derives

## Unit 2: The API

- [x] 2.1 `workers/communication/src/push-routes.ts` — subscribe, unsubscribe and list
- [x] 2.2 The consent gate on registration
- [x] 2.3 The response never carries the endpoint or the keys
- [x] 2.4 `workers/communication/src/push-routes.test.ts` — the gate, the operator refusal, the unknown type, and the silence of the response

## Unit 3: The delivery

- [x] 3.1 `packages/event-bus/src/index.ts` — the `PushNotificationRequested` constant
- [x] 3.2 `packages/schema-registry/` — the schema and its registration
- [x] 3.3 `workers/communication/src/push-encryption.ts` — the `aes128gcm` encryption and the VAPID signing, on WebCrypto
- [x] 3.4 `workers/communication/src/push-encryption.test.ts` — the output is decrypted by an independent implementation
- [x] 3.5 `workers/communication/src/push-delivery.ts` — the delivery, the consent re-checked, and the classification of the push service's answers
- [x] 3.6 `workers/communication/src/push-delivery.test.ts` — 201, 404, 410, 429, 401, 400
- [x] 3.7 `workers/communication/src/event-handler.ts` — the new event
- [x] 3.8 `workers/communication/wrangler.jsonc` — the consumer block
- [x] 3.9 `workers/communication/src/queue-consumer.contract.test.ts` — the wiring is guarded
- [x] 3.10 `.github/workflows/deploy.yml` — the VAPID identity, and the public key for the client build

## Unit 4: The client

- [x] 4.1 `apps/customer-web/public/manifest.webmanifest` — the installable app
- [x] 4.2 `apps/customer-web/public/sw.js` — the push and notification handlers
- [x] 4.3 `apps/customer-web/app/lib/push.ts` — register, subscribe, unsubscribe
- [x] 4.4 `apps/customer-web/next.config.mjs` — a production build without the public key fails at build time

## Unit 5: The specifications

- [x] 5.1 `openspec/specs/database/spec.md` — the table and the digest
- [x] 5.2 `openspec/specs/event-bus/spec.md` — the event
- [x] 5.3 `openspec/specs/schema-registry/spec.md` — the schema
- [x] 5.4 `openspec/specs/push-notifications/spec.md` — the new capability

## Not done, and why

- **The customer-web consent controls are still disabled.** The backend can
  record a consent; the controls still render as unavailable, and
  `register.contract.test.ts` still asserts that. Turning them on is a product
  decision about what the business asks a customer to agree to, and it is not
  part of the transport.
- **Nothing triggers a message.** The transport works; what sends one is the
  next phase.

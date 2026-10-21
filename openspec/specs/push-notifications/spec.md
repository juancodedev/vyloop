# push-notifications Specification

## Purpose
TBD - created by archiving change push-transport. Update Purpose after archive.

## Requirements

### Requirement: Register a Browser

`POST /v1/communication/push/subscribe` MUST accept `{ subscription: { endpoint, keys: { p256dh, auth } } }` and MUST record the registration against the customer the token names. The customer MUST be resolved by `(global_id, business_id)`, because the same person is a different customer at a different merchant.

The endpoint MUST require the customer to have a granted `nearby_notifications` consent. A registration MUST NOT be made without it.

The response MUST carry the registration's id and a digest of its endpoint. It MUST NOT carry the endpoint itself, the public key or the auth secret: the endpoint is a capability, and the keys are the browser's own material.

#### Scenario: A customer registers a browser

- GIVEN a customer with a granted `nearby_notifications` consent
- WHEN `POST /v1/communication/push/subscribe` with a valid subscription
- THEN the registration is recorded against that customer
- AND the response carries the id and a digest
- AND the response carries neither the endpoint nor the keys

#### Scenario: A customer without the consent

- GIVEN a customer with no `nearby_notifications` consent, or one that was withdrawn
- WHEN the same request is made
- THEN `403 CONSENT_REQUIRED`
- AND no registration is recorded

#### Scenario: An operator registers a browser

- GIVEN a caller whose token is not a customer token
- WHEN the same request is made
- THEN `403 CUSTOMER_TOKEN_REQUIRED`
- AND no registration is recorded

#### Scenario: An unknown consent type

- GIVEN a request that names a consent type the platform does not know
- WHEN it is processed
- THEN it is rejected as a validation error
- AND no registration is recorded

### Requirement: Remove a Browser

`POST /v1/communication/push/unsubscribe` MUST accept `{ endpoint }` and MUST remove the registration belonging to the caller's business. A registration belonging to another business MUST NOT be removed by naming its endpoint.

#### Scenario: A customer removes a browser

- GIVEN a registration belonging to the customer
- WHEN it is removed
- THEN the registration is gone

#### Scenario: There was nothing to remove

- GIVEN no registration with that endpoint for the business
- WHEN the removal is requested
- THEN `404 SUBSCRIPTION_NOT_FOUND`

### Requirement: List Browsers

`GET /v1/communication/push/subscriptions` MUST return the registrations the customer holds, each with its id, a digest of its endpoint and the moments it was created and last seen. It MUST NOT return the endpoint itself, the public key or the auth secret.

#### Scenario: A customer with two browsers

- GIVEN a customer with two registrations
- WHEN the list is requested
- THEN both are returned, with digests
- AND neither the endpoints nor the keys appear

### Requirement: Deliver a Message

A `PushNotificationRequested` event MUST be delivered once per browser the customer registered, and each delivery MUST be encrypted to that browser's key before it is sent. The delivery MUST carry a VAPID authorization whose audience is the push service.

The consent MUST be checked again at the moment of the delivery, and not only when the browser was registered: a customer who withdraws afterwards MUST stop receiving messages.

The push service's answers MUST be interpreted as follows. A success MUST be recorded as delivered. A `404` or `410` MUST remove the registration, because the push service no longer holds it and every future message would otherwise pay for a delivery that cannot happen. A `429` MUST leave the message queued and be retried. A `401` or `403` MUST be terminal, because no number of retries fixes a VAPID key that is not accepted. Any other failure MUST be terminal.

#### Scenario: A message reaches every browser

- GIVEN a customer with two registered browsers and a granted consent
- WHEN the message is delivered
- THEN both browsers receive it, encrypted to their own keys
- AND both deliveries are recorded as delivered

#### Scenario: The customer withdrew the consent

- GIVEN a customer with a registered browser and a withdrawn consent
- WHEN the message is delivered
- THEN no browser receives it

#### Scenario: The browser is gone

- GIVEN a registered browser the push service no longer holds
- WHEN the message is delivered
- THEN the registration is removed
- AND the delivery is recorded as failed

#### Scenario: The service asks us to slow down

- GIVEN a push service that answers `429`
- WHEN the message is delivered
- THEN the message stays queued
- AND the delivery is retried

### Requirement: The Worker Consumes the Delivery Queue

The communication worker MUST declare a consumer for the delivery queue, and the queue it consumes MUST be the queue it produces to. The worker MUST export the handler Cloudflare calls.

A worker that exports a queue handler and is not attached to a queue is not a consumer: it is a function nobody calls. The wiring MUST be asserted by a test that reads the same files the deploy reads.

The delivery queue MUST NOT be the domain events queue. A Cloudflare queue admits exactly one consumer, and the domain events queue already has one — the growth worker. A second consumer on it is refused by the API, and the refusal names neither the queue nor the cause. A delivery is also not a domain fact: the domain events queue carries facts about what happened, and a message to deliver is an order.

#### Scenario: The consumer is declared

- GIVEN the worker's configuration
- WHEN the consumer block is inspected
- THEN a consumer is declared for the queue the worker produces to

#### Scenario: The consumer is not on a queue that already has one

- GIVEN the worker's configuration
- AND the consumer of the domain events queue
- WHEN the consumer block is inspected
- THEN the queue it consumes is not the domain events queue

#### Scenario: The handler is exported

- GIVEN the worker's entry point
- WHEN the exports are inspected
- THEN the queue handler is exported

### Requirement: Deliver RewardAvailableAtBranch

The communication worker MUST handle `RewardAvailableAtBranch` from the delivery queue by calling the existing delivery (`deliverPushNotification`) for the customer the event names, with `reference_id` `reward-grant:<grant_id>`. It MUST NOT implement a second delivery path: the consent re-check, the browsers, the encryption and the interpretation of the push service's answers MUST be the existing ones.

The consent MUST be `nearby_notifications` (Q2, answered 2026-10-20): no new consent type is introduced. The consent copy the customer web shows MUST describe reward notifications, not proximity alone; a permission obtained for "nearby" MUST NOT be spent on a message it did not describe.

The message MUST name the reward, MUST link to the customer web's rewards view, and MUST NOT carry the points balance or any other customer data. It MUST name the venue when the reward is scoped to exactly one, and otherwise MUST state how many venues the reward is available at. It MUST NOT name a single venue when the reward has several: redemption is not restricted to the scope (Q4), so a message naming one of them would send the customer to a venue that may not honour the reward (Q5).

A customer who already received a `sent` push with a `reward-grant:` reference from the same business in the last 24 hours MUST NOT be notified again; the event MUST be acked without a delivery (Q3).

#### Scenario: The customer is notified

- GIVEN a customer with a granted `nearby_notifications` consent and one registered browser
- WHEN a `RewardAvailableAtBranch` event for that customer is consumed
- THEN one push is delivered naming the reward and how many venues it is available at
- AND the `message_log` row carries reference `reward-grant:<grant_id>:<subscription id>`

#### Scenario: The event is redelivered

- GIVEN a `RewardAvailableAtBranch` event already delivered
- WHEN the queue delivers it again
- THEN no second push is sent

#### Scenario: No consent

- GIVEN a customer without the `nearby_notifications` consent
- WHEN the event is consumed
- THEN no push is sent
- AND the event is acked

#### Scenario: A reward scoped to several venues

- GIVEN a reward scoped to venues A, B and C
- WHEN the grant for that reward is consumed
- THEN the message states that the reward is available at 3 venues
- AND it names none of them

#### Scenario: The frequency cap

- GIVEN a customer who received a reward notification 2 hours ago
- WHEN another `RewardAvailableAtBranch` event for that customer is consumed
- THEN no push is sent
- AND the event is acked

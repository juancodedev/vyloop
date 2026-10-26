# google-wallet Specification

## Purpose
TBD - created by archiving change wallet-notifications. Update Purpose after archive.

## Requirements

### Requirement: Venue Locations on the Pass

The loyalty object of a customer with a granted `nearby_notifications` consent MUST carry, in `merchantLocations`, the positions of the business's venues that are active and have both `latitude` and `longitude`. It MUST carry at most 10 of them, the limit Google accepts per object.

When the business has more than 10 such venues, the object MUST carry the 10 whose coordinates were updated most recently. _(Decided, Q1: no per-customer visit order. Google evaluates proximity on the device, so past visits say nothing about where the holder is now, and the order would cost a join per customer on every object build.)_

The loyalty object of a customer without that consent, or with it withdrawn, MUST carry no `merchantLocations`. The loyalty class MUST carry no `merchantLocations`, because a class reaches every holder regardless of consent.

The deprecated `locations` field MUST NOT be sent.

#### Scenario: A consenting customer holds a pass

- GIVEN a business with three active, located venues
- AND a customer with a granted `nearby_notifications` consent and a saved pass
- WHEN the pass object is synchronised
- THEN its `merchantLocations` holds the three positions

#### Scenario: A customer without the consent

- GIVEN the same business
- AND a customer with no `nearby_notifications` consent
- WHEN the pass object is synchronised
- THEN its `merchantLocations` is empty

#### Scenario: A venue without a position

- GIVEN a venue that is active but has no coordinates
- WHEN a consenting customer's object is synchronised
- THEN that venue is not in `merchantLocations`

#### Scenario: More than ten venues

- GIVEN a business with twelve active, located venues
- WHEN a consenting customer's object is synchronised
- THEN `merchantLocations` holds exactly ten positions

#### Scenario: The class never carries locations

- GIVEN any business
- WHEN its loyalty class is provisioned or patched
- THEN the class payload has no `merchantLocations` and no `locations`

### Requirement: Keep Locations in Step

The wallet worker MUST synchronise the `merchantLocations` of the affected objects when:

- a customer grants or withdraws `nearby_notifications`: that customer's object;
- a venue is registered, moved, deactivated or reactivated: the objects of the business's consenting customers.

A withdrawn consent MUST be reflected on the pass without waiting for a periodic sweep. A synchronisation MUST NOT set `notifyPreference`, so it is never a push notification.

#### Scenario: The customer withdraws the consent

- GIVEN a consenting customer whose object carries locations
- WHEN the customer withdraws `nearby_notifications`
- THEN the object is patched with empty `merchantLocations`
- AND the patch carries no `notifyPreference`

#### Scenario: A venue is deactivated

- GIVEN a venue present in consenting customers' objects
- WHEN the venue is deactivated
- THEN those objects no longer carry its position

### Requirement: Send a Wallet Message

`POST /v1/wallet/messages` MUST accept `{ header, body, link? }` from an operator of the business and MUST send the message to every eligible pass of that business through the loyalty object `addMessage` method.

A pass is eligible when its object is active and its customer has granted the `promotions` consent. _(Decided, Q2: `promotions` is the purpose `docs/10` §15 names for offers, off by default. The push campaign gate still reads `nearby_notifications`, which contradicts §15; that is a separate change.)_

`header` MUST be 1–40 characters and `body` 1–300 characters, declared once in `WALLET_MESSAGE_LIMITS` in `@vyloop/types` so the form and the route cannot disagree. _(Decided, Q4: product limits. Google documents no message-length cap, so a provider rejection for length is recorded per object and never retried.)_ `link`, when present, MUST point to the origin of `WALLET_CUSTOMER_WEB_BASE_URL`. Any other origin MUST be refused, because Google's Acceptable Use Policy forbids links unrelated to the pass, and an operator-typed host is that vector with a typo.

The route MUST answer `202` with the message id and the number of eligible passes, and MUST deliver asynchronously, one job per object, idempotent on `(message_id, object_id)`.

A business MUST NOT send more than the daily limit of messages. _(Assumption, Q3: one per business per day.)_

#### Scenario: An operator sends a message

- GIVEN a business with 50 eligible passes
- WHEN an operator sends `{ header: "Double points", body: "Today only, at every venue." }`
- THEN `202` with the message id and `eligible: 50`
- AND each of the 50 objects receives the message once

#### Scenario: A customer without consent

- GIVEN a pass whose customer has not granted wallet messages
- WHEN a message is sent
- THEN that object receives nothing

#### Scenario: A link unrelated to the pass

- GIVEN a message whose `link` points to a host the business has not registered
- WHEN it is sent
- THEN `422 LINK_NOT_ALLOWED`
- AND no object receives it

#### Scenario: The daily limit is reached

- GIVEN a business that already sent its messages for the day
- WHEN another is sent
- THEN `429 WALLET_MESSAGE_LIMIT`
- AND no object receives it

#### Scenario: A counter or customer token

- GIVEN a caller whose token is not an operator token
- WHEN the same request is made
- THEN `403`
- AND nothing is sent

#### Scenario: A retried job

- GIVEN a delivery job that already added the message to its object
- WHEN the job runs again
- THEN the object still holds the message once

### Requirement: Notification Budget

The wallet worker MUST record every `TEXT_AND_NOTIFY` message it adds, per object, with its time. A message MUST be added as `TEXT_AND_NOTIFY` only when the object has fewer than 3 such messages in the previous 24 hours; otherwise it MUST be added as `TEXT`, so it is shown on the card without a notification.

A `QuotaExceededException` from Google MUST cause the same message to be added once as `TEXT`, and MUST NOT be retried as a notification.

#### Scenario: Within the budget

- GIVEN an object with one notifying message in the last 24 hours
- WHEN a message is delivered to it
- THEN it is added as `TEXT_AND_NOTIFY`

#### Scenario: The budget is used

- GIVEN an object with three notifying messages in the last 24 hours
- WHEN a message is delivered to it
- THEN it is added as `TEXT`

#### Scenario: Google refuses the quota

- GIVEN Google answers `QuotaExceededException` for a notifying message
- WHEN the job handles it
- THEN the message is added as `TEXT`
- AND the job finishes without retrying

### Requirement: Message Delivery Report

`GET /v1/wallet/messages` MUST list the business's messages, newest first, each with `eligible`, `notified`, `silent` (added as `TEXT`) and `failed` counts. It MUST NOT list another business's messages.

#### Scenario: After a send

- GIVEN a message delivered to 48 objects with notification, 2 without, and 0 failures
- WHEN the operator lists messages
- THEN that message shows `notified: 48`, `silent: 2`, `failed: 0`

# Delta for push-notifications

## ADDED Requirements

### Requirement: Deliver RewardAvailableAtBranch

The communication worker MUST handle `RewardAvailableAtBranch` from the delivery queue by calling the existing delivery (`deliverPushNotification`) for the customer the event names, with `reference_id` `reward-grant:<grant_id>`. It MUST NOT implement a second delivery path: the consent re-check, the browsers, the encryption and the interpretation of the push service's answers MUST be the existing ones.

The consent MUST be `nearby_notifications`. Assumption (open question Q2): no new consent type is introduced.

The message MUST name the reward and one venue, MUST link to the customer web's rewards view, and MUST NOT carry the points balance or any other customer data. When the reward has several venues, the venue named MUST be the one the customer interacted with most recently within `INTERACTION_WINDOW_DAYS`, and otherwise the first by name (assumption, open question Q5).

A customer who already received a `sent` push with a `reward-grant:` reference from the same business in the last 24 hours MUST NOT be notified again; the event MUST be acked without a delivery (assumption, open question Q3).

#### Scenario: The customer is notified

- GIVEN a customer with a granted `nearby_notifications` consent and one registered browser
- WHEN a `RewardAvailableAtBranch` event for that customer is consumed
- THEN one push is delivered naming the reward and the venue
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

#### Scenario: The frequency cap

- GIVEN a customer who received a reward notification 2 hours ago
- WHEN another `RewardAvailableAtBranch` event for that customer is consumed
- THEN no push is sent
- AND the event is acked

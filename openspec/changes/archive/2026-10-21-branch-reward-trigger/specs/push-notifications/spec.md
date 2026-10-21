# Delta for push-notifications

## ADDED Requirements

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

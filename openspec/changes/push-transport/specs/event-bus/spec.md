# Delta for event-bus

## ADDED Requirements

### Requirement: PushNotificationRequested Event

The event bus MUST define a `PushNotificationRequested` event type. Its payload MUST carry the `customer_id` (the global id, like every other customer event), the `business_id`, the notification `title` and `body`, and MAY carry the `url` the notification leads to and a `reference_id` that identifies the message so the same one is not delivered twice.

#### Scenario: The event is published

- GIVEN a message to deliver to a customer
- WHEN it is published to the delivery queue
- THEN the envelope type is `PushNotificationRequested`
- AND the payload carries the customer, the business, the title and the body

A notification to deliver is not a domain fact, and it MUST NOT travel on the
domain events queue: that queue carries facts about what happened and is
consumed by the growth worker, and a Cloudflare queue admits exactly one
consumer.

# Delta for push-notifications

## ADDED Requirements

### Requirement: Claim a Delivery Before Sending It

When a `PushNotificationRequested` payload carries a `reference_id`, each browser's delivery MUST be identified by the delivery key `<reference_id>:<subscription id>`, and the delivery MUST be claimed before it is sent. A claim MUST be atomic in the database: of any number of consumers attempting the same delivery key at the same time, at most one MUST obtain it, and only the consumer that obtained it MAY send.

There MUST be at most one `message_log` row per `(business_id, delivery_key)`. A retry of the same delivery MUST reuse that row rather than create another, and MUST increment `metadata.attempts`.

A row MAY be reclaimed only while its status is `queued` and its lease has expired or was released. A row whose status is `sent` or `failed` MUST NOT be reclaimed, and its delivery MUST be skipped.

A payload without a `reference_id` MUST NOT be deduplicated: each such delivery MUST get its own row, with no delivery key.

#### Scenario: Two consumers deliver the same event at once

- GIVEN one customer with one registered browser and a granted consent
- AND a campaign event with reference `R` delivered to two consumers concurrently
- WHEN both attempt the delivery
- THEN exactly one push request is sent for `R:<subscription id>`
- AND exactly one `message_log` row exists for that delivery key

#### Scenario: A delivery already decided is skipped

- GIVEN a `message_log` row for delivery key `R:S` with status `sent`
- WHEN the same event is delivered again
- THEN no push request is sent to subscription `S`
- AND no new `message_log` row is created

#### Scenario: Unreferenced messages are not deduplicated

- GIVEN two `PushNotificationRequested` events for the same customer, neither with a `reference_id`
- WHEN both are delivered
- THEN both are sent
- AND each has its own `message_log` row with no delivery key

### Requirement: A Retry Reuses the Claimed Row

When the push service answers `429`, or the request cannot be made, the consumer MUST release the lease of the claimed row, leave its status `queued`, and then throw so the queue redelivers the event. The redelivery MUST reclaim the same row.

A lease MUST expire on its own after a bounded time, so a consumer that dies while holding it does not block the delivery forever. The push request MUST carry a timeout shorter than the lease.

#### Scenario: A 429 is retried on the same row

- GIVEN a delivery whose first attempt is answered `429`
- WHEN the queue redelivers the event and the second attempt is answered `201`
- THEN one `message_log` row exists for that delivery key
- AND its status is `sent`
- AND its `metadata.attempts` is `2`

#### Scenario: A consumer died holding the lease

- GIVEN a `queued` row whose lease expired and was never released
- WHEN the event is delivered again
- THEN the delivery is reclaimed and attempted
- AND the attempt count is incremented

#### Scenario: A fresh lease is respected

- GIVEN a `queued` row whose lease has not expired
- WHEN another consumer attempts the same delivery key
- THEN it does not send
- AND it does not throw

### Requirement: Collapse Undelivered Duplicates at the Push Service

Every push request for a delivery with a delivery key MUST carry a `Topic` header derived deterministically from the delivery key, of at most 32 characters from the URL-safe base64 alphabet (RFC 8030 §5.4). It MUST NOT carry the endpoint or any customer identifier.

#### Scenario: The topic is stable per delivery

- GIVEN the same delivery key attempted twice
- WHEN both requests are built
- THEN both carry the same `Topic` header
- AND it is at most 32 characters long

### Requirement: Claim a Campaign Reference When It Is Composed

`POST /v1/communication/push/campaigns` MUST record the campaign in `push_campaigns` before publishing it, and the record MUST be unique by `(business_id, reference_id)`. Of any number of concurrent requests with the same reference, exactly one MUST be accepted with `202`; the others MUST be refused with `409 DUPLICATE_MESSAGE`.

If publishing the campaign fails, the record MUST be removed so the reference can be composed again, and the request MUST fail.

A reference already present in `message_log` from a campaign composed before `push_campaigns` existed MUST still be refused.

#### Scenario: Two operators compose the same campaign at once

- GIVEN two concurrent requests with `reference_id` `promo-1` for the same business
- WHEN both are processed
- THEN one is answered `202`
- AND the other is answered `409 DUPLICATE_MESSAGE`
- AND exactly one `PushCampaignRequested` event is published

#### Scenario: The same reference in another business

- GIVEN a campaign `promo-1` composed by business A
- WHEN business B composes a campaign `promo-1`
- THEN it is accepted

#### Scenario: Publishing fails

- GIVEN the delivery queue rejects the publish
- WHEN a campaign is composed
- THEN the request fails
- AND no `push_campaigns` row remains for that reference

### Requirement: Delivery Counts Are Per Delivery

`GET /v1/communication/push/deliveries` MUST count one row per referenced delivery, whatever the number of attempts it took. A delivery retried and then sent MUST count once, as `sent`.

#### Scenario: A retried delivery counts once

- GIVEN a delivery that was answered `429` twice and then `201`
- WHEN the deliveries are counted
- THEN it contributes `1` to `sent`
- AND `0` to `queued`

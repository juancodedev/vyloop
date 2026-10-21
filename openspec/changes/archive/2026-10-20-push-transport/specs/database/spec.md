# Delta for database

## ADDED Requirements

### Requirement: Push Subscriptions

The database MUST hold one row per browser registration, with the endpoint the push service accepts a delivery on, the browser's public key (`p256dh`) and its auth secret (`auth`). A registration MUST belong to a `business_id` and a `customer_id`.

The endpoint MUST be unique across the table. A browser rotates its keys for the same endpoint, so registering again is the same registration with newer keys rather than a second one, and a browser that signs out and is used by a different customer MUST move to that customer rather than accumulate a row per customer.

The endpoint MUST NOT be written to `message_log`. It is a capability, and `message_log` is the table most likely to be exported or displayed. The table MUST hold a SHA-256 digest of it in `push_endpoint_hash` instead, which is enough to answer which delivery went to which registration.

#### Scenario: A browser registers

- GIVEN a customer and a browser registration
- WHEN the registration is recorded
- THEN a row exists for that customer with the endpoint, the public key and the auth secret

#### Scenario: The same browser registers again

- GIVEN a registration already recorded for an endpoint
- WHEN that browser registers again with new keys
- THEN the same row is updated with the new keys
- AND no second row is created

#### Scenario: A browser changes hands

- GIVEN a registration belonging to one customer
- WHEN the same browser is registered by another
- THEN the registration belongs to the new customer

#### Scenario: A delivery is recorded

- GIVEN a push message delivered to a browser
- WHEN the delivery is written to `message_log`
- THEN the row holds a digest of the endpoint
- AND the row does not hold the endpoint

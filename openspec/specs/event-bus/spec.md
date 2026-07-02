# Event Bus Specification

## Purpose

Cloudflare Queues: at-least-once, retry policy, DLQ.

## Requirements

### Requirement: Delivery

Events MUST deliver at least once. Consumers MUST be idempotent.

#### Scenario: Crash recovery
- GIVEN event in queue
- WHEN consumer crashes before ack
- THEN retries, no duplicate effects

### Requirement: Retry + DLQ

Retry at 1s, 5s, 30s, 5min, 30min. Then DLQ.

#### Scenario: Exhausted
- GIVEN always-failing event
- WHEN all 5 retries attempted
- THEN event moves to DLQ

### Requirement: Event Header

Events MUST carry `header` with `business_id`, `timestamp`, `localization`.

#### Scenario: Missing header
- GIVEN event without `business_id`
- WHEN pre-processed
- THEN rejected before consumers

### Requirement: CustomerRegistered Event Type

The event bus MUST register `CustomerRegistered` as a recognized event type string. Producers MUST include the event header with `business_id`, `timestamp`, and `localization` per the existing Event Header requirement.

The event payload MUST contain:
- `customer_id` (uuid) — the customer's `global_id`
- `full_name` (string) — the customer's full name
- `business_id` (uuid) — the business scoping identifier

#### Scenario: Valid CustomerRegistered produced
- GIVEN a producer sends to `DOMAIN_EVENTS_QUEUE`
- WHEN the event type is `CustomerRegistered`
- THEN the payload includes `customer_id`, `full_name`, and `business_id`
- AND the header includes `business_id`, `timestamp`, and `localization`

#### Scenario: Missing required field in event header
- GIVEN a `CustomerRegistered` event without `business_id` in header
- WHEN the bus pre-processes it
- THEN the event is rejected before reaching consumers

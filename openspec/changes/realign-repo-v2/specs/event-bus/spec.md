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

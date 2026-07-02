# Event Ingestor Specification

## Purpose

HTTP endpoint for event ingestion, schema validation before publish.

## Requirements

### Requirement: Ingestion

`POST /v1/events/{type}` accepting JSON with `header` and `payload`.

#### Scenario: Published
- GIVEN valid payload for `purchase`
- WHEN `POST /v1/events/purchase`
- THEN validated, published to bus, 202

### Requirement: TestEvent

`TestEvent` SHALL validate and publish to dev-only queue.

#### Scenario: Dev-safe
- GIVEN `TestEvent` payload
- WHEN `POST /v1/events/test`
- THEN dev queue, 202

### Requirement: Error Codes

Return `SCHEMA_INVALID` (400), `EVENT_TYPE_UNKNOWN` (404), `RATE_LIMIT_EXCEEDED` (429).

#### Scenario: Unknown
- GIVEN `POST /v1/events/unknown_type`
- WHEN no schema exists
- THEN 404 `EVENT_TYPE_UNKNOWN`

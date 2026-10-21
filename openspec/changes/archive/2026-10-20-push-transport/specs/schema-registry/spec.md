# Delta for schema-registry

## ADDED Requirements

### Requirement: PushNotificationRequested Schema

The schema registry MUST register a `PushNotificationRequested` JSON Schema at version `v1.0.0`, and MUST publish it under both `{eventType}:{version}` and `{eventType}:latest`.

The schema MUST validate an envelope with `header` and `payload` as sibling properties. The `payload` MUST validate `customer_id` (string, uuid), `business_id` (string, uuid), `title` (string, minLength 1) and `body` (string) as required, and MAY validate `url` (string) and `reference_id` (string).

#### Scenario: A valid payload passes

- GIVEN an envelope with a valid header and payload
- WHEN validated against the schema
- THEN validation passes

#### Scenario: A payload without a title is rejected

- GIVEN a payload with no `title`
- WHEN validated
- THEN validation fails with `SCHEMA_INVALID`

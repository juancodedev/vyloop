# Schema Registry Specification

## Purpose

KV-backed schema storage, semver, CRUD, pre-publish validation.

## Requirements

### Requirement: Storage + Versioning

Schemas in Workers KV keyed `{event_type}:{version}`, JSON Schema format.

#### Scenario: Lookup
- GIVEN `PurchaseCompleted` at `v1.2.0`
- WHEN requesting `purchase_completed:v1.2.0`
- THEN exact schema returned

### Requirement: Validation

Ingestor MUST validate payloads. Invalid → 400 `SCHEMA_INVALID`.

#### Scenario: Invalid
- GIVEN payload missing a required field
- WHEN Ingestor validates
- THEN 400 `SCHEMA_INVALID`

### Requirement: Registration and Lookup

`registerSchema` MUST store the schema under both `{eventType}:{version}` and `{eventType}:latest`, and `getSchema` MUST read the exact key when a version is given and the `latest` key when it is not.

The version MUST be the explicit argument when present, otherwise the semver tail of the schema's `$id`, otherwise `1.0.0`. Registration MUST invalidate the compiled validator for that event type.

The package exposes no list, deprecate or delete operation, and no HTTP surface: registration happens through `packages/schema-registry/scripts/register-schemas.ts`, which runs as a deployment step.

#### Scenario: Registration writes both keys

- GIVEN a schema registered at `1.0.0`
- WHEN the store is read
- THEN both `{eventType}:1.0.0` and `{eventType}:latest` hold it

#### Scenario: Lookup without a version

- GIVEN a registered schema
- WHEN it is read without a version
- THEN the `latest` value is returned

#### Scenario: The version comes from `$id`

- GIVEN a schema whose `$id` ends in `v2.1.0` and no explicit version
- WHEN it is registered
- THEN it is stored at `2.1.0` and at `latest`

#### Scenario: An absent schema

- GIVEN no schema registered for an event type
- WHEN it is read
- THEN `null` is returned

### Requirement: CustomerRegistered Schema

The schema registry MUST register a `CustomerRegistered` JSON Schema at version `v1.0.0`. The schema MUST validate:
- `customer_id` — string, uuid format
- `full_name` — string, minimum length 1
- `business_id` — string, uuid format

All three fields MUST be required.

#### Scenario: Valid payload passes
- GIVEN a payload with valid uuid `customer_id`, non-empty `full_name`, and valid uuid `business_id`
- WHEN validated against the schema
- THEN validation passes

#### Scenario: Missing required field
- GIVEN a payload missing `full_name`
- WHEN validated against the schema
- THEN validation fails with `SCHEMA_INVALID`

#### Scenario: Invalid uuid format
- GIVEN `customer_id` is not a valid UUID
- WHEN validated
- THEN validation fails with `SCHEMA_INVALID`

#### Scenario: Empty full_name
- GIVEN `full_name` is an empty string
- WHEN validated
- THEN validation fails (minLength 1)

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

### Requirement: RewardAvailableAtBranch Schema

The schema registry MUST register a `RewardAvailableAtBranch` JSON Schema at version `v1.0.0`, and MUST publish it under both `{eventType}:{version}` and `{eventType}:latest`, through `registerAllSchemas` in `packages/schema-registry/scripts/register-schemas.ts`.

The schema MUST validate an envelope with `header` and `payload` as sibling properties. The `payload` MUST validate `customer_id` (string, uuid, the customer's global id), `business_id` (string, uuid), `reward_id` (string, uuid), `reward_name` (string, minLength 1), `grant_id` (string, uuid) and `branch_ids` (array of uuid strings, minItems 1) as required, and MUST reject additional properties.

#### Scenario: A valid payload passes

- GIVEN an envelope with a valid header and a payload naming one venue
- WHEN validated against the schema
- THEN validation passes

#### Scenario: A payload without venues is rejected

- GIVEN a payload whose `branch_ids` is empty
- WHEN validated against the schema
- THEN validation fails

#### Scenario: The schema is registered at startup

- GIVEN the registration script
- WHEN `registerAllSchemas` runs against a KV mock
- THEN `RewardAvailableAtBranch:v1.0.0` and `RewardAvailableAtBranch:latest` are written

### Requirement: Request Id in the Envelope Header Schema

The shared envelope header schema MUST allow an optional `request_id` property (string, pattern `^[A-Za-z0-9._-]{8,128}$`) and MUST keep rejecting any other additional property. Every event schema built on it MUST accept an envelope with or without `request_id`.

#### Scenario: An envelope with a request id validates

- GIVEN a valid `PointsAssigned` envelope whose header carries `request_id`
- WHEN it is validated
- THEN validation passes

#### Scenario: An envelope without one still validates

- GIVEN a valid envelope with no `request_id`
- WHEN it is validated
- THEN validation passes

#### Scenario: A malformed request id is rejected

- GIVEN a header whose `request_id` contains a space
- WHEN it is validated
- THEN validation fails

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

### Requirement: CRUD

Endpoints to register, read, list, deprecate. Admin-only modify.

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

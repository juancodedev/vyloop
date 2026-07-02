# Delta for Schema Registry

## ADDED Requirements

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

(Previously: no CustomerRegistered schema existed)

# Delta for schema-registry

## ADDED Requirements

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

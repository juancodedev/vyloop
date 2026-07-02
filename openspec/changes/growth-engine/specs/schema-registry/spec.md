# Delta for schema-registry

## ADDED Requirements

### Requirement: PointsAssigned Schema

The schema registry MUST register a `PointsAssigned` JSON Schema at version `v1.0.0`. The schema MUST validate an envelope format with `header` and `payload` as sibling properties. The `header` MUST validate `business_id` (string, uuid), `timestamp` (string, iso8601), `localization` (object with `language` and `timezone`). The `payload` MUST validate `customer_id` (string, uuid), `points_assigned` (integer, minimum 1), `total_points` (integer, minimum 0), `points_multiplier` (number, minimum 0), `reference_id` (string, minimum 1), and `assignment_id` (string, uuid). All envelope-level fields and all payload fields MUST be required.

#### Scenario: Valid PointsAssigned passes
- GIVEN an envelope with valid header and payload
- WHEN validated against the schema
- THEN validation passes

#### Scenario: Invalid assignment_id format
- GIVEN `assignment_id` is not a valid UUID
- WHEN validated
- THEN validation fails with `SCHEMA_INVALID`

#### Scenario: Missing header
- GIVEN payload with only `payload` field
- WHEN validated
- THEN validation fails (header required)

### Requirement: RewardRedeemed Schema

The schema registry MUST register a `RewardRedeemed` JSON Schema at version `v1.0.0`. The schema MUST validate an envelope format with `header` and `payload`. The `header` MUST use the same schema as `PointsAssigned`. The `payload` MUST validate `customer_id` (string, uuid), `points_redeemed` (integer, minimum 1), `total_points_after` (integer, minimum 0), `reward_name` (string, optional), `partial` (boolean), `reference_id` (string, minimum 1), and `redemption_id` (string, uuid). `reward_name` MUST be optional; all other fields MUST be required.

#### Scenario: Valid full redemption passes
- GIVEN envelope with `partial: false`, `reward_name: "Gift Card"`
- WHEN validated
- THEN validation passes

#### Scenario: Valid partial without reward name
- GIVEN envelope with `partial: true`, `reward_name` omitted
- WHEN validated
- THEN validation passes

#### Scenario: Invalid points_redeemed
- GIVEN `points_redeemed` is 0
- WHEN validated
- THEN validation fails (minimum 1)

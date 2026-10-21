# Delta for schema-registry

## ADDED Requirements

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

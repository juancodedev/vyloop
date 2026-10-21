# Event Ingestor Specification

## Purpose

HTTP endpoint for event ingestion: schema validation before publish, scoped to the
authenticated business.

## Requirements

### Requirement: Ingestion

`POST /v1/events/{type}` SHALL accept either an envelope (`{ header, payload }`) or
a bare payload, validate it against the Schema Registry, and publish an envelope to
the event queue with the authenticated business as its `header.business_id`.

The route SHALL be registered below the gateway's auth, auth-inject, business-id
and rate-limit middleware, so that registration order — not a check inside the
handler — is what authenticates it.

#### Scenario: Published

- **GIVEN** a token and a schema-valid body for `PointsAssigned`
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** the body is validated against the registry and published to the domain
  queue under the token's business
- **AND** the response is 202

#### Scenario: Bare payload

- **GIVEN** a token and a body that matches a payload-only schema, `CustomerRegistered`
- **WHEN** `POST /v1/events/CustomerRegistered`
- **THEN** the body itself becomes the envelope's `payload`
- **AND** the envelope is published under the token's business, never under
  `business_id: "unknown"`

### Requirement: Authentication and tenancy

The ingestor SHALL take the event's `business_id` from the verified JWT claim,
never from the request body. A request without a valid identity SHALL answer 401,
and a body whose `header.business_id` names a different business SHALL answer 403.

#### Scenario: Anonymous write

- **GIVEN** a schema-valid event body and no `Authorization` header
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** 401 `AUTH_TOKEN_INVALID`
- **AND** nothing is published

#### Scenario: Foreign tenant

- **GIVEN** a token for business A and a body whose `header.business_id` is B
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** 403 `EVENT_BUSINESS_MISMATCH`
- **AND** nothing is published

### Requirement: Registered types only

The event type SHALL be a key of the Schema Registry, which the `register-schemas`
deploy job populates before the gateway is published. KV keys are the event type in
PascalCase with a version suffix; the deploy publishes `CustomerCheckedIn`,
`CustomerRegistered`, `PointsAssigned`, `PushCampaignRequested`,
`PushNotificationRequested`, `RewardAvailableAtBranch`, `RewardRedeemed`,
`WhatsAppOutboundRequested` and `WorkflowTriggered`.

#### Scenario: Unknown type

- **GIVEN** `POST /v1/events/purchase`
- **WHEN** no schema is registered under `purchase`
- **THEN** 404 `EVENT_TYPE_UNKNOWN`
- **AND** nothing is published

#### Scenario: Unregistered test type

- **GIVEN** the deploy registers no `test_event` key
- **WHEN** `POST /v1/events/test_event`
- **THEN** 404 `EVENT_TYPE_UNKNOWN`

### Requirement: Queue selection

An event named `test_event` SHALL publish to the dev-only queue; every other type
SHALL publish to the domain queue. No `test_event` key is registered today, so that
branch is dormant until one is.

#### Scenario: Domain queue

- **GIVEN** a token and a schema-valid `PointsAssigned` body
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** the event is published to `DOMAIN_EVENTS_QUEUE`
- **AND** nothing is published to the dev queue

### Requirement: Error Codes

The route MUST answer `SCHEMA_INVALID` (400) for a non-JSON body, a wrong
Content-Type, a JSON body that is not an object, or a schema mismatch, and
`RATE_LIMIT_EXCEEDED` (429) when the gateway's limiter refuses the request.

#### Scenario: Content type

- **GIVEN** a token and `Content-Type: text/plain`
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** 400 `SCHEMA_INVALID`
- **AND** no schema lookup is performed

#### Scenario: Non-object JSON

- **GIVEN** a token and a body of `null`, `[]` or `"text"`
- **WHEN** `POST /v1/events/PointsAssigned`
- **THEN** 400 `SCHEMA_INVALID`, never 500
- **AND** nothing is published

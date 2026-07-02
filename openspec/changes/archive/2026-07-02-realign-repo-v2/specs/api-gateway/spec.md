# API Gateway Specification

## Purpose

CF Workers + Hono: auth, routing, rate limiting, errors.

## Requirements

### Requirement: Auth

Gateway MUST validate JWT and X-Business-ID before forwarding.

#### Scenario: No auth
- GIVEN no `Authorization` header
- WHEN protected endpoint called
- THEN 401 `AUTH_TOKEN_INVALID`

### Requirement: Routing

Route by segment: `/v1/identity/*`, `/v1/customers/*`, `/v1/loyalty/*`, `/v1/analytics/*`, `/v1/events/*`, `/v1/automation/*`.

#### Scenario: Prefix match
- GIVEN `POST /v1/loyalty/points/assign`
- WHEN matched to `/v1/loyalty`
- THEN forwarded to Growth Worker

### Requirement: Rate Limiting

Per `business_id` per endpoint. Exceeded → 429 + `Retry-After`.

#### Scenario: Quota exceeded
- GIVEN business quota exhausted
- WHEN next request
- THEN 429

### Requirement: Error Format

Errors: `{"error":{"code":"...","message":"...","request_id":"..."}}`.

#### Scenario: Response shape
- GIVEN any non-2xx
- THEN body matches schema

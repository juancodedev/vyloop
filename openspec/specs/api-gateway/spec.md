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

### Requirement: Auth Header Injection

The gateway MUST inject `X-User-Id`, `X-Business-Id`, and `X-User-Role` headers from decoded JWT claims before forwarding requests to service bindings. The gateway SHOULD strip these headers from incoming requests before processing to prevent header spoofing.

#### Scenario: Headers injected on forward
- GIVEN a valid JWT with `sub`, `business_id`, and `role` claims
- WHEN the gateway forwards a request to a worker binding
- THEN `X-User-Id`, `X-Business-Id`, and `X-User-Role` are set from claims

#### Scenario: Header spoofing prevented
- GIVEN an incoming request with `X-User-Id` already set
- WHEN the gateway processes it
- THEN the incoming header is stripped before JWT-based injection

#### Scenario: Missing JWT claim
- GIVEN a valid JWT missing `business_id`
- WHEN the gateway attempts to inject headers
- THEN the header is omitted or set to empty
- AND the request still forwarded (worker enforces RLS)

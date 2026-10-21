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

Route by segment, longest prefix first: `/v1/auth`, `/v1/me`, `/v1/businesses`, `/v1/customers`, `/v1/loyalty`, `/v1/growth`, `/v1/analytics`, `/v1/support`, `/v1/automation`, `/v1/communication`, `/v1/compliance`, `/v1/wallet`.

`/v1/events` MUST stay in the route map with the `gateway` binding: `routerMiddleware` calls `next()` for a gateway-owned prefix, so that entry is what makes a route the gateway answers itself reachable at all. The ingestor MUST be registered below the gateway's auth chain.

The identity worker's routes live under `/v1/auth` and `/v1/me`, not under `/v1/identity`.

A prefix matches on a segment boundary: `/v1/loyalty-admin` is not `/v1/loyalty`. A bare `startsWith` would claim it, and the route the worker serves would be 404 while the answer comes from the wrong file.

#### Scenario: Prefix match

- GIVEN `POST /v1/loyalty/points/assign`
- WHEN matched to `/v1/loyalty`
- THEN forwarded to Growth Worker

#### Scenario: A path that is not a segment boundary

- GIVEN `POST /v1/loyalty-admin/points/assign`
- WHEN matched
- THEN no prefix matches
- AND the gateway answers 404 rather than forwarding to the Growth Worker

#### Scenario: The ingestor path is routed and authenticated

- GIVEN any caller
- WHEN it sends `POST /v1/events/PointsAssigned`
- THEN the gateway routes it to its own ingestor rather than answering 404
- AND without a valid token the answer is 401, and nothing is published to any queue

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

### Requirement: The Venue Routes Are Reachable

The gateway MUST route `/v1/businesses` to the `identity` worker, and
`/v1/businesses` MUST remain in the gateway's route map. The four venue routes
below MUST be reachable through it without the gateway rewriting the path:

| Method | Path | Success |
| --- | --- | --- |
| `GET` | `/v1/businesses/{id}/branches` | `200 { branches, total, business_id }` |
| `POST` | `/v1/businesses/{id}/branches` | `201 { branch }` |
| `PATCH` | `/v1/businesses/{id}/branches/{branchId}` | `200 { branch }` |
| `DELETE` | `/v1/businesses/{id}/branches/{branchId}` | `200 { branch }` |

`DELETE` MUST deactivate the venue rather than remove the row, and the answer
MUST carry the venue with `is_active: false`. A deactivated venue MUST still
appear in the list, because a caller that needs only active venues filters on
the field it was given.

Every venue view MUST carry `latitude` and `longitude` as numbers or `null`,
`geohash` and `geohash_precision` as `null` or their stored values, and
`located_at` as an ISO 8601 string or `null`.

#### Scenario: The list returns positions

- GIVEN a tenant with one located and one unlocated venue
- WHEN it calls `GET /v1/businesses/{id}/branches`
- THEN both venues are returned
- AND the located one carries numbers for `latitude` and `longitude`
- AND the unlocated one carries `null` for both

#### Scenario: Deleting a venue keeps the row

- GIVEN a venue of the tenant
- WHEN it calls `DELETE /v1/businesses/{id}/branches/{branchId}`
- THEN the answer is `200` with `is_active: false`
- AND a later list still contains the venue

### Requirement: The Venue Error Contract

A caller MUST be able to branch on the error code without parsing prose, and the
codes MUST be stable:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | The body is not JSON, a field has the wrong type, or a required field is absent or blank |
| `400` | `BRANCH_LOCATION_INCOMPLETE` | One coordinate arrived without the other |
| `400` | `BRANCH_LOCATION_INVALID` | A coordinate is present but is not a number |
| `400` | `BRANCH_LOCATION_OUT_OF_RANGE` | A coordinate is outside the globe |
| `400` | `BRANCH_LOCATION_INVALID_GEOHASH` | A geohash arrived and is not one |
| `401` | `AUTH_TOKEN_INVALID` | The bearer token is missing, malformed or expired |
| `403` | `OPERATOR_ROLE_REQUIRED` | The subject is a customer or a counter |
| `404` | `NOT_FOUND` | The path names another business, or the venue is not the tenant's |
| `500` | `INTERNAL_ERROR` | The worker cannot reach its configuration or database |

A position MAY arrive as numbers or as numeric strings, because a form sends
strings. An empty string MUST be refused rather than read as `0`: an empty input
silently becoming a position off the coast of Africa is not a rounding detail.

Sending every position field as `null` MUST clear the position. Sending none of
them MUST leave it untouched. Sending `latitude` and `longitude` together MUST
win over a `geohash` in the same body, because the geohash is the derived value.

A `geohash` sent alone MUST be decoded to its cell centre and re-encoded at the
precision the string carried, and the stored coordinates MUST be that pair. The
row MUST never carry a geohash the server did not compute.

#### Scenario: A form sends strings

- GIVEN a create request whose `latitude` and `longitude` are numeric strings
- WHEN the venue is created
- THEN the answer is `201`
- AND the stored position matches those numbers

#### Scenario: An empty coordinate is not zero

- GIVEN a create request whose `latitude` is `""`
- WHEN the venue is created
- THEN the answer is `400 BRANCH_LOCATION_INVALID`
- AND no venue is written

#### Scenario: A partial update leaves the position alone

- GIVEN a located venue
- WHEN a `PATCH` changes only `name`
- THEN the position is unchanged

#### Scenario: Nulls clear the position

- GIVEN a located venue
- WHEN a `PATCH` sends `latitude` and `longitude` as `null`
- THEN the venue is stored with no position

### Requirement: The Venue Surface Is Documented, Not Published

`docs/08-API-Design.md` MUST list the four venue routes and name the coordinate
fields. The published OpenAPI document MUST NOT gain them: it carries only the
counter-subject surface (`/v1/auth/pos/token`, `/v1/loyalty/passes/resolve`,
`/v1/loyalty/checkins`), and a business-facing route added there would change the
documented contract for every integration that reads it.

#### Scenario: The documentation matches the routes

- GIVEN `docs/08-API-Design.md`
- WHEN a reader looks for the venue routes
- THEN all four are listed with their methods and paths

#### Scenario: The published contract does not grow

- GIVEN `api/docs/openapi.yaml`
- WHEN it is read
- THEN it contains no `/v1/businesses` path

### Requirement: Automation Namespace and Health Probe

The gateway MUST keep routing `/v1/automation` to the automation worker, because that namespace is reserved for the workflow management endpoints the automation-engine capability specifies and the dashboard already calls.

The automation worker's `GET /health` MUST be reachable without the gateway's identity headers. The exemption MUST be an exact path match on the raw pathname, checked before the worker's header extraction, and MUST NOT exempt any other path.

#### Scenario: Direct health probe

- GIVEN a request to the automation worker's `GET /health` with no `X-User-Id`, `X-Business-Id` or `X-User-Role` headers
- WHEN the worker handles it
- THEN the response is 200 with `{ "status": "ok", "service": "automation" }`

#### Scenario: The exemption is exact

- GIVEN a request to the automation worker's `GET /health/extra` with no gateway headers
- WHEN the worker handles it
- THEN the request is refused by the header extraction as before

### Requirement: Request Id

The gateway MUST establish one request id per inbound request before any other middleware runs. When the request carries an `X-Request-Id` header matching `^[A-Za-z0-9._-]{8,128}$`, the gateway MUST use it; otherwise it MUST generate a UUID and MUST discard the client's value.

The gateway MUST forward the id to the worker it routes to in the `X-Request-Id` header, replacing any value the client sent, and MUST set `X-Request-Id` on every response it returns, including error responses and responses produced by a worker.

Every error body the gateway produces — `onError`, `notFound`, the router's `NOT_FOUND`, `SERVICE_UNAVAILABLE` and `SERVICE_ERROR`, the events ingestor while that route exists, and the support endpoint — MUST carry the request's id in `error.request_id`, and MUST NOT generate a second id. Every gateway log line on an error path MUST include `request_id=<id>`.

An event the ingestor publishes MUST carry the request's id in `header.request_id`, overwriting any value the client put there.

#### Scenario: The gateway generates an id

- GIVEN a request without `X-Request-Id`
- WHEN it is routed to a worker
- THEN the worker receives an `X-Request-Id` that is a UUID
- AND the response carries the same value in `X-Request-Id`

#### Scenario: A well-formed client id is kept

- GIVEN a request with `X-Request-Id: web-7f3a9c2e`
- WHEN it is routed
- THEN the worker receives `X-Request-Id: web-7f3a9c2e`
- AND the response carries `X-Request-Id: web-7f3a9c2e`

#### Scenario: A malformed client id is replaced

- GIVEN a request with `X-Request-Id` containing a space or a newline
- WHEN it is routed
- THEN the worker receives a generated UUID instead
- AND the client's value appears in no log line

#### Scenario: The error body and the log agree

- GIVEN a route that does not exist
- WHEN it is requested
- THEN the `404` body's `error.request_id` equals the `X-Request-Id` response header

#### Scenario: A worker is unreachable

- GIVEN a service binding that throws
- WHEN a request is routed to it
- THEN the `502 SERVICE_ERROR` body carries the request's id
- AND the gateway's log line for it contains `request_id=<that id>`

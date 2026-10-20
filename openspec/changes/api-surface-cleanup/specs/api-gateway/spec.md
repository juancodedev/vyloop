# Delta for api-gateway

## MODIFIED Requirements

### Requirement: Routing

Route by segment, longest prefix first: `/v1/auth`, `/v1/me`, `/v1/businesses`, `/v1/customers`, `/v1/loyalty`, `/v1/growth`, `/v1/analytics`, `/v1/support`, `/v1/automation`, `/v1/communication`, `/v1/compliance`, `/v1/wallet`.

`/v1/events` MUST NOT be in the route map: the event ingestor is retired, and a request under it MUST receive the gateway's 404 for an unrouted `/v1/*` path.

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

#### Scenario: The retired ingestor path

- GIVEN any caller, with or without a token
- WHEN it sends `POST /v1/events/PointsAssigned`
- THEN the gateway answers 404
- AND nothing is published to any queue

## ADDED Requirements

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

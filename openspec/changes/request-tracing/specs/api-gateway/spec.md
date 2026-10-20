# Delta for api-gateway

## ADDED Requirements

### Requirement: Request Id

The gateway MUST establish one request id per inbound request before any other middleware runs. When the request carries an `X-Request-Id` header matching `^[A-Za-z0-9._-]{8,128}$`, the gateway MUST use it; otherwise it MUST generate a UUID and MUST discard the client's value.

The gateway MUST forward the id to the worker it routes to in the `X-Request-Id` header, replacing any value the client sent, and MUST set `X-Request-Id` on every response it returns, including error responses and responses produced by a worker.

Every error body the gateway produces — `onError`, `notFound`, the router's `NOT_FOUND`, `SERVICE_UNAVAILABLE` and `SERVICE_ERROR`, the events ingestor and the support endpoint — MUST carry the request's id in `error.request_id`, and MUST NOT generate a second id. Every gateway log line on an error path MUST include `request_id=<id>`.

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

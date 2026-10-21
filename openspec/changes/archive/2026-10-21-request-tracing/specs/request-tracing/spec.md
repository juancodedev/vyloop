# Delta for request-tracing

## ADDED Requirements

### Requirement: Shared Request Context

A shared package `@vyloop/request-context` MUST export the header name `X-Request-Id`, the validator for a request id (`^[A-Za-z0-9._-]{8,128}$`), a Hono middleware that resolves the id and stores it as `requestId` in the context, and a helper that formats the log prefix `[<service>] request_id=<id>`. The gateway and every worker with an HTTP app MUST use it rather than re-implementing any of these.

#### Scenario: The validator refuses an injection

- GIVEN the value `abc\nrequest_id=forged`
- WHEN it is validated
- THEN it is refused

#### Scenario: The prefix is stable

- GIVEN service `growth` and id `R`
- WHEN the prefix is formatted
- THEN it is `[growth] request_id=R`

### Requirement: Workers Carry the Request Id

Every worker with an HTTP app — analytics, automation, communication, compliance, customer, growth, identity and wallet — MUST resolve the request id from `X-Request-Id` with the shared middleware, generating a UUID when the header is absent or malformed, and MUST echo it in the `X-Request-Id` response header.

Every worker MUST have an `onError` handler. It MUST log the error with the request-id prefix and the method and path, and MUST answer `{ "error": { "code", "message", "request_id" } }`. It MUST NOT log request headers, cookies, query strings or bodies.

#### Scenario: A 500 born in a worker is traceable

- GIVEN a growth route that throws
- WHEN it is called through the gateway with request id `R`
- THEN the response body's `error.request_id` is `R`
- AND the growth worker's log line starts with `[growth] request_id=R`

#### Scenario: A worker called directly

- GIVEN a service-binding call without `X-Request-Id`
- WHEN the worker handles it and fails
- THEN its log line and its error body carry the same generated id

#### Scenario: No secrets in the error log

- GIVEN a request with an `Authorization` header and a JSON body
- WHEN the worker's `onError` logs it
- THEN the log line contains neither the token nor the body

### Requirement: Asynchronous Work Carries the Request Id

An event produced while handling a request MUST carry that request's id in `header.request_id`. A queue handler MUST log with the request-id prefix when the event carries one, and SHOULD include the event's `id`. An event produced outside a request (a cron, a sweep) MUST omit `header.request_id` rather than invent one.

Calls between workers made on behalf of a request (the growth → wallet projection, the automation → communication sweep) SHOULD pass the request id when one exists.

#### Scenario: A delivery is traced back to its request

- GIVEN a campaign composed with request id `R`
- WHEN the communication worker consumes the resulting `PushCampaignRequested`
- THEN its log lines for that event contain `request_id=R`

#### Scenario: A cron event has no request id

- GIVEN an event produced by the automation cron
- WHEN it is published
- THEN its header has no `request_id`

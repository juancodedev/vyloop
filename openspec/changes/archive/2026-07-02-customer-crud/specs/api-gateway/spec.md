# Delta for API Gateway

## ADDED Requirements

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

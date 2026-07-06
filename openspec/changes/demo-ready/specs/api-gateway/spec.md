# Delta for API Gateway

## MODIFIED Requirements

### Requirement: Auth

Gateway MUST validate JWT and X-Business-ID before forwarding. The route `POST /v1/auth/customer/token` is exempted from JWT validation (public endpoint).

(Previously: All routes required JWT validation.)

#### Scenario: Public auth route — no JWT required

- GIVEN `POST /v1/auth/customer/token`
- WHEN no `Authorization` header
- THEN request is forwarded (no 401)

#### Scenario: No auth on protected endpoint

- GIVEN no `Authorization` header
- WHEN any other endpoint is called
- THEN 401 `AUTH_TOKEN_INVALID`

### Requirement: Auth Header Injection

The gateway MUST inject `X-User-Id`, `X-Business-Id`, and `X-User-Role` headers from decoded JWT claims before forwarding requests to service bindings. The gateway SHOULD strip these headers from incoming requests before processing to prevent header spoofing. When `role` is `"customer"`, `X-User-Role` MUST be set to `"customer"` and all standard injection rules apply.

(Previously: Only admin/business roles were considered.)

#### Scenario: Customer role headers

- GIVEN a valid customer JWT with `sub`, `business_id`, `role: "customer"`
- WHEN the gateway forwards a request
- THEN `X-User-Id`, `X-Business-Id`, and `X-User-Role: "customer"` are injected

#### Scenario: Header spoofing prevented (unchanged)

- GIVEN an incoming request with `X-User-Id` already set
- WHEN the gateway processes it
- THEN the incoming header is stripped before JWT-based injection

#### Scenario: Missing JWT claim (unchanged)

- GIVEN a valid JWT missing `business_id`
- WHEN the gateway attempts to inject headers
- THEN the header is omitted or set to empty
- AND the request still forwarded (worker enforces RLS)

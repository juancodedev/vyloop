# Multi-Tenant IAM Specification

## Purpose

OAuth 2.0 + OIDC, scoped JWT, X-Business-ID enforcement.

## Requirements

### Requirement: OAuth 2.0 + OIDC

System MUST issue signed JWT via OAuth 2.0 flows.

#### Scenario: Login
- GIVEN valid tenant credentials
- WHEN `POST /v1/auth/token`
- THEN JWT returned with `sub`, `business_id`, `role`, `scopes`

### Requirement: Scopes

JWT scopes: `read:customers`, `write:customers`, `write:loyalty`, `read:analytics`, `admin:billing`, `admin:webhooks`. API Keys MAY share.

#### Scenario: Write denied
- GIVEN JWT with only `read:customers`
- WHEN `POST /v1/customers`
- THEN 403

### Requirement: X-Business-ID

Every request MUST carry `X-Business-ID`. Mismatch → 403 `AUTH_BUSINESS_MISMATCH`.

#### Scenario: Mismatch
- GIVEN JWT for `business_id = A`
- WHEN `X-Business-ID: B`
- THEN 403

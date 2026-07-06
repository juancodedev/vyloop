# Customer Self-Service Specification

## Purpose

Customer-facing self-service capability — authenticated customers view their own profile and transaction history via the customer-web PWA, backed by real API data (not placeholders).

## Requirements

### Requirement: Self-Profile Access

An authenticated customer MUST be able to access their own profile via `GET /v1/customers/me` without knowing their internal `customer_id`. Identity MUST be resolved from the JWT `globalId` propagated through gateway headers.

#### Scenario: Customer views own profile

- GIVEN customer is logged in with a valid JWT
- WHEN customer-web calls `GET /v1/customers/me`
- THEN profile returned with points balance, tier, and recent events
- AND no other customer's data is exposed

#### Scenario: JWT expired

- GIVEN customer's JWT has expired
- WHEN customer-web calls `GET /v1/customers/me`
- THEN 401 returned
- AND customer-web redirects to `/login`

### Requirement: Self-Transaction History

An authenticated customer MUST be able to view their own transaction history via `GET /v1/loyalty/points/transactions?customer_id={self}`. The `customer_id` MUST be the customer's own `globalId` from the JWT. Cross-customer access MUST be prevented.

#### Scenario: Customer views own history

- GIVEN customer A is authenticated
- WHEN customer-web fetches transactions with `customer_id=A`
- THEN only customer A's transactions returned

#### Scenario: Tampered customer_id rejected

- GIVEN customer A is authenticated (globalId = A)
- WHEN customer-web sends `customer_id=B`
- THEN gateway or worker MUST reject with 403

# Delta for Customer CRUD

## ADDED Requirements

### Requirement: Customer Self-Profile Endpoint

`GET /v1/customers/me` MUST return the authenticated customer's profile, current points balance, current tier, and last 10 point transaction events. The route MUST read the customer `globalId` from the `X-User-Id` header (injected by the API gateway from the customer JWT). The route MUST be registered **before** `/:id` to avoid Hono path-param conflicts.

The response MUST include: `id`, `global_id`, `full_name`, `phone`, `email`, `points_balance`, `current_tier` (name + multiplier), and `recent_events` (last 10 `points_transactions` ordered by `created_at DESC`).

#### Scenario: Authenticated customer fetches profile

- GIVEN a customer with `globalId` in a valid JWT
- WHEN `GET /v1/customers/me` with gateway-injected `X-User-Id` header
- THEN 200 with profile, balance, tier, and last 10 events

#### Scenario: Missing auth header

- GIVEN no `X-User-Id` header present
- WHEN `GET /v1/customers/me`
- THEN 401 Unauthorized

#### Scenario: Customer not found

- GIVEN `X-User-Id` contains a `globalId` with no matching customer row
- WHEN `GET /v1/customers/me`
- THEN 404 Not Found

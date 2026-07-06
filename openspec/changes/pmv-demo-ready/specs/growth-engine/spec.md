# Delta for Growth Engine

## ADDED Requirements

### Requirement: Points Transaction History Endpoint

`GET /v1/loyalty/points/transactions` MUST return a paginated list of `points_transactions` for the current business. The endpoint MUST support optional query parameters: `customer_id` (filter to one customer) and `type` (filter by `earn` or `redeem`). Results MUST be ordered by `created_at DESC`. Default page size MUST be 20.

Each entry MUST include: `id`, `customer_id`, `points` (signed: positive for earn, negative for redeem), `type`, `reference_id`, and `created_at`.

The endpoint MUST be scoped by `business_id` from the `X-Business-ID` gateway header.

#### Scenario: Fetch all transactions

- GIVEN a business with 15 transactions
- WHEN `GET /v1/loyalty/points/transactions`
- THEN 15 transactions returned, newest first

#### Scenario: Filter by customer

- GIVEN customer A has 5 tx and customer B has 10 tx
- WHEN `GET /v1/loyalty/points/transactions?customer_id=A`
- THEN only customer A's 5 transactions returned

#### Scenario: Filter by type

- GIVEN mixed earn and redeem transactions
- WHEN `GET /v1/loyalty/points/transactions?type=earn`
- THEN only earn-type transactions returned

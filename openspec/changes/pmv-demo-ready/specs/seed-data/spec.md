# Seed Data Specification

## Purpose

Standalone demo seeding script that populates a Neon branch with realistic loyalty data for demo and testing.

## Requirements

### Requirement: Tier Seeding

The script MUST create exactly 3 membership tiers: Bronce (`min_points: 0`, `multiplier: 1.0`), Plata (`min_points: 500`, `multiplier: 1.5`), Oro (`min_points: 1000`, `multiplier: 2.0`). Each tier MUST have a `display_order` and sample `benefits` JSON.

#### Scenario: Fresh branch seeded

- GIVEN an empty Neon branch with no tiers
- WHEN seed script runs
- THEN 3 tiers created with correct multipliers and ordering

### Requirement: Reward Seeding

The script MUST create between 3 and 5 rewards with varying `pointsCost` (100–1000), `stock` > 0, and descriptive names.

#### Scenario: Rewards available

- GIVEN seed script completed
- WHEN `GET /v1/loyalty/rewards`
- THEN 3–5 active rewards returned

### Requirement: Customer Seeding

The script MUST create exactly 3 test customers with wallets initialized and assigned to different tiers.

#### Scenario: Customers with wallets

- GIVEN seed script completed
- WHEN listing customers
- THEN 3 customers with points balances and tier assignments

### Requirement: Transaction Seeding

The script MUST create approximately 5 historical `points_transactions` — a mix of earn and redeem types — distributed across the 3 seeded customers.

#### Scenario: History populated

- GIVEN seed script completed
- WHEN fetching transactions for any seeded customer
- THEN at least 1 transaction exists per customer

### Requirement: Idempotency and Targeting

The script MUST accept a `branch_id` parameter to target a specific Neon branch. The script MUST be idempotent — re-running MUST NOT create duplicate rows.

#### Scenario: Re-run safety

- GIVEN seed script already ran once
- WHEN run again on same branch
- THEN no duplicate data created

#### Scenario: Wrong branch protection

- GIVEN `branch_id` points to production
- WHEN operator runs seed script
- THEN script SHOULD warn or require explicit confirmation

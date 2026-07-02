# Growth Engine Specification

## Purpose

Loyalty points engine — earn rate configuration, membership tiers, points assignment, reward redemption, and event-driven wallet initialization with tier evaluation.

## Requirements

### Requirement: Points Assignment

`POST /v1/loyalty/points/assign` MUST accept `{ customer_id, points, branch_id?, note?, reference_id }` and create a points transaction. Balance MUST increment by `points * earnRate * tierMultiplier`. The endpoint MUST publish a `PointsAssigned` event to `DOMAIN_EVENTS_QUEUE`. The `reference_id` MUST be unique per customer — duplicate `reference_id` MUST return `409 DUPLICATE_REFERENCE`.

#### Scenario: Regular assign
- GIVEN a customer in Bronze tier (multiplier 1.0) with earnRate 1.0
- WHEN `POST /v1/loyalty/points/assign` with `points: 100`
- THEN balance increases by 100, `PointsAssigned` published with `points_assigned: 100`

#### Scenario: Duplicate reference
- GIVEN a transaction with `reference_id: "tx-1"` already exists
- WHEN a second request with `reference_id: "tx-1"` arrives
- THEN `409 DUPLICATE_REFERENCE` returned

#### Scenario: Tier multiplier applied
- GIVEN a customer in Gold tier (multiplier 2.0) with earnRate 1.0
- WHEN `POST /v1/loyalty/points/assign` with `points: 50`
- THEN balance increases by 100 (50 × 1.0 × 2.0)

### Requirement: Reward Redemption

`POST /v1/loyalty/rewards/redeem` MUST accept `{ customer_id, points, reward_name?, partial?, reference_id }`. When `points` ≤ balance, the full amount MUST be deducted. When `points` > balance and `partial` is `true`, all available points MUST be consumed and the response MUST indicate partial fulfillment. When `points` > balance and `partial` is `false`, the endpoint MUST return `409 INSUFFICIENT_BALANCE`. A `RewardRedeemed` event MUST be published on success. Duplicate `reference_id` MUST return `409 DUPLICATE_REFERENCE`.

#### Scenario: Full redemption
- GIVEN a customer with 500 points
- WHEN redeem with `points: 200`
- THEN balance becomes 300, `RewardRedeemed` published with `points_redeemed: 200`

#### Scenario: Partial redemption
- GIVEN a customer with 100 points
- WHEN redeem with `points: 300, partial: true`
- THEN balance becomes 0, response indicates partial (100 of 300 fulfilled)

#### Scenario: Insufficient balance without partial
- GIVEN a customer with 50 points
- WHEN redeem with `points: 100, partial: false`
- THEN `409 INSUFFICIENT_BALANCE`

### Requirement: Tier CRUD

`GET /v1/loyalty/tiers`, `POST /v1/loyalty/tiers`, `PUT /v1/loyalty/tiers/{id}`, `DELETE /v1/loyalty/tiers/{id}` MUST manage `membership_tiers` per `business_id`. Fields: `name`, `min_points`, `multiplier`, `benefits` (JSON), `display_order`. A tier MAY be deleted only if no customers are assigned. The lowest tier (min_points = 0) MUST exist at all times.

#### Scenario: Create tier
- GIVEN a business with Bronze tier (min_points=0)
- WHEN `POST /v1/loyalty/tiers` with Silver (min_points=500, multiplier=1.5)
- THEN tier created, scoped to business

#### Scenario: Delete assigned tier
- GIVEN a tier with active customers
- WHEN `DELETE /v1/loyalty/tiers/{id}`
- THEN `409 TIER_HAS_CUSTOMERS`

### Requirement: Wallet Initialization

The Growth Worker `queue()` handler MUST consume `CustomerRegistered` events. On receipt, the handler MUST find the loyalty program's lowest tier (min_points = 0). If none exists, it MUST create a Bronze tier (multiplier 1.0). It MUST upsert a `points_transactions` record for the customer with zero balance and assign the tier.

#### Scenario: Tier exists
- GIVEN a business with Bronze tier (min_points=0)
- WHEN `CustomerRegistered` consumed
- THEN customer assigned to Bronze, balance initialized to 0

#### Scenario: No tier exists
- GIVEN a business with no membership tiers
- WHEN `CustomerRegistered` consumed
- THEN Bronze tier created with multiplier 1.0, customer assigned

#### Scenario: Idempotent registration
- GIVEN customer already has a wallet
- WHEN duplicate `CustomerRegistered` consumed
- THEN no-op (upsert finds existing record)

### Requirement: Tier Upgrade Evaluation

The `queue()` handler MUST consume `PointsAssigned` events. After processing, it MUST read the customer's total balance, find the highest tier whose `min_points` ≤ balance, and if different from current tier, update `current_tier_id`. Downgrade MUST never occur.

#### Scenario: Upgrade triggered
- GIVEN customer in Bronze, 600 points, Silver tier at min_points=500
- WHEN `PointsAssigned` consumed
- THEN customer upgraded to Silver

#### Scenario: No upgrade needed
- GIVEN customer in Gold, 500 points, Silver requires 500
- WHEN `PointsAssigned` consumed
- THEN tier unchanged (downgrade never occurs)

### Requirement: FIFO Ordering

Queue consumer MUST set `max_concurrency` per `customer_id` to 1. Events for different customers MUST process in parallel.

#### Scenario: Sequential per customer
- GIVEN two events for same customer queued
- WHEN consumer picks first event
- THEN second waits until first completes

### Requirement: Loyalty Program Config

`GET /v1/loyalty/config` and `PUT /v1/loyalty/config` MUST manage `earn_rate` (decimal) and `program_name` per `business_id`. Default `earn_rate` MUST be 1.0.

#### Scenario: Fetch config
- GIVEN a business with earnRate 2.0
- WHEN `GET /v1/loyalty/config`
- THEN `{ earn_rate: 2.0, program_name: "..." }` returned

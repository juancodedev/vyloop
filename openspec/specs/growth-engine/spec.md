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

### Requirement: Reward Venue Scope

`POST /v1/loyalty/rewards` and `PUT /v1/loyalty/rewards/:id` MUST accept an optional `branch_ids` array. Every id MUST name a branch of the caller's business; otherwise the request MUST be refused with `422 VALIDATION_ERROR` and nothing MUST be written. An empty array, or omitting the field on create, MUST mean the reward is available at every venue. On update, omitting the field MUST leave the scope unchanged, and an array MUST replace it.

`GET /v1/loyalty/rewards` and `GET /v1/loyalty/rewards/:id` MUST return `branch_ids` for every reward, as an empty array when the reward is available everywhere.

#### Scenario: A reward is scoped to two venues

- GIVEN a business with venues A, B and C
- WHEN a reward is created with `branch_ids` `[A, B]`
- THEN the reward is returned with `branch_ids` `[A, B]`

#### Scenario: A venue of another business is refused

- GIVEN a venue that belongs to another business
- WHEN a reward is created naming it in `branch_ids`
- THEN `422 VALIDATION_ERROR`
- AND no reward is created

#### Scenario: An update without the field keeps the scope

- GIVEN a reward scoped to venue A
- WHEN it is updated with a new name and no `branch_ids`
- THEN it is still scoped to venue A

### Requirement: Publish RewardAvailableAtBranch on a Scoped Auto-Grant

When the auto-grant in `handlePointsAssigned` grants a reward that has at least one `reward_branches` row, the growth worker MUST publish one `RewardAvailableAtBranch` event to the delivery queue after the `reward_grants` row is written, carrying the customer's global id, the reward id and name, the grant id and the reward's venue ids. `RewardAutoGranted` MUST still be published as today.

A grant of a reward with no venue scope MUST NOT publish `RewardAvailableAtBranch`. A grant skipped because the customer already holds the reward MUST NOT publish it.

Only the customer the reward was granted to is notified (Q1, answered 2026-10-20). A broadcast to a venue's audience is a campaign and MUST NOT be produced here.

#### Scenario: A scoped reward is granted

- GIVEN a reward scoped to venue A with `auto_grant_threshold` 100
- AND a customer whose balance reaches 100
- WHEN `PointsAssigned` is handled
- THEN a `reward_grants` row is written
- AND one `RewardAvailableAtBranch` event is published to the delivery queue naming venue A and the grant
- AND `RewardAutoGranted` is published to the domain events queue

#### Scenario: An unscoped reward is granted

- GIVEN a reward with no venue scope
- WHEN it is auto-granted
- THEN no `RewardAvailableAtBranch` event is published

#### Scenario: The reward was already granted

- GIVEN a customer who already holds the reward
- WHEN `PointsAssigned` is handled again
- THEN no event is published for that reward

### Requirement: Purchase Amount Is Recorded on Earn

When a program earns by purchase, the earn endpoint MUST store the received
`amount_pesos` in `points_transactions.purchase_amount` in the same insert that
records the points. Visit programs MUST store `NULL`. The transactions listing
(`GET /v1/loyalty/points/transactions`) MUST return it as `purchase_amount`.

#### Scenario: Purchase program

- GIVEN a program with `earn_by = 'purchase'`
- WHEN a merchant posts an earn with `amount_pesos = 11400`
- THEN the new `points_transactions` row has `purchase_amount = 11400`
- AND the response and the `PointsAssigned` event are otherwise unchanged

#### Scenario: Visit program

- GIVEN a program with `earn_by = 'visit'`
- WHEN a merchant posts an earn with `points = 1`
- THEN the new row has `purchase_amount = NULL`

#### Scenario: Redemption

- WHEN a reward is redeemed
- THEN the redeem row has `purchase_amount = NULL`

#### Scenario: Idempotent retry

- GIVEN an earn already recorded with `reference_id = "pos-123"`
- WHEN the same request is retried
- THEN no second row is written and the stored amount is unchanged

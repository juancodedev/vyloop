# Delta for customer-crud

## ADDED Requirements

### Requirement: Customer Self Profile Rewards and Purchases

`GET /v1/customers/me` MUST additionally return `nextReward`,
`affordableReward`, `affordableRewardsCount` and `activeRewardsCount`, derived
server-side from the tenant's active rewards and the customer's balance. Each
item in `recent_transactions` MUST include `purchaseAmount` (number or `null`).
All existing fields MUST keep their current names and types.

A reward is active when `deleted_at IS NULL`, `valid_from` is null or in the
past, `valid_until` is null or in the future, and `stock` is null or greater
than 0.

#### Scenario: Next reward is the cheapest unaffordable one

- GIVEN balance 30 and active rewards costing 100 ("Burger gratis"), 250 and 20 ("Papas medianas")
- WHEN the customer calls `GET /v1/customers/me`
- THEN `nextReward = { name: "Burger gratis", pointsCost: 100, pointsMissing: 70 }`
- AND `affordableReward.name = "Papas medianas"`, `affordableRewardsCount = 1`, `activeRewardsCount = 3`

#### Scenario: Ties are broken by name

- GIVEN two unaffordable rewards both costing 100, "B" and "A"
- WHEN the profile is read
- THEN `nextReward.name = "A"`

#### Scenario: Sold out and expired rewards are skipped

- GIVEN a reward with `stock = 0` and another with `valid_until` in the past
- WHEN the profile is read
- THEN neither is `nextReward`, `affordableReward` or counted in `activeRewardsCount`

#### Scenario: Other tenants' rewards are invisible

- GIVEN a cheaper reward in another business
- WHEN the profile is read
- THEN it is never returned

#### Scenario: No rewards

- GIVEN the tenant has no active rewards
- WHEN the profile is read
- THEN `nextReward = null`, `affordableReward = null`, both counts are 0

### Requirement: Customer Self Update

The customer worker MUST expose `PATCH /v1/customers/me`, accepting only
`fullName`, `email` and `birthDate`. The customer MUST be resolved from
`X-User-Id` and `X-Business-Id`, never from a path or body id. The gateway MUST
require the customer-token scope `profile:write`.

#### Scenario: Update email

- GIVEN a customer token with `profile:write`
- WHEN it sends `{ "email": "nuevo@example.com" }`
- THEN the response is 200 with the updated profile fields
- AND `customer.profile_updated` is published

#### Scenario: Phone cannot be changed

- WHEN the body contains `phone`
- THEN the response is 400 `VALIDATION_ERROR` and nothing is written

#### Scenario: Missing scope

- GIVEN a customer token with only `rewards:read` and `rewards:redeem`
- WHEN it calls `PATCH /v1/customers/me`
- THEN the gateway answers 403

#### Scenario: Cross-tenant isolation

- GIVEN the same `globalId` exists in two businesses
- WHEN the customer updates their profile through business A
- THEN the row in business B is unchanged

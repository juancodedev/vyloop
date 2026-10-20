# Delta for growth-engine

## ADDED Requirements

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

Assumption (open question Q1): only the customer the reward was granted to is notified.

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

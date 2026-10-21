# Delta for database

## ADDED Requirements

### Requirement: Reward Branches

The database MUST hold a `reward_branches` table with `reward_id` (FK to `rewards`, `ON DELETE CASCADE`), `branch_id` (FK to `branches`, `ON DELETE CASCADE`), `business_id` (FK to `tenants`, `ON DELETE CASCADE`) and `created_at`, with a primary key on `(reward_id, branch_id)` and an index `idx_reward_branches_branch` on `(business_id, branch_id)`.

A reward with no `reward_branches` rows MUST mean the reward is available at every venue of the business. The migration MUST NOT insert rows for existing rewards.

`reward_branches` MUST be listed in `BUSINESS_ID_TABLES` so it receives the tenant isolation policy.

#### Scenario: Existing rewards keep their meaning

- GIVEN rewards created before the migration
- WHEN the migration is applied
- THEN no `reward_branches` rows exist for them
- AND they are available at every venue

#### Scenario: A venue is removed

- GIVEN a reward scoped to venues A and B
- WHEN venue A is deleted
- THEN the reward remains scoped to venue B only

#### Scenario: The table is tenant-scoped

- GIVEN the list of business-scoped tables
- WHEN it is read
- THEN it includes `reward_branches`

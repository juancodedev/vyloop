# Delta for database

## ADDED Requirements

### Requirement: Message Log Delivery Key

`message_log` MUST hold a nullable `delivery_key text` and a nullable `claimed_until timestamptz`. A partial unique index named `uq_message_log_delivery_key` MUST exist on `(business_id, delivery_key) WHERE delivery_key IS NOT NULL`.

Rows written before the column existed MUST keep a `NULL` key and MUST NOT be rewritten by the migration. The index MUST be created `CONCURRENTLY`, because `message_log` is written on every delivery.

#### Scenario: A duplicate key is refused by the database

- GIVEN a row with `business_id` B and `delivery_key` `R:S`
- WHEN another row with the same pair is inserted
- THEN the insert conflicts
- AND `ON CONFLICT DO NOTHING` returns no row

#### Scenario: Rows without a key never conflict

- GIVEN any number of rows with `delivery_key` `NULL`
- WHEN another row with `delivery_key` `NULL` is inserted
- THEN it is inserted

#### Scenario: The migration is registered with its evidence

- GIVEN the migration that adds the columns and the index
- WHEN the drift gate runs against a database where it was applied by hand
- THEN the entry in `_applied-outside-drizzle.json` names the two columns and `uq_message_log_delivery_key` as evidence
- AND the gate passes

### Requirement: Push Campaigns

The database MUST hold one `push_campaigns` row per composed campaign, with `business_id`, `reference_id`, the title, body and url, the target as `jsonb`, a `status` and `created_at`. A unique constraint named `uq_push_campaigns_business_reference` MUST exist on `(business_id, reference_id)`.

`push_campaigns` MUST be listed in `BUSINESS_ID_TABLES` so it receives the tenant isolation policy.

#### Scenario: One campaign per reference and business

- GIVEN a campaign `promo-1` for business A
- WHEN another `promo-1` for business A is inserted
- THEN the insert conflicts

#### Scenario: The table is tenant-scoped

- GIVEN the list of business-scoped tables
- WHEN it is read
- THEN it includes `push_campaigns`

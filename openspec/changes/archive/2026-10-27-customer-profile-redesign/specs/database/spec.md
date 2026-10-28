# Delta for database

## ADDED Requirements

### Requirement: Purchase Amount Column

`points_transactions` MUST have a nullable column
`purchase_amount numeric(12,2)`, added by an additive migration with no
backfill and no default. The column MUST be registered in the Drizzle schema
(`packages/db/src/schema.ts`) and the migration journal, and the drift
baseline MUST be regenerated.

#### Scenario: Existing rows

- GIVEN `points_transactions` rows written before the migration
- WHEN the migration runs
- THEN those rows have `purchase_amount = NULL` and no other column changes

#### Scenario: Negative amount rejected

- WHEN a row is inserted with `purchase_amount = -1`
- THEN a `CHECK (purchase_amount IS NULL OR purchase_amount > 0)` constraint rejects it

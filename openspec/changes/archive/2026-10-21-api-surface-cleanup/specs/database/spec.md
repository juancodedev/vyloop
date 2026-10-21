# Delta for database

## ADDED Requirements

### Requirement: POS Terminals Listing Index

`pos_terminals` MUST have an index `idx_pos_terminals_business` on `(business_id, created_at DESC)`, serving the merchant listing `GET /v1/loyalty/terminals`, which filters by `business_id` and orders by `created_at` descending.

The index MUST be declared in the table's extra-config callback in `packages/db/src/schema.ts`, registered in `INDEXED_TABLES` and `INDEX_NAMES` with a named export in `packages/db/src/indexes.ts`, re-exported from `packages/db/src/index.ts`, and paired binding-to-name in `packages/db/src/index.test.ts`. The production migration MUST be applied by hand and registered in `packages/db/drizzle/meta/_applied-outside-drizzle.json` with the index as evidence.

#### Scenario: The listing uses the index

- GIVEN `pos_terminals` with rows for several businesses
- WHEN `EXPLAIN` is run for `SELECT … FROM pos_terminals WHERE business_id = $1 ORDER BY created_at DESC`
- THEN the plan can use `idx_pos_terminals_business` for both the filter and the order

#### Scenario: The registry agrees with the migrations

- GIVEN the index is declared in the schema
- WHEN `packages/db` tests run
- THEN the set of `CREATE INDEX` statements across the migration history equals the set `allIndexes` reports
- AND `idxPosTerminalsBusiness` resolves to `idx_pos_terminals_business`

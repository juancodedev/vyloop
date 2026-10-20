# Delta for database

## ADDED Requirements

### Requirement: message_log Matches Its Declaration

Production's `message_log` MUST have exactly the columns declared for it in `packages/db/src/schema.ts`, with the declared types, nullability and defaults: `customer_id` NOT NULL, `channel` default `'whatsapp'`, `status` default `'queued'`, `created_at` of type `timestamptz`, and no `payload` or `error` column.

The aligning migration MUST state in its header a read-only pre-flight query that returns zero rows violating the new shape (null `customer_id`, non-null `payload`, non-null `error`), and MUST NOT be applied unless it does. The `created_at` conversion MUST interpret existing values as UTC.

#### Scenario: An insert relies on the declared defaults

- GIVEN the aligned `message_log`
- WHEN a row is inserted without `channel` or `status`
- THEN the row has `channel = 'whatsapp'` and `status = 'queued'`

#### Scenario: A row without a customer is refused

- GIVEN the aligned `message_log`
- WHEN a row is inserted with a null `customer_id`
- THEN the insert fails on the NOT NULL constraint

#### Scenario: Stored instants survive the type change

- GIVEN a row whose `created_at` was `2026-10-20 12:00:00` written in UTC
- WHEN the column is converted to `timestamptz`
- THEN the value is `2026-10-20 12:00:00+00`

#### Scenario: The pre-flight blocks a lossy drop

- GIVEN a `message_log` row whose `payload` is not null
- WHEN the pre-flight query runs
- THEN it reports one row with a payload
- AND the migration is not applied

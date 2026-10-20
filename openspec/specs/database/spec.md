# Database Specification

## Purpose

PostgreSQL for 7 domains: RLS, indexes, Drizzle migrations.

## Requirements

### Requirement: Schema

Tables from v2.0 Database Design across all domains.

#### Scenario: Migration

- GIVEN a fresh Neon database
- WHEN `pnpm db:migrate` runs
- THEN 25 tables exist with FK + constraints. Re-run idempotent.

### Requirement: RLS

Every `business_id` table MUST enable RLS via `app.current_business_id`. The `consents` table MUST be part of that set: it is the authoritative store for a customer's consent, so a cross-tenant read of it is a disclosure of what a customer agreed to.

#### Scenario: Isolation

- GIVEN user for tenant A
- WHEN querying `customers`
- THEN only matching rows visible

#### Scenario: Consents are tenant-scoped

- GIVEN a consent recorded for tenant A
- WHEN tenant B queries `consents` for the same customer
- THEN no row is visible

### Requirement: Indexes

Partial indexes on `phone`, `last_visit_at`, `points_transactions`. GIN on `customers.metadata`. A unique index on `consents` over `(business_id, customer_id, consent_type)`, and one on `branches` over `geohash`.

The consent index is what makes "one row per customer per consent type" a property of the database rather than a convention every writer has to remember. The geohash index is what makes the nearby-venues lookup a bounded read instead of a scan of every branch in the system.

#### Scenario: Phone scan

- GIVEN `idx_customers_phone`
- WHEN filtering `business_id + phone`
- THEN index scan, no seq scan

#### Scenario: A consent is written twice

- GIVEN a consent recorded for `(business, customer, 'whatsapp')`
- WHEN another row for the same triple is written
- THEN the write is rejected by the unique constraint

### Requirement: Consent Uniqueness

The `consents` table MUST enforce at most one row per `(business_id, customer_id, consent_type)`. The uniqueness MUST be a database constraint, not a convention in application code, because the table is written by more than one path.

A consent MUST NOT be deleted to revoke it. A revocation MUST set `granted = false` and `revoked_at` to the moment of revocation, keeping `granted_at` as the moment of the grant. The audit trail is the reason the table carries those three columns.

#### Scenario: The same consent is granted twice

- GIVEN a customer with `consent_type = 'whatsapp'` already granted
- WHEN the same consent is granted again
- THEN the row is updated rather than duplicated
- AND `granted_at` records the moment the current agreement began

#### Scenario: A consent is revoked

- GIVEN a customer with a granted `whatsapp` consent
- WHEN that consent is revoked
- THEN the row persists with `granted = false`
- AND `revoked_at` records the moment of revocation
- AND `granted_at` still records the original grant

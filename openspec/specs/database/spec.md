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

### Requirement: Push Subscriptions

The database MUST hold one row per browser registration, with the endpoint the push service accepts a delivery on, the browser's public key (`p256dh`) and its auth secret (`auth`). A registration MUST belong to a `business_id` and a `customer_id`.

The endpoint MUST be unique across the table. A browser rotates its keys for the same endpoint, so registering again is the same registration with newer keys rather than a second one, and a browser that signs out and is used by a different customer MUST move to that customer rather than accumulate a row per customer.

The endpoint MUST NOT be written to `message_log`. It is a capability, and `message_log` is the table most likely to be exported or displayed. The table MUST hold a SHA-256 digest of it in `push_endpoint_hash` instead, which is enough to answer which delivery went to which registration.

#### Scenario: A browser registers

- GIVEN a customer and a browser registration
- WHEN the registration is recorded
- THEN a row exists for that customer with the endpoint, the public key and the auth secret

#### Scenario: The same browser registers again

- GIVEN a registration already recorded for an endpoint
- WHEN that browser registers again with new keys
- THEN the same row is updated with the new keys
- AND no second row is created

#### Scenario: A browser changes hands

- GIVEN a registration belonging to one customer
- WHEN the same browser is registered by another
- THEN the registration belongs to the new customer

#### Scenario: A delivery is recorded

- GIVEN a push message delivered to a browser
- WHEN the delivery is written to `message_log`
- THEN the row holds a digest of the endpoint
- AND the row does not hold the endpoint

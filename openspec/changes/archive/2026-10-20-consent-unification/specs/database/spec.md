# Delta for database

## ADDED Requirements

### Requirement: One Row Per Consent

The `consents` table MUST enforce at most one row per `(business_id, customer_id, consent_type)`. The uniqueness MUST be a database constraint, not a convention in application code, because the table is written by more than one path.

A consent MUST NOT be deleted to revoke it. A revocation MUST set `granted = false` and `revoked_at` to the moment of revocation, keeping `granted_at` as the moment of the original grant. The audit trail is the reason the table carries those three columns.

#### Scenario: The same consent is granted twice

- GIVEN a customer with `consent_type = 'whatsapp'` already granted
- WHEN the same consent is granted again
- THEN the row is updated rather than duplicated
- AND `granted_at` keeps the moment of the original grant

#### Scenario: A consent is revoked

- GIVEN a customer with a granted `whatsapp` consent
- WHEN that consent is revoked
- THEN the row persists with `granted = false`
- AND `revoked_at` records the moment of revocation
- AND `granted_at` still records the original grant

#### Scenario: A second write to the same consent type

- GIVEN a customer with a row for `(business, customer, 'whatsapp')`
- WHEN another row for the same triple is written
- THEN the write is rejected by the unique constraint

## MODIFIED Requirements

### Requirement: RLS

Every `business_id` table MUST enable RLS via `app.current_business_id`. The `consents` table MUST be part of that set, and it is the authoritative store for a customer's consent, so a cross-tenant read of it is a disclosure of what a customer agreed to.

#### Scenario: Isolation

- GIVEN user for tenant A
- WHEN querying `customers`
- THEN only matching rows visible

#### Scenario: Consents are tenant-scoped

- GIVEN a consent recorded for tenant A
- WHEN tenant B queries `consents` for the same customer
- THEN no row is visible

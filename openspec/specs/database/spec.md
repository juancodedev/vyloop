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

### Requirement: A Venue Position

The `branches` table MUST carry a position as five columns: `latitude`
`numeric(9,6)`, `longitude` `numeric(9,6)`, `geohash` `text`, `geohash_precision`
`smallint`, and `located_at` `timestamptz`.

All five MUST be nullable, and `NULL` MUST mean "this venue has not registered a
position". It MUST NOT be represented by a `0,0` default: `0,0` is a real place,
and a default would put every unlocated venue there and make "venues near this
point" return venues that never said where they are.

`latitude` and `longitude` MUST be `numeric(9,6)` and not `double precision`.
Three integer digits and six decimals cover ±180° at roughly 11 cm, and a fixed
decimal has no binary rounding noise in the value a person reads off a map.

#### Scenario: A venue without a position

- GIVEN a venue created without coordinates
- WHEN its row is read
- THEN `latitude`, `longitude`, `geohash`, `geohash_precision` and `located_at` are all `NULL`
- AND the venue is excluded from every nearby-venue query

#### Scenario: A venue with a position

- GIVEN a venue created with `latitude = -33.4489` and `longitude = -70.6693`
- WHEN its row is read
- THEN `latitude` is `-33.448900` and `longitude` is `-70.669300`
- AND `geohash` is the precision-6 encoding of that pair
- AND `geohash_precision` is `6`
- AND `located_at` is the moment of the write

### Requirement: A Position Is a Pair

The database MUST enforce `branches_coordinates_pair_chk`:
`(latitude is null) = (longitude is null)`.

A position with one coordinate is not a position. The constraint MUST live in the
database rather than only in the route, because a check constraint is what
survives a second writer, a script, and a future endpoint that forgets to
validate its input.

#### Scenario: Half a position is refused

- GIVEN a venue whose `latitude` is set and whose `longitude` is `NULL`
- WHEN the row is written
- THEN the write is refused by `branches_coordinates_pair_chk`

#### Scenario: Both coordinates are required to clear a position

- GIVEN a venue with a position
- WHEN a write sets only one of the two coordinates to `NULL`
- THEN the write is refused by `branches_coordinates_pair_chk`

### Requirement: A Position Is on the Globe

The database MUST enforce `branches_coordinates_range_chk`:
`latitude between -90 and 90 and longitude between -180 and 180`.

The constraint MUST be written so a row with no coordinates passes it. A `CHECK`
is satisfied unless it evaluates to `false`, and `NULL BETWEEN …` is unknown, so
the pair constraint owns the "both or neither" question and this one owns the
"is it a place" question. The two MUST NOT have to agree about what `NULL` means.

#### Scenario: A position off the globe is refused

- GIVEN a venue whose `latitude` is `91`
- WHEN the row is written
- THEN the write is refused by `branches_coordinates_range_chk`

#### Scenario: An unlocated venue passes the range check

- GIVEN a venue with both coordinates `NULL`
- WHEN the row is written
- THEN `branches_coordinates_range_chk` is satisfied

### Requirement: The Geohash Is Derived, Never Authoritative

The server MUST compute `geohash` and `geohash_precision` from the coordinates on
every write, and the pair of coordinates MUST be treated as the truth.

There MUST be no trigger keeping the cache in step: a trigger would be a second
place that has to be right, and the write path is already the one place that
cannot be skipped. A stale geohash MUST NOT outlive the write that caused it.

`geohash_precision` MUST be stored, because the cell a geohash denotes depends on
how many characters it has and the string alone does not say how wide its cell is.

#### Scenario: The cache follows the coordinates

- GIVEN a venue positioned at one point
- WHEN its coordinates are corrected to a different point
- THEN `geohash` and `geohash_precision` are recomputed from the new coordinates
- AND no write can set `geohash` to a value that disagrees with them

#### Scenario: Precision is recorded, not inferred

- GIVEN two venues encoded at different precisions
- WHEN both rows are read
- THEN `geohash_precision` reports each venue's own precision

### Requirement: Nearby Venues Are Resolved Through the Geohash Index

`branches` MUST carry `idx_branches_geohash` on `(geohash)`, and the index MUST be
registered in `packages/db/src/indexes.ts` like every other derived index.

The nearby-venue lookup MUST run in two stages: a geohash prefix match in the
database, which is a range scan over that index, and an exact distance filter
afterwards. A distance function over `numeric` columns MUST NOT be asked of the
index, and the lookup MUST NOT be a scan of every branch in the system.

The lookup MUST exclude three things, and each exclusion MUST be a rule rather
than an accident: a branch of another tenant, a branch without a position, and a
branch inside a geohash cell but outside the radius.

#### Scenario: A venue without a position is not nearby

- GIVEN a venue of the tenant with no coordinates
- WHEN the tenant asks for the venues within any radius
- THEN that venue is absent from the result

#### Scenario: Another tenant's venue is never nearby

- GIVEN two tenants with venues at the same coordinates
- WHEN one tenant asks for the venues within a radius
- THEN only its own venues are returned

#### Scenario: A venue in the cell but outside the radius is excluded

- GIVEN a venue inside one of the cells the radius search visits and farther than the radius
- WHEN the tenant asks for the venues within that radius
- THEN the venue is absent from the result

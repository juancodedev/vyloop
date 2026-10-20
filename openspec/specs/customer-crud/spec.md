# Customer CRUD Specification

## Purpose

Customer domain CRUD API — upsert, list, 360° profile, partial update, soft delete, and event-driven registration via `@neondatabase/serverless` + Drizzle.

## Requirements

### Requirement: Upsert Customer

`PUT /v1/customers` MUST upsert by `business_id` + `phone`. On first registration, the system MUST generate a `global_id` (UUID) and publish a `CustomerRegistered` event to `DOMAIN_EVENTS_QUEUE`. On subsequent updates, the system MUST NOT publish the event.

The body MAY carry a `consents` object whose keys are consent types and whose values are booleans. A key that is absent MUST NOT change that consent. A key that is `true` MUST grant it, and a key that is `false` MUST revoke it. The consents MUST be written to the `consents` table, which is the authoritative store, with `granted_at` recorded on a grant and `revoked_at` recorded on a revocation.

The customer and the consents it was registered with MUST be written in the same transaction. Either both land or neither does: a customer who agreed to be contacted and a system that forgot to record it is a customer the business believes it may contact and may not.

A consent type the server does not know MUST be rejected rather than ignored, so that a client sending a typo does not believe it recorded something.

#### Scenario: First-time registration

- GIVEN no customer exists for `business_id` + `phone`
- WHEN `PUT /v1/customers` with valid body
- THEN customer created with `global_id`
- AND `CustomerRegistered` published to queue

#### Scenario: Repeat upsert skips event

- GIVEN an existing customer for `business_id` + `phone`
- WHEN `PUT /v1/customers` with updated fields
- THEN customer updated
- AND no event published

#### Scenario: Consents are recorded on registration

- GIVEN a first-time registration with `{ "consents": { "whatsapp": true } }`
- WHEN the registration completes
- THEN a `consents` row exists for that customer with `consent_type = 'whatsapp'`
- AND `granted = true` and `granted_at` is set

#### Scenario: A consent is revoked

- GIVEN a customer with a granted `whatsapp` consent
- WHEN they register again with `{ "consents": { "whatsapp": false } }`
- THEN the consent row is updated to `granted = false`
- AND `revoked_at` is set

#### Scenario: An absent consent is left alone

- GIVEN a customer with a granted `whatsapp` consent
- WHEN they register again without a `consents` object
- THEN the consent is untouched

#### Scenario: An unknown consent type

- GIVEN a registration with `{ "consents": { "email": true } }`
- WHEN the registration is processed
- THEN the request is rejected as a validation error
- AND no customer and no consent is recorded

### Requirement: List Customers

`GET /v1/customers` MUST return paginated results (`?page`, `?limit`, defaults: page=1, limit=20). `?q=` MUST match `name`, `email`, or `phone` (substring). Soft-deleted customers MUST be excluded.

#### Scenario: Paginated list

- GIVEN 25 customers in the database
- WHEN `GET /v1/customers?page=1&limit=10`
- THEN 10 items returned with total count

#### Scenario: Search by term

- GIVEN customers "Alice" and "Bob"
- WHEN `GET /v1/customers?q=ali`
- THEN only "Alice" returned

#### Scenario: Soft-deleted excluded

- GIVEN a customer with `deleted_at` set
- WHEN `GET /v1/customers`
- THEN that customer is not in results

### Requirement: 360° Profile

`GET /v1/customers/{id}` MUST return customer record, `customer_events`, and `consents`. Results MUST be RLS-scoped by `business_id`.

#### Scenario: Same business

- GIVEN a customer with events and consents
- WHEN fetched from same business
- THEN full profile returned

#### Scenario: Cross-business isolation

- GIVEN customer belongs to business A
- WHEN fetched from business B
- THEN 404 (RLS isolation)

### Requirement: Partial Update

`PATCH /v1/customers/{id}` MUST apply partial updates. Fields not in the body MUST remain unchanged.

#### Scenario: Update single field

- GIVEN customer with `email = "old@example.com"`
- WHEN `PATCH` with `{"email": "new@example.com"}`
- THEN only email updated

### Requirement: Soft Delete

`DELETE /v1/customers/{id}` MUST set `deleted_at` to the current timestamp. The row MUST persist but be excluded from all list queries.

#### Scenario: Delete hides from list

- GIVEN an active customer
- WHEN `DELETE` succeeds
- THEN `deleted_at` is set
- AND customer absent from list results

#### Scenario: Get after soft delete

- GIVEN a soft-deleted customer
- WHEN `GET /v1/customers/{id}`
- THEN 404 returned

### Requirement: Schema Validation

The Worker MUST validate `CustomerRegistered` payloads via `@vyloop/schema-registry` before enqueuing to `DOMAIN_EVENTS_QUEUE`.

#### Scenario: Invalid payload rejected

- GIVEN a payload missing `full_name`
- WHEN Worker validates before publish
- THEN validation error raised
- AND event NOT published

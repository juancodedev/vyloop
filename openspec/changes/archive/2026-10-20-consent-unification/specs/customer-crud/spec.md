# Delta for customer-crud

## MODIFIED Requirements

### Requirement: Upsert Customer

`PUT /v1/customers` MUST upsert by `business_id` + `phone`. On first registration, the system MUST generate a `global_id` (UUID) and publish a `CustomerRegistered` event to `DOMAIN_EVENTS_QUEUE`. On subsequent updates, the system MUST NOT publish the event.

The body MAY carry a `consents` object whose keys are consent types and whose values are booleans. A key that is absent MUST NOT change that consent. A key that is `true` MUST grant it, and a key that is `false` MUST revoke it. The consents MUST be written to the `consents` table, which is the authoritative store, with `granted_at` recorded on a grant and `revoked_at` recorded on a revocation.

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
- AND no consent is recorded

# Delta for Event Bus

## ADDED Requirements

### Requirement: CustomerRegistered Event Type

The event bus MUST register `CustomerRegistered` as a recognized event type string. Producers MUST include the event header with `business_id`, `timestamp`, and `localization` per the existing Event Header requirement.

The event payload MUST contain:
- `customer_id` (uuid) — the customer's `global_id`
- `full_name` (string) — the customer's full name
- `business_id` (uuid) — the business scoping identifier

#### Scenario: Valid CustomerRegistered produced
- GIVEN a producer sends to `DOMAIN_EVENTS_QUEUE`
- WHEN the event type is `CustomerRegistered`
- THEN the payload includes `customer_id`, `full_name`, and `business_id`
- AND the header includes `business_id`, `timestamp`, and `localization`

#### Scenario: Missing required field in event header
- GIVEN a `CustomerRegistered` event without `business_id` in header
- WHEN the bus pre-processes it
- THEN the event is rejected before reaching consumers

(Previously: no CustomerRegistered event type existed)

# Delta for event-bus

## ADDED Requirements

### Requirement: Request Id in the Event Header

The event header MAY carry `request_id`, a string matching `^[A-Za-z0-9._-]{8,128}$`. `createEnvelope` MUST copy it from the header it is given and MUST NOT generate one.

`consume` MUST include the event's `header.request_id`, when present, in the log line it writes for a failed event, alongside the event id.

#### Scenario: The envelope carries the id

- GIVEN a header with `business_id`, `timestamp` and `request_id` `R`
- WHEN `createEnvelope` builds an envelope
- THEN `envelope.header.request_id` is `R`

#### Scenario: A failed event is logged with its request

- GIVEN an event with `header.request_id` `R` whose handler throws
- WHEN `consume` processes it
- THEN the log line contains `request_id=R` and the event id
- AND the message is retried

#### Scenario: No id is invented

- GIVEN a header without `request_id`
- WHEN `createEnvelope` builds an envelope
- THEN the envelope header has no `request_id`

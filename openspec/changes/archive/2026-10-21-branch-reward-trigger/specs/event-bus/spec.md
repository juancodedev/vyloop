# Delta for event-bus

## ADDED Requirements

### Requirement: RewardAvailableAtBranch Event

The event bus MUST register `RewardAvailableAtBranch` as a recognized event type string, exported as `REWARD_AVAILABLE_AT_BRANCH` from `packages/event-bus/src/index.ts`. Producers MUST include the event header with `business_id` and `timestamp` per the existing Event Header requirement.

The event MUST be published to the delivery queue (`vyloop-notification-deliveries`), not to the domain events queue: it is an order to deliver, consumed by the communication worker.

#### Scenario: The constant is exported

- GIVEN the event-bus package
- WHEN `REWARD_AVAILABLE_AT_BRANCH` is imported
- THEN its value is `RewardAvailableAtBranch`

#### Scenario: The event is published to the delivery queue

- GIVEN a scoped reward granted to a customer
- WHEN the growth worker publishes the event
- THEN it is sent to the `DELIVERY_QUEUE` binding
- AND not to `DOMAIN_EVENTS_QUEUE`

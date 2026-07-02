# Delta for event-bus

## ADDED Requirements

### Requirement: PointsAssigned Event Type

The event bus MUST register `POINTS_ASSIGNED` as a recognized event type string. Events MUST carry the standard event header with `business_id`, `timestamp`, and `localization`. The payload MUST contain `customer_id`, `points_assigned`, `points_multiplier`, `total_points`, `reference_id`, and `assignment_id`.

#### Scenario: Valid PointsAssigned produced
- GIVEN a producer sends to `DOMAIN_EVENTS_QUEUE`
- WHEN the event type is `POINTS_ASSIGNED`
- THEN the payload includes `customer_id`, `points_assigned`, `total_points`, `reference_id`, `assignment_id`
- AND the header includes `business_id`, `timestamp`, and `localization`

#### Scenario: Missing required field
- GIVEN a `POINTS_ASSIGNED` event without `customer_id`
- WHEN the bus pre-processes it
- THEN the event is rejected before reaching consumers

### Requirement: RewardRedeemed Event Type

The event bus MUST register `REWARD_REDEEMED` as a recognized event type string. Events MUST carry the standard event header. The payload MUST contain `customer_id`, `points_redeemed`, `total_points_after`, `reward_name` (optional), `partial` (boolean), `reference_id`, and `redemption_id`.

#### Scenario: Valid RewardRedeemed produced
- GIVEN a producer sends to `DOMAIN_EVENTS_QUEUE`
- WHEN the event type is `REWARD_REDEEMED`
- THEN the payload includes `customer_id`, `points_redeemed`, `total_points_after`, `partial`, `reference_id`, `redemption_id`

#### Scenario: Full redemption with reward name
- GIVEN a customer redeeming 200 points for "Gift Card"
- WHEN `REWARD_REDEEMED` produced
- THEN payload includes `reward_name: "Gift Card"`, `partial: false`, `total_points_after` reflects deduction

#### Scenario: Partial redemption
- GIVEN a customer with 100 points requesting 300
- WHEN `REWARD_REDEEMED` produced
- THEN payload includes `partial: true`, `points_redeemed: 100`, `total_points_after: 0`

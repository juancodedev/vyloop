# Delta for Customer Redeem

## MODIFIED Requirements

### Requirement: Confirm Redemption

`POST /v1/loyalty/rewards/redeem` MUST accept `{ customer_id, points, reward_id, reference_id }`. The `customer_id` MUST be derived from the authenticated customer's JWT `globalId` — it MUST NOT come from user input. The `points` value MUST equal the reward's `pointsCost`. The `reference_id` MUST be formatted as `redeem-{customerId}-{rewardId}-{timestamp}`.

On success (201), the UI MUST display a confirmation with reward name and remaining balance. On insufficient balance (409), the UI MUST show "Insufficient points" without deducting.

(Previously: Sent `{rewardId: string}` only — missing `customer_id`, `points`, and `reference_id` fields, causing 400 errors from the growth engine.)

#### Scenario: Successful redeem with correct payload

- GIVEN customer has 500 points and reward costs 200
- WHEN user confirms redemption
- THEN payload sent: `{ customer_id: "<jwt-globalId>", points: 200, reward_id: "<id>", reference_id: "redeem-..." }`
- AND 201 returned, balance becomes 300
- AND confirmation screen shown

#### Scenario: Insufficient balance

- GIVEN customer has 100 points and reward costs 200
- WHEN user confirms redemption
- THEN "Insufficient points" error shown
- AND no points deducted

#### Scenario: Network failure

- GIVEN the redeem endpoint is unreachable
- WHEN user confirms redemption
- THEN error message with retry option shown
- AND no local state mutated

# Delta for growth-engine

## ADDED Requirements

### Requirement: Purchase Amount Is Recorded on Earn

When a program earns by purchase, the earn endpoint MUST store the received
`amount_pesos` in `points_transactions.purchase_amount` in the same insert that
records the points. Visit programs MUST store `NULL`. The transactions listing
(`GET /v1/loyalty/points/transactions`) MUST return it as `purchase_amount`.

#### Scenario: Purchase program

- GIVEN a program with `earn_by = 'purchase'`
- WHEN a merchant posts an earn with `amount_pesos = 11400`
- THEN the new `points_transactions` row has `purchase_amount = 11400`
- AND the response and the `PointsAssigned` event are otherwise unchanged

#### Scenario: Visit program

- GIVEN a program with `earn_by = 'visit'`
- WHEN a merchant posts an earn with `points = 1`
- THEN the new row has `purchase_amount = NULL`

#### Scenario: Redemption

- WHEN a reward is redeemed
- THEN the redeem row has `purchase_amount = NULL`

#### Scenario: Idempotent retry

- GIVEN an earn already recorded with `reference_id = "pos-123"`
- WHEN the same request is retried
- THEN no second row is written and the stored amount is unchanged
